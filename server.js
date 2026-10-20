const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const topic = "100年後、〇〇はどうなっている？"; // お題はここを書き換える

app.use(express.static("public"));

io.on("connection", (socket) => {
    // つながった人にお題を送る
    socket.emit("topic", topic);

    // スマホから回答が届いたら、全員（モニター含む）に配る
    socket.on("answer", (text) => {
        const answer = String(text).trim().slice(0, 200);
        if (!answer) return;
        io.emit("newAnswer", answer);
    });
});

server.listen(PORT, () => {
    console.log(`起動しました: http://localhost:${PORT}`);
});
