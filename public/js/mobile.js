const socket = io();
const topicEl = document.getElementById("topic");
const answerEl = document.getElementById("answer");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status");

socket.on("topic", (topic) => {
    topicEl.textContent = topic;
});

sendBtn.addEventListener("click", () => {
    const text = answerEl.value.trim();
    if (!text) {
        statusEl.textContent = "回答を入力してください";
        return;
    }
    socket.emit("answer", text);
    answerEl.value = "";
    statusEl.textContent = "送信しました！";
});
