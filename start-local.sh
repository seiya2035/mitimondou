#!/bin/bash
# ============================================================
# 未知問答：予備ローカルを1コマンドで起動する
#
#   使い方（プロジェクトのフォルダで）
#     ./start-local.sh            … 本番（Render）とつないで起動
#     ./start-local.sh practice   … 練習用（Render にはつながない）
#
#   ・管理パスワードと合言葉は、起動のたびに貼り付けて入力する
#     （画面に表示されず、ターミナルの履歴にもファイルにも残らない）
#   ・サーバーを Control + C で止めると「Enter で再起動」が出る
#     → ファイルを差し替えたあとも、貼り直さずに再起動できる
# ============================================================

SYNC_URL="https://mitimondou.onrender.com"
SQLITE_PATH="data/answers.db"
TOKEN_LENGTH=48   # 合言葉（openssl rand -hex 24 で作ったもの）の文字数

# このファイルが置いてあるフォルダ（＝プロジェクト）に移動する
cd "$(dirname "$0")" || exit 1

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

# --- パスワードと合言葉を聞く（画面には表示されない）------------
read -r -s -p "管理パスワードを貼って Enter: " ADMIN
echo
if [ -z "$ADMIN" ]; then
    echo "管理パスワードが空です。もう一度 ./start-local.sh からやり直してください。"
    exit 1
fi

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
