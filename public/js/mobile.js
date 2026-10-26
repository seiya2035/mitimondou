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

// ===== mobile.js に追加する部分 =====

// 端末IDを作る（初回だけ作って、スマホのブラウザに保存しておく）
function getDeviceId() {
    const KEY = "mitimondou-device-id";
    try {
        let id = localStorage.getItem(KEY);
        if (!id) {
            // randomUUID が使えない環境（http の IP アドレスなど）用の予備
            id = (window.crypto && crypto.randomUUID)
                ? crypto.randomUUID()
                : Date.now().toString(36) + Math.random().toString(36).slice(2);
            localStorage.setItem(KEY, id);
        }
        return id;
    } catch (e) {
        // 保存できない設定のブラウザでは端末IDなしで送る（重複チェックはされない）
        return "";
    }
}

const deviceId = getDeviceId();

// ===== 送信部分の書き換え例 =====
// これまで { topicId, text } を送っていたところに deviceId を足し、
// 返事を (ok, info) の2つで受け取るようにする

socket.emit("answer", { topicId, text, deviceId }, (ok, info) => {
    if (ok) {
        statusEl.textContent = "送信しました！";
        // 入力欄を空にするなど、今の成功時の処理
    } else {
        // サーバーからのメッセージがあればそれを表示する
        statusEl.textContent = (info && info.message)
            || "送信できませんでした。もう一度押してください";
    }
});
