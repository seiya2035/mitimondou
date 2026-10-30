// ------------------------------------------------------------
// 予備ローカル用：Render から回答を受け取る係
//   呼び鈴：Render とつなぎっぱなしにして、届いた回答をその場で受け取る
//   見回り：呼び鈴を聞き逃したときのために、10秒おきにも取りに行く
// 見回りと、呼び鈴のあとの念のための確認は 3-1 の窓口（/api/sync/answers）を使う
// ------------------------------------------------------------
const { io: connectTo } = require("socket.io-client");
const { normalize } = require("./moderation");

const PATROL_MS = 10 * 1000; // 見回りの間隔（10秒）
const OVERLAP = 20; // しおりの少し手前から読み直す件数（追い越し対策）
const PAGE = 100; // 窓口が1回に渡してくれる最大件数

function startSync({ store, remoteUrl, token, onNew }) {
    let busy = false; // 今、取りに行っている最中か
    let again = false; // 最中にもう一度呼ばれたか

    // 受け取った回答を1件保存して、新しければモニターに出す
    async function save(a) {
        // すでに受け取った番号なら null が返る（二重表示しない）
        const row = await store.addRemote({
            remoteId: a.id,
            topicId: Number.isInteger(a.topicId) ? a.topicId : null,
            topic: a.topic || "",
            answer: a.answer,
            norm: normalize(a.answer),
            hidden: a.hidden === true,
            createdAt: a.createdAt || new Date().toISOString(),
        });
        if (row) {
            console.log("同期: 受け取り", a.id, "/", a.answer);
            if (!row.hidden) onNew(row); // 非表示の回答はモニターに出さない
        }
    }

    // 窓口へ取りに行く
    async function pull() {
        if (busy) {
            again = true; // 今の分が終わったらもう一度行く
            return;
        }
        busy = true;
        try {
            do {
                again = false;

                // しおり（受け取った一番大きい Render の番号）の少し手前から頼む
                const bookmark = await store.maxRemoteId();
                const after = Math.max(0, bookmark - OVERLAP);
                const res = await fetch(`${remoteUrl}/api/sync/answers?after=${after}`, {
                    headers: { "x-sync-token": token },
                    signal: AbortSignal.timeout(10 * 1000), // 10秒で返事がなければあきらめる
                });
                if (!res.ok) {
                    console.error("同期: 窓口に断られました", res.status);
                    break;
                }
                const data = await res.json();

                for (const a of data.answers) {
                    await save(a);
                }

                // 満杯で返ってきたら、まだ続きがあるのでもう一度
                if (data.answers.length >= PAGE) again = true;
            } while (again);
        } catch (err) {
            console.error("同期: 取りに行けませんでした:", err.message);
        } finally {
            busy = false;
        }
    }

    // 呼び鈴：Render とつなぎっぱなしにする
    const socket = connectTo(remoteUrl, { reconnectionDelayMax: 5000 });
    socket.on("connect", () => {
        console.log("同期: Render とつながりました");
        pull(); // つながった（つながり直した）ら、すぐ取りに行く
    });
    socket.on("disconnect", () => {
        console.log("同期: Render との接続が切れました（自動でつなぎ直します）");
    });
    // 「来たよ」が鳴ったら、いっしょに届いた回答をすぐ保存してモニターに出す
    socket.on("newAnswer", async (a) => {
        try {
            if (a && Number.isInteger(a.id) && typeof a.answer === "string") {
                await save(a);
            }
        } catch (err) {
            console.error("同期: 保存できませんでした:", err.message);
        }
        pull(); // 念のため窓口にも取りに行く（聞き逃した分があれば拾う）
    });

    // 見回り
    setInterval(pull, PATROL_MS);
}

module.exports = { startSync };