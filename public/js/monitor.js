const socket = io();
const topicEl = document.getElementById("topic");
const answerEl = document.getElementById("answer");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status");

let topicId = null;

// ページを開いたときに1回だけお題をもらう
socket.emit("getTopic", (topic) => {
    topicId = topic.id;
    topicEl.textContent = topic.text;
});

sendBtn.addEventListener("click", () => {
    const text = answerEl.value.trim();
    if (topicId === null) return;
    if (!text) {
        statusEl.textContent = "回答を入力してください";
        return;
    }
    socket.emit("answer", { topicId, text });
    answerEl.value = "";
    statusEl.textContent = "送信しました！";
});
