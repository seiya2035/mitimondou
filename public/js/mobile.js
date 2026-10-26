const socket = io();
const topicEl = document.getElementById("topic");
const answerEl = document.getElementById("answer");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status");

let topicId = null;
let sending = false; // 送信中かどうか（連打防止用）

// ------------------------------------------------------------
// 端末ID：初回だけ作って、このブラウザに保存しておく
// 同じ端末から同じ回答が送られたかをサーバーが見分けるために使う
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// 接続とお題
// ------------------------------------------------------------
socket.on("connect_error", () => {
    statusEl.textContent = "サーバーに接続できません。少し待って再読み込みしてください";
});

// ページを開いたときに1回だけお題をもらう
socket.emit("getTopic", (topic) => {
    topicId = topic.id;
    topicEl.textContent = topic.text;
    statusEl.textContent = "";
});

// ------------------------------------------------------------
// 送信
// ------------------------------------------------------------
function setSending(value) {
    sending = value;
    sendBtn.disabled = value;
}

sendBtn.addEventListener("click", () => {
    if (sending) return; // 返事を待っている間は押せない

    const text = answerEl.value.trim();
    if (topicId === null) {
        statusEl.textContent = "お題を読み込み中です。少し待ってください";
        return;
    }
    if (!text) {
        statusEl.textContent = "回答を入力してください";
        return;
    }

    setSending(true);
    statusEl.textContent = "送信中…";

    // timeout を使うと、返事の1つ目は「時間切れかどうか」になる
    //   err  … 5秒以内に返事がなければエラーが入る
    //   ok   … サーバーが受け付けたら true
    //   info … 受け付けなかった理由とメッセージ
    socket.timeout(5000).emit("answer", { topicId, text, deviceId }, (err, ok, info) => {
        setSending(false);

        if (err) {
            statusEl.textContent = "送信できませんでした。もう一度押してください";
            return;
        }

        if (ok) {
            answerEl.value = "";
            statusEl.textContent = "送信しました！";
        } else {
            // 禁止用語や同じ回答のときは、入力を残したままメッセージを出す
            statusEl.textContent = (info && info.message)
                || "送信できませんでした。もう一度押してください";
        }
    });
});
