const socket = io();
const listEl = document.getElementById("answers");

socket.on("connect", () => console.log("モニター：接続しました"));

socket.on("newAnswer", (data) => {
    // 古い形式（文字だけ）でも表示できるようにする
    const topic = typeof data === "object" && data !== null ? data.topic : "";
    const answer = typeof data === "object" && data !== null ? data.answer : data;

    const li = document.createElement("li");

    const topicP = document.createElement("p");
    topicP.className = "answer-topic";
    topicP.textContent = topic;

    const answerP = document.createElement("p");
    answerP.className = "answer-text";
    answerP.textContent = answer;

    li.append(topicP, answerP);
    listEl.prepend(li);
});