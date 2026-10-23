const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

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
        // 古い形式（文字だけ）でも新しい形式（{ topicId, text }）でも受け取る
        const isObject = typeof data === "object" && data !== null;
        const text = isObject ? data.text : data;
        const topic = isObject ? topics[Number(data.topicId)] ?? "" : "";
        const answer = String(text ?? "").trim().slice(0, 200);

        console.log("回答受信:", topic, "/", answer);
        if (!answer) return;

        io.emit("newAnswer", { topic, answer });
        if (typeof callback === "function") callback(true);
    });
});

server.listen(PORT, () => {
    console.log(`起動しました: http://localhost:${PORT}`);
});
