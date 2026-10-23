const socket = io();
const topicEl = document.getElementById("topic");
const answerEl = document.getElementById("answer");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status");

let topicId = null;

socket.on("connect_error", () => {
    statusEl.textContent = "サーバーに接続できません。少し待って再読み込みしてください";
});

// ページを開いたときに1回だけお題をもらう
socket.emit("getTopic", (topic) => {
    topicId = topic.id;
    topicEl.textContent = topic.text;
    statusEl.textContent = "";
});

sendBtn.addEventListener("click", () => {
    const text = answerEl.value.trim();
    if (topicId === null) {
        statusEl.textContent = "お題を読み込み中です。少し待ってください";
        return;
    }
    if (!text) {
        statusEl.textContent = "回答を入力してください";
        return;
    }

    statusEl.textContent = "送信中…";
    // サーバーが受け取ったら「送信しました」を出す（5秒返事がなければエラー）
    socket.timeout(5000).emit("answer", { topicId, text }, (err) => {
        if (err) {
            statusEl.textContent = "送信できませんでした。もう一度押してください";
            return;
        }
        answerEl.value = "";
        statusEl.textContent = "送信しました！";
    });
});