const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { containsNgWord, isRepeated, remember } = require("./moderation");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

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

io.on("connection", (socket) => {
    console.log("接続:", socket.id);

    socket.on("getTopic", (callback) => {
        if (typeof callback !== "function") return;
        const id = nextIndex;
        nextIndex = (nextIndex + 1) % topics.length;
        callback({ id, text: topics[id] });
    });

    socket.on("answer", (data, callback) => {
        // 結果をスマホに返す。1つ目は成功したか、2つ目は理由とメッセージ
        const reply = (ok, info) => {
            if (typeof callback === "function") callback(ok, info);
        };

        // 古い形式（文字だけ）でも新しい形式（{ topicId, text, deviceId }）でも受け取る
        const isObject = typeof data === "object" && data !== null;
        const text = isObject ? data.text : data;
        const topicId = isObject ? Number(data.topicId) : null;
        const topic = isObject ? topics[topicId] ?? "" : "";
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

        // ③ 同じ端末から、同じお題に、同じ回答
        if (isRepeated(deviceId, topicId, answer)) {
            return reply(false, {
                reason: "repeated",
                message: "この回答はもう届いています。別の答えも送ってみてください",
            });
        }

        // ④ 問題なし → 覚えてからモニターに流す
        // console.log("端末ID:", deviceId || "（なし）", "お題ID:", topicId);
        remember(deviceId, topicId, answer);
        console.log("回答受信:", topic, "/", answer);
        io.emit("newAnswer", { topic, answer });
        reply(true);
    });
});

server.listen(PORT, () => {
    console.log(`起動しました: http://localhost:${PORT}`);
});
