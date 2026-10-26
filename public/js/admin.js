const KEY = "mitimondou-admin-password";

const loginView = document.getElementById("loginView");
const adminView = document.getElementById("adminView");
const loginForm = document.getElementById("loginForm");
const passwordEl = document.getElementById("password");
const loginMessage = document.getElementById("loginMessage");
const adminMessage = document.getElementById("adminMessage");
const rowsEl = document.getElementById("rows");
const countEl = document.getElementById("count");

// パスワードはこのタブを閉じるまでだけ覚えておく
let password = sessionStorage.getItem(KEY) || "";
let socket = null;

// パスワード付きでサーバーにお願いする
async function api(path, options = {}) {
    const res = await fetch(path, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            "x-admin-password": password,
            ...(options.headers || {}),
        },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 503) {
        logout(data.message || "ログインし直してください");
        throw new Error("unauthorized");
    }
    if (!res.ok) throw new Error(data.message || "サーバーでエラーが起きました");
    return data;
}

function formatTime(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function render(list) {
    rowsEl.innerHTML = "";
    const hiddenCount = list.filter((a) => a.hidden).length;
    countEl.textContent = `全 ${list.length} 件（非表示 ${hiddenCount} 件）`;

    for (const a of list) {
        const tr = document.createElement("tr");
        if (a.hidden) tr.classList.add("is-hidden");

        const time = document.createElement("td");
        time.className = "time";
        time.textContent = formatTime(a.createdAt);

        const topic = document.createElement("td");
        topic.className = "topic";
        topic.textContent = a.topic || "お題なし";

        const answer = document.createElement("td");
        answer.className = "answer";
        answer.textContent = a.answer;
        if (a.hidden) {
            const state = document.createElement("span");
            state.className = "state";
            state.textContent = "非表示中";
            answer.appendChild(state);
        }

        const action = document.createElement("td");
        action.className = "action";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = a.hidden ? "元に戻す" : "非表示にする";
        btn.addEventListener("click", () => setHidden(a.id, !a.hidden, btn));
        action.appendChild(btn);

        tr.append(time, topic, answer, action);
        rowsEl.appendChild(tr);
    }
}

async function load() {
    try {
        const list = await api("/api/admin/answers");
        adminMessage.textContent = "";
        render(list);
    } catch (e) {
        if (e.message !== "unauthorized") adminMessage.textContent = `読み込めませんでした：${e.message}`;
    }
}

async function setHidden(id, hidden, btn) {
    btn.disabled = true;
    try {
        await api(`/api/admin/answers/${id}/hidden`, {
            method: "POST",
            body: JSON.stringify({ hidden }),
        });
        await load();
    } catch (e) {
        if (e.message !== "unauthorized") adminMessage.textContent = `変更できませんでした：${e.message}`;
        btn.disabled = false;
    }
}

async function resetAll() {
    const input = prompt("全ての回答を消します。元には戻せません。\n消すには RESET と入力してください。");
    if (input !== "RESET") {
        adminMessage.textContent = input === null ? "" : "RESET と入力されなかったので、消していません";
        return;
    }
    try {
        await api("/api/admin/reset", {
            method: "POST",
            body: JSON.stringify({ confirm: "RESET" }),
        });
        adminMessage.textContent = "";
        await load();
    } catch (e) {
        if (e.message !== "unauthorized") adminMessage.textContent = `消せませんでした：${e.message}`;
    }
}

// 短い間に何度も変化があっても、読み直しは1回にまとめる
let reloadTimer = null;
function scheduleLoad() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 400);
}

function showAdmin() {
    loginView.hidden = true;
    adminView.hidden = false;
    if (!socket) {
        socket = io();
        socket.on("connect", scheduleLoad);
        socket.on("newAnswer", scheduleLoad);
        socket.on("answerRemoved", scheduleLoad);
        socket.on("answersChanged", scheduleLoad);
        socket.on("answersReset", scheduleLoad);
    }
    load();
}

function logout(message = "") {
    password = "";
    sessionStorage.removeItem(KEY);
    adminView.hidden = true;
    loginView.hidden = false;
    loginMessage.textContent = message;
}

loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    password = passwordEl.value;
    loginMessage.textContent = "";
    try {
        const list = await api("/api/admin/answers");
        sessionStorage.setItem(KEY, password);
        passwordEl.value = "";
        loginView.hidden = true;
        adminView.hidden = false;
        render(list);
        showAdmin();
    } catch (err) {
        if (err.message !== "unauthorized") loginMessage.textContent = `ログインできませんでした：${err.message}`;
    }
});

document.getElementById("reloadBtn").addEventListener("click", load);
document.getElementById("logoutBtn").addEventListener("click", () => logout());
document.getElementById("resetBtn").addEventListener("click", resetAll);

if (password) showAdmin();
