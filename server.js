const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { containsNgWord, normalize } = require("./moderation");
const { createStore } = require("./store");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ""; // 管理ページのパスワード
const MONITOR_LIMIT = 5; // モニターに表示する回答の数

const store = createStore(process.env.DATABASE_URL);

// お題はここで自由に書き換えられます
const topics = [
    "100年後、学校はどんな場所になっている？",
    "未来の家に、絶対あってほしいものは？",
    "2050年、いちばん人気の仕事は何？",
    "未来の自分に、ひとことだけ伝えるなら？",
    "タイムマシンで何年後に行ってみたい？そこで何をする？",
    "未来の街から消えていそうなものは？",
    "100年後の「当たり前」になっていそうなことは？",
    "ロボットと友だちになれたら、一緒に何をしたい？",
    "未来の食卓に並んでいそうな料理は？",
    "未来の発明をひとつだけ今すぐ使えるなら、何を選ぶ？",
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
            // ③ 保存（同じ端末・同じお題・同じ回答なら保存されず null が返る）
            const row = await store.add({ topicId, topic, answer, deviceId, norm: normalize(answer) });
            if (!row) {
                return reply(false, {
                    reason: "repeated",
                    message: "この回答はもう届いています。別の答えも送ってみてください",
                });
            }

            // ④ モニターと一覧ページに流す
            console.log("回答受信:", topic, "/", answer);
            io.emit("newAnswer", toPublic(row));
            reply(true);
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
        });
    })
    .catch((err) => {
        console.error("保存先の準備に失敗しました:", err);
        process.exit(1);
    });
