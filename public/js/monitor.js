const socket = io();
const listEl = document.getElementById("answers");

socket.on("newAnswer", ({ topic, answer }) => {
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