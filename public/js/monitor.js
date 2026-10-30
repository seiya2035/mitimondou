const socket = io();
const listEl = document.getElementById("answers");

// モニターに表示する回答の数（server.js の MONITOR_LIMIT と同じ数にする）
const MONITOR_LIMIT = 5;

// 回答を1つ表示用の <li> にする
function createItem(data) {
    // 古い形式（文字だけ）でも表示できるようにする
    const isObject = typeof data === "object" && data !== null;
    const topic = isObject ? data.topic : "";
    const answer = isObject ? data.answer : data;

    const li = document.createElement("li");
    // 管理ページで非表示にされたときに探せるよう、回答の番号を付けておく
    if (isObject && data.id != null) li.dataset.id = String(data.id);

    const topicP = document.createElement("p");
    topicP.className = "answer-topic";
    topicP.textContent = topic;

    const answerP = document.createElement("p");
    answerP.className = "answer-text";
    answerP.textContent = answer;

    li.append(topicP, answerP);
    return li;
}

// 上限を超えた分を、古いもの（下のほう）から消す
function trimList() {
    while (listEl.children.length > MONITOR_LIMIT) {
        listEl.lastElementChild.remove();
    }
}

// 新しい回答を一番上に追加する
function addAnswer(data) {
    listEl.prepend(createItem(data));
    trimList();
}

// 開いたとき・再接続したときに、最新の回答を取り直して表示し直す
socket.on("connect", () => {
    console.log("モニター：接続しました");
    socket.emit("getRecent", (recent) => {
        listEl.innerHTML = "";
        // recent は古い順に並んでいるので、順に一番上へ足すと新しいものが上になる
        recent.forEach(addAnswer);
    });
});

// 新しい回答が届いた
socket.on("newAnswer", addAnswer);

// 管理ページで非表示にされた
socket.on("answerRemoved", ({ id }) => {
    const item = listEl.querySelector(`li[data-id="${id}"]`);
    if (!item) return;
    item.remove();
    // 1つ減ったので、表示から外れていた回答を補充するために取り直す
    socket.emit("getRecent", (recent) => {
        listEl.innerHTML = "";
        recent.forEach(addAnswer);
    });
});

// 管理ページで再表示にされた（元に戻した回答を表示し直す）
socket.on("answersChanged", () => {
    socket.emit("getRecent", (recent) => {
        listEl.innerHTML = "";
        recent.forEach(addAnswer);
    });
});

// 管理ページで全部リセットされた
socket.on("answersReset", () => {
    listEl.innerHTML = "";
});
