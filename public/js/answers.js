const socket = io();
const listEl = document.getElementById("list");
const countEl = document.getElementById("count");
const emptyEl = document.getElementById("empty");
const tabButtons = document.querySelectorAll("[data-filter]");

let answers = [];
let filter = "all";

// 回答ページ（mobile.js）と同じ端末IDを使う
function getDeviceId() {
    try {
        return localStorage.getItem("mitimondou-device-id") || "";
    } catch (e) {
        return "";
    }
}

function formatTime(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function render() {
    const shown = filter === "mine" ? answers.filter((a) => a.mine) : answers;

    listEl.innerHTML = "";
    for (const a of shown) {
        const li = document.createElement("li");
        if (a.mine) li.classList.add("mine");

        // textContent を使うと、回答に HTML が書かれていてもただの文字として表示される
        const topic = document.createElement("p");
        topic.className = "topic";
        topic.textContent = a.topic || "お題なし";

        const answer = document.createElement("p");
        answer.className = "answer";
        answer.textContent = a.answer;

        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = formatTime(a.createdAt);
        if (a.mine) {
            const you = document.createElement("span");
            you.className = "you";
            you.textContent = "あなたの回答";
            meta.appendChild(you);
        }

        li.append(topic, answer, meta);
        listEl.appendChild(li);
    }

    countEl.textContent = `${shown.length} 件`;
    emptyEl.hidden = shown.length > 0;
    emptyEl.textContent = filter === "mine"
        ? "このスマホから送った回答はまだありません。回答ページから送ると、ここに表示されます。"
        : "まだ回答がありません。";
}

async function load() {
    try {
        const res = await fetch(`/api/answers?deviceId=${encodeURIComponent(getDeviceId())}`);
        if (!res.ok) throw new Error(res.status);
        answers = await res.json();
        render();
    } catch (e) {
        countEl.textContent = "回答を読み込めませんでした。少し待ってから再読み込みしてください";
    }
}

// 短い間に何度も変化があっても、読み直しは1回にまとめる
let reloadTimer = null;
function scheduleLoad() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 400);
}

tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        filter = btn.dataset.filter;
        tabButtons.forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
        render();
    });
});

socket.on("connect", scheduleLoad); // 開いたとき・再接続したとき
socket.on("newAnswer", scheduleLoad);
socket.on("answerRemoved", scheduleLoad);
socket.on("answersChanged", scheduleLoad);
socket.on("answersReset", scheduleLoad);
