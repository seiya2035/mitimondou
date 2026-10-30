const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { containsNgWord, normalize } = require("./moderation");
const { createStore } = require("./store");
const { randomUUID } = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ""; // 管理ページのパスワード
const SYNC_TOKEN = process.env.SYNC_TOKEN || ""; // 予備ローカルが回答を取りに来るときの合言葉
const MONITOR_LIMIT = 5; // モニターに表示する回答の数

const store = createStore({
    databaseUrl: process.env.DATABASE_URL,
    sqlitePath: process.env.SQLITE_PATH,
});

// 予備ローカルとして動くか（Render の住所・合言葉・SQLite がそろったとき）
//   このときサーバーに直接届く回答は、すべて設置スマホからのもの
const SYNC_URL = process.env.SYNC_URL || "";
const LOCAL_MODE = Boolean(SYNC_URL && SYNC_TOKEN && store.addRemote);
let syncer = null; // Render とやりとりする係（予備ローカルのときだけ動く）

// お題はここで自由に書き換えられます
const topics = [
    "100年後の犬の鳴き声は？",
    "100年後の人気ペットランキング堂々の第一位を教えてください。",
    "100年後の買い物あるあるをどうぞ。",
    "100年後の給食で人気NO.1のメニューとは？",
    "2127年夏季オリンピックに加わった新種目とは？",
    "100年後の朝ごはんの定番とは？",
    "100年後、唯一AIが奪えなかった職業とは？",
    "100年後の修学旅行、どうなる？",
    "100年後の流行語大賞に選ばれた言葉とは？",
    "2127年でも大須商店街が大盛況なワケを教えてください。",
    "100年後の車に搭載されている最高の機能とは？",
    "進化する筆記用具、100年後はどんな機能がついてる？",
];

let nextIndex = 0;

app.use(express.static("public"));
app.use(express.json({ limit: "4kb" }));

// 公開してよい形に変換する（端末IDそのものは外に出さない）
function toPublic(row, viewerDeviceId = "") {
    return {
        id: row.id,
        topic: row.topic,
        answer: row.answer,
        createdAt: row.createdAt,
        mine: Boolean(viewerDeviceId) && row.deviceId === viewerDeviceId,
    };
}

// 呼び鈴（newAnswer）で流す形。設置スマホの回答にだけ「送り状番号」を付ける
// （予備ローカルが「これは自分が送った回答だ」と気づけるようにするため）
function toBroadcast(row) {
    const data = toPublic(row);
    if (row.syncKey) data.syncKey = row.syncKey;
    return data;
}

// ------------------------------------------------------------
// 回答一覧ページ用
// ------------------------------------------------------------
app.get("/api/answers", async (req, res) => {
    try {
        const deviceId = typeof req.query.deviceId === "string"
            ? req.query.deviceId.slice(0, 64)
            : "";
        const rows = await store.list({ limit: 500 });
        res.json(rows.map((r) => toPublic(r, deviceId)));
    } catch (err) {
        console.error("一覧の取得エラー:", err);
        res.status(500).json({ ok: false });
    }
});

// ------------------------------------------------------------
// 管理ページ用（パスワードが必要）
// ------------------------------------------------------------
function requireAdmin(req, res, next) {
    if (!ADMIN_PASSWORD) {
        return res.status(503).json({ ok: false, message: "サーバーに ADMIN_PASSWORD が設定されていません" });
    }
    if (req.get("x-admin-password") !== ADMIN_PASSWORD) {
        return res.status(401).json({ ok: false, message: "パスワードが違います" });
    }
    next();
}

// 非表示にしたものも含めて全部返す
app.get("/api/admin/answers", requireAdmin, async (req, res) => {
    try {
        const rows = await store.list({ includeHidden: true, limit: 1000 });
        res.json(rows.map((r) => ({ ...toPublic(r), hidden: r.hidden })));
    } catch (err) {
        console.error("管理一覧の取得エラー:", err);
        res.status(500).json({ ok: false });
    }
});

// 1件を非表示にする / 元に戻す
app.post("/api/admin/answers/:id/hidden", requireAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const hidden = req.body && req.body.hidden === true;
        const row = await store.setHidden(id, hidden);
        if (!row) return res.status(404).json({ ok: false, message: "回答が見つかりません" });

        console.log(hidden ? "非表示:" : "再表示:", row.answer);
        if (hidden) {
            io.emit("answerRemoved", { id }); // モニター・一覧ページから消す
        } else {
            io.emit("answersChanged"); // 一覧ページを読み直す
        }
        res.json({ ok: true });
    } catch (err) {
        console.error("非表示の切り替えエラー:", err);
        res.status(500).json({ ok: false });
    }
});

// 全部消す（テスト用のリセット）
app.post("/api/admin/reset", requireAdmin, async (req, res) => {
    try {
        if (!req.body || req.body.confirm !== "RESET") {
            return res.status(400).json({ ok: false, message: "確認の文字が違います" });
        }
        await store.reset();
        console.log("回答を全てリセットしました");
        io.emit("answersReset"); // モニター・一覧ページを空にする
        res.json({ ok: true });
    } catch (err) {
        console.error("リセットエラー:", err);
        res.status(500).json({ ok: false });
    }
});

// ------------------------------------------------------------
// 予備ローカル用の窓口（合言葉が必要）
//   GET /api/sync/answers?after=12 → 12番より後の回答を古い順に返す
// ------------------------------------------------------------
function requireSync(req, res, next) {
    if (!SYNC_TOKEN) {
        return res.status(503).json({ ok: false, message: "サーバーに SYNC_TOKEN が設定されていません" });
    }
    if (req.get("x-sync-token") !== SYNC_TOKEN) {
        return res.status(401).json({ ok: false, message: "合言葉が違います" });
    }
    next();
}

app.get("/api/sync/answers", requireSync, async (req, res) => {
    try {
        // 「○番より後」の○。数字でなければ 0（最初から全部）として扱う
        const after = Number(req.query.after);
        const afterId = Number.isInteger(after) && after >= 0 ? after : 0;

        const rows = await store.listAfter(afterId, 100);
        res.json({
            ok: true,
            answers: rows.map((r) => ({
                id: r.id,
                topicId: r.topicId,
                topic: r.topic,
                answer: r.answer,
                hidden: r.hidden,
                createdAt: r.createdAt,
                syncKey: r.syncKey || null,
            })),
        });
    } catch (err) {
        console.error("同期用の取得エラー:", err);
        res.status(500).json({ ok: false });
    }
});

// ------------------------------------------------------------
// 予備ローカル用の窓口その2（合言葉が必要）
//   POST /api/sync/answers → 設置スマホの回答を受け取って保存する
//   送り状番号（syncKey）が同じものは2回目以降は保存せず、前の番号を返す
//   （返事が届かずに予備ローカルが送り直しても、二重にならないように）
// ------------------------------------------------------------
app.post("/api/sync/answers", requireSync, async (req, res) => {
    try {
        if (!store.addFromLocal) {
            return res.status(501).json({ ok: false, message: "この保存先では受け取れません" });
        }

        const body = req.body || {};
        const syncKey = typeof body.syncKey === "string" ? body.syncKey : "";
        // 送り状番号は英数字とハイフンだけ、8〜64文字
        if (!/^[A-Za-z0-9-]{8,64}$/.test(syncKey)) {
            return res.status(400).json({ ok: false, reason: "badKey", message: "送り状番号が正しくありません" });
        }

        const answer = String(body.answer ?? "").trim().slice(0, 200);
        if (!answer) {
            return res.status(400).json({ ok: false, reason: "empty", message: "回答が空です" });
        }
        if (containsNgWord(answer)) {
            console.log("同期で届いた回答に禁止用語:", answer);
            return res.status(422).json({ ok: false, reason: "ng", message: "禁止用語が含まれています" });
        }

        // お題は番号から引く。番号がおかしければ、送られてきた文章を使う
        const topicIdNum = Number(body.topicId);
        const topicId = Number.isInteger(topicIdNum) && topics[topicIdNum] ? topicIdNum : null;
        const topic = topicId !== null
            ? topics[topicId]
            : String(body.topic ?? "").slice(0, 200);

        // 書かれた時刻（ネットが切れていて後から送る場合もあるので、予備ローカルの時刻を使う）
        const time = new Date(body.createdAt);
        const createdAt = Number.isNaN(time.getTime()) ? new Date() : time;

        const { row, created } = await store.addFromLocal({
            syncKey,
            topicId,
            topic,
            answer,
            norm: normalize(answer),
            createdAt: createdAt.toISOString(),
        });

        if (created) {
            console.log("設置スマホの回答を受信:", topic, "/", answer);
            io.emit("newAnswer", toBroadcast(row)); // 本番のモニター・一覧ページにも出す
        }
        res.json({ ok: true, id: row.id, created });
    } catch (err) {
        console.error("同期での受け取りエラー:", err);
        res.status(500).json({ ok: false });
    }
});

// ------------------------------------------------------------
// Socket.IO
// ------------------------------------------------------------
io.on("connection", (socket) => {
    console.log("接続:", socket.id);

    socket.on("getTopic", (callback) => {
        if (typeof callback !== "function") return;
        const id = nextIndex;
        nextIndex = (nextIndex + 1) % topics.length;
        callback({ id, text: topics[id] });
    });

    // モニター用：最新の回答を古い順に返す（開いた直後・再接続時に使う）
    socket.on("getRecent", async (callback) => {
        if (typeof callback !== "function") return;
        try {
            const rows = await store.list({ limit: MONITOR_LIMIT });
            callback(rows.reverse().map((r) => toPublic(r)));
        } catch (err) {
            console.error("最新回答の取得エラー:", err);
            callback([]);
        }
    });

    socket.on("answer", async (data, callback) => {
        // 結果をスマホに返す。1つ目は成功したか、2つ目は理由とメッセージ
        const reply = (ok, info) => {
            if (typeof callback === "function") callback(ok, info);
        };

        const isObject = typeof data === "object" && data !== null;
        const text = isObject ? data.text : data;
        const topicIdNum = isObject ? Number(data.topicId) : NaN;
        const topicId = Number.isInteger(topicIdNum) && topics[topicIdNum] ? topicIdNum : null;
        const topic = topicId !== null ? topics[topicId] : "";
        const answer = String(text ?? "").trim().slice(0, 200);
        const deviceId = isObject && typeof data.deviceId === "string"
            ? data.deviceId.slice(0, 64)
            : "";

        // ① 空の回答
        if (!answer) {
            return reply(false, { reason: "empty", message: "回答を入力してください" });
        }

        // ② 禁止用語
        if (containsNgWord(answer)) {
            console.log("禁止用語のため表示しません:", answer);
            return reply(false, {
                reason: "ng",
                message: "表示できない言葉が含まれています。言い方を変えてみてください",
            });
        }

        try {
            let row;
            if (LOCAL_MODE) {
                // ③ 予備ローカル：設置スマホの回答として保存
                //    交代で使うので重複チェックはせず、送り状番号を付けて送り箱へ
                row = await store.addKiosk({
                    syncKey: randomUUID(),
                    topicId,
                    topic,
                    answer,
                    norm: normalize(answer),
                });
            } else {
                // ③ 保存（同じ端末・同じお題・同じ回答なら保存されず null が返る）
                row = await store.add({ topicId, topic, answer, deviceId, norm: normalize(answer) });
                if (!row) {
                    return reply(false, {
                        reason: "repeated",
                        message: "この回答はもう届いています。別の答えも送ってみてください",
                    });
                }
            }

            // ④ モニターと一覧ページに流す
            console.log("回答受信:", topic, "/", answer);
            io.emit("newAnswer", toBroadcast(row));
            reply(true);

            // ⑤ 予備ローカルなら、すぐ Render へ送りに行く（つながっていなければ送り箱で待つ）
            if (syncer) syncer.sendNow();
        } catch (err) {
            console.error("保存エラー:", err);
            reply(false, { reason: "server", message: "送信できませんでした。もう一度押してください" });
        }
    });
});

// ------------------------------------------------------------
// 起動
// ------------------------------------------------------------
store.init()
    .then(() => {
        server.listen(PORT, () => {
            console.log(`保存先: ${store.kind}`);
            if (!ADMIN_PASSWORD) console.warn("ADMIN_PASSWORD が未設定のため、管理ページは使えません");
            console.log(`起動しました: http://localhost:${PORT}`);

            // 予備ローカルのときだけ、Render から回答を受け取る係を動かす
            if (LOCAL_MODE) {
                const { startSync } = require("./sync");
                syncer = startSync({
                    store,
                    remoteUrl: SYNC_URL,
                    token: SYNC_TOKEN,
                    onNew: (row) => io.emit("newAnswer", toPublic(row)),
                });
                console.log(`Render から受け取ります: ${SYNC_URL}`);
                console.log("設置スマホの回答は、ここに保存して Render にも送ります");
            }
        });
    })
    .catch((err) => {
        console.error("保存先の準備に失敗しました:", err);
        process.exit(1);
    });