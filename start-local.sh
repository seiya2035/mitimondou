#!/bin/bash
# ============================================================
# 未知問答：予備ローカルを1コマンドで起動する
#
#   使い方（プロジェクトのフォルダで）
#     ./start-local.sh            … 本番（Render）とつないで起動
#     ./start-local.sh practice   … 練習用（Render にはつながない）
#     ./start-local.sh setup      … パスワードと合言葉を Mac のキーチェーンに保存
#     ./start-local.sh forget     … キーチェーンから消す（展示が終わったら）
#
#   ・キーチェーンに保存してあれば、何も聞かれずに起動する
#   ・保存していなければ、起動のたびに貼り付けて入力する
#     （どちらの場合も、画面・ターミナルの履歴・このファイルには残らない）
#   ・サーバーを Control + C で止めると「Enter で再起動」が出る
#     → ファイルを差し替えたあとも、Enter だけで新しいコードで起動し直せる
# ============================================================

SYNC_URL="https://mitimondou.onrender.com"
SQLITE_PATH="data/answers.db"
TOKEN_LENGTH=48   # 合言葉（openssl rand -hex 24 で作ったもの）の文字数

# キーチェーンでの保存名（金庫の中の「引き出しの名札」）
KC_ACCOUNT="mitimondou"
KC_ADMIN="mitimondou-admin-password"
KC_SYNC="mitimondou-sync-token"

# このファイルが置いてあるフォルダ（＝プロジェクト）に移動する
cd "$(dirname "$0")" || exit 1

# キーチェーンから1つ取り出す（なければ空っぽを返す）
kc_get() {
    security find-generic-password -a "$KC_ACCOUNT" -s "$1" -w 2> /dev/null
}

# --- setup：キーチェーンに保存する --------------------------------
if [ "$1" = "setup" ]; then
    if ! command -v security > /dev/null; then
        echo "この PC ではキーチェーンが使えません（Mac 専用です）。"
        exit 1
    fi
    echo "パスワードと合言葉を Mac のキーチェーンに保存します。"
    echo "それぞれ英語で2回聞かれます（2回目は打ち間違い防止の確認）。"
    echo "どちらも貼り付けて Enter。画面には何も表示されません。"
    echo
    echo "【1】管理パスワード"
    security add-generic-password -U -a "$KC_ACCOUNT" -s "$KC_ADMIN" -w || exit 1
    echo
    echo "【2】合言葉（${TOKEN_LENGTH}文字のもの）"
    security add-generic-password -U -a "$KC_ACCOUNT" -s "$KC_SYNC" -w || exit 1
    echo

    # 正しく保存できたか確かめる
    CHECK_ADMIN="$(kc_get "$KC_ADMIN")"
    CHECK_SYNC="$(kc_get "$KC_SYNC")"
    if [ -z "$CHECK_ADMIN" ]; then
        echo "管理パスワードが空でした。もう一度 ./start-local.sh setup をやり直してください。"
        exit 1
    fi
    if [ "${#CHECK_SYNC}" -ne "$TOKEN_LENGTH" ]; then
        echo "合言葉が ${#CHECK_SYNC} 文字でした（${TOKEN_LENGTH} 文字のはず）。"
        echo "もう一度 ./start-local.sh setup をやり直してください。"
        exit 1
    fi
    echo "保存できました。次からは ./start-local.sh だけで起動できます。"
    exit 0
fi

# --- forget：キーチェーンから消す ---------------------------------
if [ "$1" = "forget" ]; then
    security delete-generic-password -a "$KC_ACCOUNT" -s "$KC_ADMIN" > /dev/null 2>&1
    security delete-generic-password -a "$KC_ACCOUNT" -s "$KC_SYNC" > /dev/null 2>&1
    echo "キーチェーンから消しました。"
    exit 0
fi

# --- 起動前のチェック -------------------------------------------
if ! command -v node > /dev/null; then
    echo "node が見つかりません。Node.js が入っているか確認してください。"
    exit 1
fi
if [ ! -d node_modules ]; then
    echo "node_modules がありません。先に npm install を実行してください。"
    exit 1
fi
mkdir -p data

# --- 練習モード -------------------------------------------------
if [ "$1" = "practice" ]; then
    echo "【練習モード】Render にはつながりません"
    SYNC_TOKEN=test SQLITE_PATH="$SQLITE_PATH" exec node server.js
fi

# --- まずキーチェーンから取り出してみる --------------------------
ADMIN=""
SYNC=""
if command -v security > /dev/null; then
    ADMIN="$(kc_get "$KC_ADMIN")"
    SYNC="$(kc_get "$KC_SYNC")"
fi

if [ -n "$ADMIN" ] && [ "${#SYNC}" -eq "$TOKEN_LENGTH" ]; then
    echo "キーチェーンからパスワードと合言葉を読み込みました"
else
    # キーチェーンになければ、これまでどおり聞く（画面には表示されない）
    echo "（キーチェーンに保存すると、次から聞かれなくなります → ./start-local.sh setup）"

    read -r -s -p "管理パスワードを貼って Enter: " ADMIN
    echo
    if [ -z "$ADMIN" ]; then
        echo "管理パスワードが空です。もう一度 ./start-local.sh からやり直してください。"
        exit 1
    fi

    SYNC=""
    for try in 1 2 3; do
        read -r -s -p "合言葉を貼って Enter: " SYNC
        echo
        SYNC="${SYNC//[[:space:]]/}"   # 貼り付けで紛れ込んだ空白・改行を取り除く
        if [ "${#SYNC}" -eq "$TOKEN_LENGTH" ]; then
            echo "合言葉OK（${TOKEN_LENGTH}文字）"
            break
        fi
        echo "合言葉が ${#SYNC} 文字でした（${TOKEN_LENGTH} 文字のはず）。もう一度貼ってください。"
        SYNC=""
    done
    if [ -z "$SYNC" ]; then
        echo "合言葉を確認できませんでした。パスワードアプリの合言葉を確認してください。"
        exit 1
    fi
fi

# --- 起動（止めたら再起動するか聞く）-----------------------------
while true; do
    # サーバーが動いている間の Control + C は、サーバーだけを止める
    trap ':' INT
    echo "------------------------------------------------------------"
    echo "サーバーを起動します（止めるときは Control + C）"
    echo "------------------------------------------------------------"
    ADMIN_PASSWORD="$ADMIN" \
    SYNC_TOKEN="$SYNC" \
    SYNC_URL="$SYNC_URL" \
    SQLITE_PATH="$SQLITE_PATH" \
        node server.js

    echo
    echo "サーバーが止まりました。"
    # ここでの Control + C は、このスクリプトごと終了する
    trap - INT
    read -r -p "Enter で再起動 / q を入力して Enter で終了: " answer
    if [ "$answer" = "q" ]; then
        break
    fi
done

echo "終了しました。"
