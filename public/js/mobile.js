const socket = io();
const topicEl = document.getElementById("topic");
const answerEl = document.getElementById("answer");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status");

let topicId = null;
let topicFixed = false; // QRで決まったお題なら true（送信後も同じお題のまま）
let sending = false;    // 送信中・お題の切り替え中かどうか（連打防止用）

// ------------------------------------------------------------
// 住所の番号（QRコード用）
//   https://mitimondou.onrender.com/?q=3 → 3
//   番号がない・おかしいときは null（今までどおり順番に配ってもらう）
//   ※最終的に正しい番号かどうかはサーバーが判断する
// ------------------------------------------------------------
function getQrNumber() {
    const raw = new URLSearchParams(location.search).get("q");
    if (raw === null) return null;
    const q = Number(raw);
    return Number.isInteger(q) && q >= 1 ? q : null;
}

const qrNumber = getQrNumber();

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

function showTopic(topic) {
    topicId = topic.id;
    topicFixed = Boolean(topic.fixed);
    topicEl.textContent = topic.text;
}

// ページを開いたときに1回だけお題をもらう
//   QRの番号があれば「この番号のお題ください」と頼む
if (qrNumber !== null) {
    socket.emit("getTopic", { q: qrNumber }, (topic) => {
        showTopic(topic);
        statusEl.textContent = "";
    });
} else {
    socket.emit("getTopic", (topic) => {
        showTopic(topic);
        statusEl.textContent = "";
    });
}

// 設置スマホ用：送信できたら次のお題に切り替える
//   切り替え中は送信ボタンを押せないようにして、
//   「前のお題の番号で新しい回答を送ってしまう」のを防ぐ
function loadNextTopic() {
    setSending(true);
    socket.timeout(5000).emit("getTopic", (err, topic) => {
        setSending(false);
        if (err) {
            // 取れなかったら今のお題のまま続ける（送信は済んでいる）
            statusEl.textContent = "送信しました！";
            return;
        }
        showTopic(topic);
        statusEl.textContent = "送信しました！次のお題です";
    });
}

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
            if (topicFixed) {
                // QRのページ：同じお題のまま
                statusEl.textContent = "送信しました！";
            } else {
                // 設置スマホ（番号なし）：次のお題へ
                loadNextTopic();
            }
        } else {
            // 禁止用語や同じ回答のときは、入力を残したままメッセージを出す
            statusEl.textContent = (info && info.message)
                || "送信できませんでした。もう一度押してください";
        }
    });
});
