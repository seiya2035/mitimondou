const socket = io();
const topicEl = document.getElementById("topic");
const listEl = document.getElementById("answers");

socket.on("topic", (topic) => {
    topicEl.textContent = topic;
});

socket.on("newAnswer", (text) => {
    const li = document.createElement("li");
    li.textContent = text; // textContent を使うと、変な文字を入れられても安全
    listEl.prepend(li); // 新しい回答を一番上に追加
});
