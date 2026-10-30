// ------------------------------------------------------------
// 予備ローカル用：Render とやりとりする係
//
// 【受け取り】Render に届いた回答を、こちらのモニターにも出す
//   呼び鈴：Render とつなぎっぱなしにして、届いた回答をその場で受け取る
//   見回り：呼び鈴を聞き逃したときのために、10秒おきにも取りに行く
//
// 【非表示の反映】Render で非表示 / 再表示にした回答を、こちらにも反映する（4-1）
//   呼び鈴：answerRemoved（非表示）・answersChanged（再表示）が鳴ったらすぐ直す
//   答え合わせ：つながったとき・10秒おきに、Render の非表示の一覧と見比べて直す
//
// 【送り出し】設置スマホの回答を Render にも届ける（3-3）
//   送り箱：まだ届いていない回答（Render での番号がまだない回答）
//   回答が来たとき・つながったとき・10秒おきに、送り箱の中身を古い順に送る
//   ネットが切れていたら送り箱で待たせておき、つながったら送る
// ------------------------------------------------------------
const { io: connectTo } = require("socket.io-client");
const { normalize } = require("./moderation");

const PATROL_MS = 10 * 1000; // 見回り・送り直しの間隔（10秒）
const OVERLAP = 20; // しおりの少し手前から読み直す件数（追い越し対策）
const PAGE = 100; // 窓口が1回に渡してくれる最大件数

function startSync({ store, remoteUrl, token, onNew, onHiddenChange }) {
    // 住所の最後の「/」は取っておく（付いていると「//api/...」になって 404 になるため）
    remoteUrl = remoteUrl.replace(/\/+$/, "");

    // ============================================================
    // 受け取り
    // ============================================================
    let pulling = false; // 今、取りに行っている最中か
    let pullAgain = false; // 最中にもう一度呼ばれたか

    // 受け取った回答を1件保存して、新しければモニターに出す
    async function save(a) {
        // すでに受け取った番号・自分が送った回答なら null が返る（二重表示しない）
        const row = await store.addRemote({
            remoteId: a.id,
            topicId: Number.isInteger(a.topicId) ? a.topicId : null,
            topic: a.topic || "",
            answer: a.answer,
            norm: normalize(a.answer),
            hidden: a.hidden === true,
            createdAt: a.createdAt || new Date().toISOString(),
            syncKey: typeof a.syncKey === "string" ? a.syncKey : null,
        });
        if (row) {
            console.log("同期: 受け取り", a.id, "/", a.answer);
            if (!row.hidden) onNew(row); // 非表示の回答はモニターに出さない
        }
    }

    // 窓口へ取りに行く
    async function pull() {
        if (pulling) {
            pullAgain = true; // 今の分が終わったらもう一度行く
            return;
        }
        pulling = true;
        try {
            do {
                pullAgain = false;

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
                if (data.answers.length >= PAGE) pullAgain = true;
            } while (pullAgain);
        } catch (err) {
            console.error("同期: 取りに行けませんでした:", err.message);
        } finally {
            pulling = false;
        }
    }

    // ============================================================
    // 非表示の反映
    // ============================================================
    let checking = false; // 今、答え合わせの最中か
    let checkAgain = false; // 最中にもう一度呼ばれたか
    let hiddenWarned = false; // 「窓口がない」を何度も出さないため

    function announce(row) {
        console.log(row.hidden ? "同期: 非表示にしました" : "同期: 再表示しました", "/", row.answer);
        onHiddenChange(row);
    }

    // 呼び鈴で知らせが来たとき：その1件だけすぐ直す
    async function applyHidden(remoteId, hidden) {
        const row = await store.setHiddenByRemote(remoteId, hidden);
        if (row) announce(row);
    }

    // 答え合わせ：Render の非表示の一覧を取ってきて、食い違いを全部直す
    async function checkHidden() {
        if (checking) {
            checkAgain = true;
            return;
        }
        checking = true;
        try {
            do {
                checkAgain = false;
                const res = await fetch(`${remoteUrl}/api/sync/hidden`, {
                    headers: { "x-sync-token": token },
                    signal: AbortSignal.timeout(10 * 1000),
                });
                if (!res.ok) {
                    if (!hiddenWarned) {
                        console.error("同期: 非表示の一覧をもらえませんでした", res.status);
                        hiddenWarned = true;
                    }
                    break;
                }
                hiddenWarned = false;
                const data = await res.json();
                const changed = await store.syncHidden(data.ids || []);
                changed.forEach(announce);
            } while (checkAgain);
        } catch (err) {
            // ネットが切れているときは、受け取り側でもう知らせているので黙っておく
        } finally {
            checking = false;
        }
    }

    // ============================================================
    // 送り出し
    // ============================================================
    let pushing = false; // 今、送っている最中か
    let pushAgain = false; // 最中にもう一度呼ばれたか
    let lastWaiting = 0; // 送り箱で待っている件数（ログを出しすぎないため）

    // 1件送る。返事：
    //   "sent"   … 届いた（送り箱から出す）
    //   "failed" … 断られた。送り直しても無駄（禁止用語など）
    //   "retry"  … ネットが切れている・Render の不調など。あとで送り直す
    async function sendOne(row) {
        let res;
        try {
            res = await fetch(`${remoteUrl}/api/sync/answers`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-sync-token": token,
                },
                body: JSON.stringify({
                    syncKey: row.syncKey,
                    topicId: row.topicId,
                    topic: row.topic,
                    answer: row.answer,
                    createdAt: row.createdAt,
                }),
                signal: AbortSignal.timeout(10 * 1000),
            });
        } catch (err) {
            return { result: "retry", message: err.message };
        }

        if (res.ok) {
            const data = await res.json().catch(() => null);
            if (data && data.ok && Number.isInteger(data.id)) {
                return { result: "sent", id: data.id };
            }
            return { result: "retry", message: "返事の形がおかしい" };
        }
        // 400（中身がおかしい）・422（禁止用語）は、何度送っても同じなのであきらめる
        if (res.status === 400 || res.status === 422) {
            const data = await res.json().catch(() => null);
            return { result: "failed", reason: (data && data.reason) || String(res.status) };
        }
        // 401（合言葉違い）・5xx（Render の不調）などは、あとで送り直す
        return { result: "retry", message: `Render の返事 ${res.status}` };
    }

    // 送り箱の中身を古い順に送る
    async function push() {
        if (pushing) {
            pushAgain = true;
            return;
        }
        pushing = true;
        try {
            do {
                pushAgain = false;
                const rows = await store.listUnsent(20);

                for (const row of rows) {
                    const r = await sendOne(row);
                    if (r.result === "sent") {
                        store.markSent(row.syncKey, r.id);
                        console.log("同期: Render に送りました", r.id, "/", row.answer);
                    } else if (r.result === "failed") {
                        await store.markFailed(row.syncKey, r.reason);
                        console.error("同期: Render に断られたので送るのをやめます:", r.reason, "/", row.answer);
                    } else {
                        // 1件目で失敗したら、残りも今は届かないので次の機会に回す
                        const waiting = (await store.listUnsent(1000)).length;
                        if (waiting !== lastWaiting) {
                            console.error(`同期: 今は送れません（${r.message}）。送り箱で待っています: ${waiting}件`);
                            lastWaiting = waiting;
                        }
                        return;
                    }
                }
                lastWaiting = 0;

                // 20件ぴったりなら、まだ残っているかもしれないのでもう一度
                if (rows.length >= 20) pushAgain = true;
            } while (pushAgain);
        } catch (err) {
            console.error("同期: 送り出しでエラー:", err.message);
        } finally {
            pushing = false;
        }
    }

    // ============================================================
    // 呼び鈴（Render とつなぎっぱなし）
    // ============================================================
    const socket = connectTo(remoteUrl, { reconnectionDelayMax: 5000 });
    socket.on("connect", () => {
        console.log("同期: Render とつながりました");
        pull(); // つながった（つながり直した）ら、すぐ取りに行く
        push(); // 送り箱に待っている回答があれば送る
        checkHidden(); // 切れている間に非表示が変わっていないか答え合わせ
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

    // Render で非表示にされた（中身は Render での番号）
    socket.on("answerRemoved", async (data) => {
        try {
            if (data && Number.isInteger(data.id)) await applyHidden(data.id, true);
        } catch (err) {
            console.error("同期: 非表示にできませんでした:", err.message);
        }
        checkHidden();
    });
    // Render で再表示にされた（番号がついていればその1件、なければ答え合わせだけ）
    socket.on("answersChanged", async (data) => {
        try {
            if (data && Number.isInteger(data.id) && data.hidden === false) {
                await applyHidden(data.id, false);
            }
        } catch (err) {
            console.error("同期: 再表示にできませんでした:", err.message);
        }
        checkHidden();
    });

    // 見回り（受け取り・答え合わせ）と送り直し
    setInterval(() => {
        pull();
        push();
        checkHidden();
    }, PATROL_MS);

    // server.js から「今すぐ送って」と頼めるようにする
    return { sendNow: push };
}

module.exports = { startSync };
