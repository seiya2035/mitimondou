// 回答の保存先
//   DATABASE_URL があれば PostgreSQL（Render 本番）
//   SQLITE_PATH があれば SQLite（予備ローカル。ファイルに保存）
//   どちらもなければメモリ（手元での開発用。サーバーを止めると消えます）

// 世代番号（帳簿を作り直すたびに変わる、ランダムな文字）
function newEpoch() {
    return require("crypto").randomUUID();
}

function createStore({ databaseUrl, sqlitePath } = {}) {
    if (databaseUrl) return createPgStore(databaseUrl);
    if (sqlitePath) return createSqliteStore(sqlitePath);
    return createMemoryStore();
}

// ------------------------------------------------------------
// メモリ版
// ------------------------------------------------------------
function createMemoryStore() {
    let rows = [];
    let seq = 0;
    let epoch = newEpoch(); // 帳簿の世代番号

    return {
        kind: "メモリ（再起動で消えます）",

        async init() {},

        // 同じ端末・同じお題・同じ回答がすでにあれば null を返す
        async add({ topicId, topic, answer, deviceId, norm }) {
            const dup =
                deviceId &&
                rows.some(
                    (r) =>
                        r.deviceId === deviceId &&
                        r.topicId === topicId &&
                        r.norm === norm
                );
            if (dup) return null;
            const row = {
                id: ++seq,
                topicId,
                topic,
                answer,
                deviceId,
                norm,
                hidden: false,
                createdAt: new Date().toISOString(),
            };
            rows.push(row);
            return row;
        },

        // 予備ローカルから届いた設置スマホの回答を保存する
        // 同じ送り状番号（syncKey）がすでにあれば保存せず、そちらを返す
        async addFromLocal({ syncKey, topicId, topic, answer, norm, createdAt, hidden = false }) {
            const found = rows.find((r) => r.syncKey === syncKey);
            if (found) return { row: found, created: false };
            const row = {
                id: ++seq,
                topicId,
                topic,
                answer,
                deviceId: "",
                norm,
                syncKey,
                hidden,
                createdAt,
            };
            rows.push(row);
            return { row, created: true };
        },

        // 新しい順に返す
        async list({ includeHidden = false, limit = 500 } = {}) {
            return rows
                .filter((r) => includeHidden || !r.hidden)
                .slice(-limit)
                .reverse();
        },

        // ○番より後の回答を古い順に返す（予備ローカルが取りに来る用）
        async listAfter(afterId, limit = 100) {
            return rows.filter((r) => r.id > afterId).slice(0, limit);
        },

        async setHidden(id, hidden) {
            const row = rows.find((r) => r.id === id);
            if (!row) return null;
            row.hidden = hidden;
            return row;
        },

        // 非表示になっている回答の番号の一覧（予備ローカルとの答え合わせ用）
        async listHiddenIds() {
            return rows.filter((r) => r.hidden).map((r) => r.id);
        },

        // 帳簿の世代番号（予備ローカルが「リセットされたか」に気づくため）
        async getEpoch() {
            return epoch;
        },

        async reset() {
            rows = [];
            seq = 0; // 番号も 1 からやり直す（本番と同じ動きにする）
            epoch = newEpoch();
        },
    };
}

// ------------------------------------------------------------
// PostgreSQL 版
// ------------------------------------------------------------
function createPgStore(databaseUrl) {
    const { Pool } = require("pg");
    const pool = new Pool({
        connectionString: databaseUrl,
        // Internal URL（Render 内部）は SSL 不要、External URL は SSL 必須
        ssl: databaseUrl.includes("render.com")
            ? { rejectUnauthorized: false }
            : false,
    });
    pool.on("error", (err) => console.error("DB接続エラー:", err));

    const toRow = (r) => ({
        id: Number(r.id),
        topicId: r.topic_id,
        topic: r.topic,
        answer: r.answer,
        deviceId: r.device_id,
        syncKey: r.sync_key,
        hidden: r.hidden,
        createdAt: r.created_at,
    });

    return {
        kind: "PostgreSQL",

        async init() {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS answers (
                    id         BIGSERIAL PRIMARY KEY,
                    topic_id   INTEGER,
                    topic      TEXT NOT NULL DEFAULT '',
                    answer     TEXT NOT NULL,
                    device_id  TEXT NOT NULL DEFAULT '',
                    norm       TEXT NOT NULL DEFAULT '',
                    hidden     BOOLEAN NOT NULL DEFAULT false,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            `);
            // 同じ端末・同じお題・同じ回答は1回だけ保存できるようにする
            await pool.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS answers_same_device
                ON answers (device_id, topic_id, norm)
                WHERE device_id <> ''
            `);

            // 送り状番号の欄（予備ローカルから届いた設置スマホの回答だけに入る）
            // 前からあるデータベースにも、なければ後から足す
            await pool.query(`ALTER TABLE answers ADD COLUMN IF NOT EXISTS sync_key TEXT`);
            // 同じ送り状番号は1回だけ保存できるようにする（送り直しで二重にならない）
            await pool.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS answers_sync_key
                ON answers (sync_key)
                WHERE sync_key IS NOT NULL
            `);

            // 帳簿の世代番号をしまっておく小さな表（なければ作って、最初の番号を入れる）
            await pool.query(`
                CREATE TABLE IF NOT EXISTS sync_meta (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            `);
            await pool.query(
                `INSERT INTO sync_meta (key, value) VALUES ('epoch', $1)
                 ON CONFLICT (key) DO NOTHING`,
                [newEpoch()]
            );
        },

        // 帳簿の世代番号（予備ローカルが「リセットされたか」に気づくため）
        async getEpoch() {
            const result = await pool.query(
                `SELECT value FROM sync_meta WHERE key = 'epoch'`
            );
            return result.rows[0] ? result.rows[0].value : "";
        },

        // 予備ローカルから届いた設置スマホの回答を保存する
        // 同じ送り状番号（syncKey）がすでにあれば保存せず、そちらを返す
        async addFromLocal({ syncKey, topicId, topic, answer, norm, createdAt, hidden = false }) {
            const inserted = await pool.query(
                `INSERT INTO answers (sync_key, topic_id, topic, answer, norm, created_at, hidden)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (sync_key) WHERE sync_key IS NOT NULL DO NOTHING
                 RETURNING *`,
                [syncKey, topicId, topic, answer, norm, createdAt, hidden]
            );
            if (inserted.rows[0]) return { row: toRow(inserted.rows[0]), created: true };

            const found = await pool.query(
                `SELECT * FROM answers WHERE sync_key = $1`,
                [syncKey]
            );
            return { row: toRow(found.rows[0]), created: false };
        },

        async add({ topicId, topic, answer, deviceId, norm }) {
            const result = await pool.query(
                `INSERT INTO answers (topic_id, topic, answer, device_id, norm)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (device_id, topic_id, norm) WHERE device_id <> '' DO NOTHING
                 RETURNING *`,
                [topicId, topic, answer, deviceId, norm]
            );
            return result.rows[0] ? toRow(result.rows[0]) : null;
        },

        async list({ includeHidden = false, limit = 500 } = {}) {
            const result = await pool.query(
                `SELECT * FROM answers
                 WHERE $1 OR NOT hidden
                 ORDER BY id DESC
                 LIMIT $2`,
                [includeHidden, limit]
            );
            return result.rows.map(toRow);
        },

        // ○番より後の回答を古い順に返す（予備ローカルが取りに来る用）
        async listAfter(afterId, limit = 100) {
            const result = await pool.query(
                `SELECT * FROM answers
                 WHERE id > $1
                 ORDER BY id ASC
                 LIMIT $2`,
                [afterId, limit]
            );
            return result.rows.map(toRow);
        },

        async setHidden(id, hidden) {
            const result = await pool.query(
                `UPDATE answers SET hidden = $2 WHERE id = $1 RETURNING *`,
                [id, hidden]
            );
            return result.rows[0] ? toRow(result.rows[0]) : null;
        },

        // 非表示になっている回答の番号の一覧（予備ローカルとの答え合わせ用）
        async listHiddenIds() {
            const result = await pool.query(
                `SELECT id FROM answers WHERE hidden ORDER BY id`
            );
            return result.rows.map((r) => Number(r.id));
        },

        async reset() {
            await pool.query(`TRUNCATE answers RESTART IDENTITY`);
            // 帳簿を作り直したので、世代番号も新しくする
            await pool.query(
                `UPDATE sync_meta SET value = $1 WHERE key = 'epoch'`,
                [newEpoch()]
            );
        },
    };
}

// ------------------------------------------------------------
// SQLite 版（予備ローカル用。ファイルに保存するので再起動しても消えない）
// ------------------------------------------------------------
function createSqliteStore(filePath) {
    const fs = require("fs");
    const path = require("path");
    const { DatabaseSync } = require("node:sqlite");

    // 保存先のフォルダがなければ作る
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const db = new DatabaseSync(filePath);

    const toRow = (r) => ({
        id: Number(r.id),
        topicId: r.topic_id,
        topic: r.topic,
        answer: r.answer,
        deviceId: r.device_id,
        hidden: r.hidden === 1,
        createdAt: r.created_at,
        remoteId: r.remote_id == null ? null : Number(r.remote_id),
        syncKey: r.sync_key,
        sendError: r.send_error,
        hiddenPending: r.hidden_pending === 1,
    });

    return {
        kind: `SQLite（${filePath}）`,

        async init() {
            // 書き込み途中で電源が落ちても壊れにくくする設定
            db.exec("PRAGMA journal_mode = WAL");
            db.exec(`
                CREATE TABLE IF NOT EXISTS answers (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    topic_id   INTEGER,
                    topic      TEXT NOT NULL DEFAULT '',
                    answer     TEXT NOT NULL,
                    device_id  TEXT NOT NULL DEFAULT '',
                    norm       TEXT NOT NULL DEFAULT '',
                    hidden     INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                )
            `);
            // 同じ端末・同じお題・同じ回答は1回だけ保存できるようにする
            db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS answers_same_device
                ON answers (device_id, topic_id, norm)
                WHERE device_id <> ''
            `);

            // Render での番号を書く欄（Render から受け取った回答だけに入る）
            // 前からあるデータベースにも、なければ後から足す
            const columns = db
                .prepare("PRAGMA table_info(answers)")
                .all()
                .map((c) => c.name);
            if (!columns.includes("remote_id")) {
                db.exec("ALTER TABLE answers ADD COLUMN remote_id INTEGER");
            }
            // 送り状番号の欄（設置スマホの回答に付ける。Render に送るときの目印）
            if (!columns.includes("sync_key")) {
                db.exec("ALTER TABLE answers ADD COLUMN sync_key TEXT");
            }
            // Render に断られて、もう送らないことにした理由（段階6で確認する用）
            if (!columns.includes("send_error")) {
                db.exec("ALTER TABLE answers ADD COLUMN send_error TEXT");
            }
            // 「本番に連絡待ち」の付箋（ローカルの管理ページで非表示を変えたとき 1）
            if (!columns.includes("hidden_pending")) {
                db.exec("ALTER TABLE answers ADD COLUMN hidden_pending INTEGER NOT NULL DEFAULT 0");
            }
            // 同じ Render の番号は1回だけ保存できるようにする（二重表示を防ぐ）
            db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS answers_remote
                ON answers (remote_id)
                WHERE remote_id IS NOT NULL
            `);
            // 同じ送り状番号は1回だけ保存できるようにする
            db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS answers_sync_key
                ON answers (sync_key)
                WHERE sync_key IS NOT NULL
            `);

            // メモ用の小さな表（Render の帳簿の世代番号を覚えておく）
            db.exec(`
                CREATE TABLE IF NOT EXISTS sync_meta (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            `);
        },

        // メモを読む・書く
        getMeta(key) {
            const r = db.prepare("SELECT value FROM sync_meta WHERE key = ?").get(key);
            return r ? r.value : "";
        },
        setMeta(key, value) {
            db.prepare(
                `INSERT INTO sync_meta (key, value) VALUES (?, ?)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value`
            ).run(key, value);
        },

        // Render がリセットされたときの作り直し
        //   Render から来た回答・Render に届いた回答（remote_id がある）と、
        //   断られた回答は消す。まだ送れていない設置スマホの回答だけ送り箱に残す
        async resetFromRemote() {
            const r = db
                .prepare(
                    `DELETE FROM answers
                     WHERE NOT (remote_id IS NULL AND sync_key IS NOT NULL AND send_error IS NULL)`
                )
                .run();
            return Number(r.changes);
        },

        // Render から受け取った回答を保存する。すでにあれば null を返す
        async addRemote({
            remoteId,
            topicId,
            topic,
            answer,
            norm,
            hidden,
            createdAt,
            syncKey,
        }) {
            // 送り状番号つき＝もともと設置スマホの回答
            // 手元に同じ送り状番号があれば、それは自分が送った回答が戻ってきたもの
            // → 新しく保存せず、Render での番号を書き込むだけ（二重表示を防ぐ）
            if (syncKey) {
                const mine = db
                    .prepare("SELECT * FROM answers WHERE sync_key = ?")
                    .get(syncKey);
                if (mine) {
                    if (mine.remote_id == null) this.markSent(syncKey, remoteId);
                    return null;
                }
            }

            const r = db
                .prepare(
                    `INSERT INTO answers (remote_id, sync_key, topic_id, topic, answer, norm, hidden, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT DO NOTHING
                     RETURNING *`
                )
                .get(
                    remoteId,
                    syncKey || null,
                    topicId,
                    topic,
                    answer,
                    norm,
                    hidden ? 1 : 0,
                    createdAt
                );
            return r ? toRow(r) : null;
        },

        // 設置スマホの回答を保存する（交代で使うので、端末の重複チェックはしない）
        // 送り状番号を付けておき、あとで Render に送る
        async addKiosk({ syncKey, topicId, topic, answer, norm }) {
            const r = db
                .prepare(
                    `INSERT INTO answers (sync_key, topic_id, topic, answer, norm, created_at)
                     VALUES (?, ?, ?, ?, ?, ?)
                     RETURNING *`
                )
                .get(syncKey, topicId, topic, answer, norm, new Date().toISOString());
            return toRow(r);
        },

        // 送り箱：まだ Render に届いていない設置スマホの回答（古い順）
        async listUnsent(limit = 20) {
            return db
                .prepare(
                    `SELECT * FROM answers
                     WHERE sync_key IS NOT NULL
                       AND remote_id IS NULL
                       AND send_error IS NULL
                     ORDER BY id ASC
                     LIMIT ?`
                )
                .all(limit)
                .map(toRow);
        },

        // Render に届いた：Render での番号を書き込む（これで送り箱から出る）
        markSent(syncKey, remoteId) {
            try {
                db.prepare(
                    `UPDATE answers SET remote_id = ?
                     WHERE sync_key = ? AND remote_id IS NULL`
                ).run(remoteId, syncKey);
            } catch (err) {
                // 同じ Render 番号がすでに別の行にあるなど。送り直しは不要なので記録だけ
                console.error("同期: 送信済みの印を付けられませんでした:", err.message);
            }
        },

        // Render に断られた（禁止用語など）：送り直しても無駄なので送り箱から出す
        async markFailed(syncKey, reason) {
            db.prepare(
                `UPDATE answers SET send_error = ? WHERE sync_key = ?`
            ).run(String(reason).slice(0, 100), syncKey);
        },

        // Render の何番まで受け取ったか（しおり）。まだ1件もなければ 0
        async maxRemoteId() {
            const r = db
                .prepare("SELECT MAX(remote_id) AS m FROM answers")
                .get();
            return r && r.m ? Number(r.m) : 0;
        },

        async add({ topicId, topic, answer, deviceId, norm }) {
            const r = db
                .prepare(
                    `INSERT INTO answers (topic_id, topic, answer, device_id, norm, created_at)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT DO NOTHING
                     RETURNING *`
                )
                .get(
                    topicId,
                    topic,
                    answer,
                    deviceId,
                    norm,
                    new Date().toISOString()
                );
            return r ? toRow(r) : null;
        },

        async list({ includeHidden = false, limit = 500 } = {}) {
            return db
                .prepare(
                    `SELECT * FROM answers
                     WHERE ? OR hidden = 0
                     ORDER BY id DESC
                     LIMIT ?`
                )
                .all(includeHidden ? 1 : 0, limit)
                .map(toRow);
        },

        // ○番より後の回答を古い順に返す（予備ローカルが取りに来る用）
        async listAfter(afterId, limit = 100) {
            return db
                .prepare(
                    `SELECT * FROM answers
                     WHERE id > ?
                     ORDER BY id ASC
                     LIMIT ?`
                )
                .all(afterId, limit)
                .map(toRow);
        },

        async setHidden(id, hidden) {
            const r = db
                .prepare(
                    `UPDATE answers SET hidden = ? WHERE id = ? RETURNING *`
                )
                .get(hidden ? 1 : 0, id);
            return r ? toRow(r) : null;
        },

        // 非表示になっている回答の番号の一覧
        async listHiddenIds() {
            return db
                .prepare("SELECT id FROM answers WHERE hidden = 1 ORDER BY id")
                .all()
                .map((r) => Number(r.id));
        },

        // Render の非表示の一覧に合わせる（答え合わせ）
        //   hiddenRemoteIds … Render で非表示になっている回答の番号（Render での番号）
        //   Render から受け取った回答（remote_id がある回答）だけを見て、
        //   食い違っているものを直す。直した回答の一覧を返す
        async syncHidden(hiddenRemoteIds) {
            const hiddenSet = new Set(hiddenRemoteIds);
            const rows = db
                .prepare("SELECT * FROM answers WHERE remote_id IS NOT NULL")
                .all();
            const update = db.prepare("UPDATE answers SET hidden = ? WHERE id = ? RETURNING *");

            const changed = [];
            for (const r of rows) {
                // 「本番に連絡待ち」の付箋がある回答は、こちらの操作が正しいので直さない
                if (r.hidden_pending === 1) continue;
                const shouldHide = hiddenSet.has(Number(r.remote_id));
                const isHidden = r.hidden === 1;
                if (shouldHide !== isHidden) {
                    changed.push(toRow(update.get(shouldHide ? 1 : 0, r.id)));
                }
            }
            return changed;
        },

        // Render の番号で1件だけ非表示 / 再表示にする（呼び鈴で知らせが来たとき用）
        // 変わったときだけ、その回答を返す
        async setHiddenByRemote(remoteId, hidden) {
            const r = db
                .prepare(
                    `UPDATE answers SET hidden = ?
                     WHERE remote_id = ? AND hidden <> ? AND hidden_pending = 0
                     RETURNING *`
                )
                .get(hidden ? 1 : 0, remoteId, hidden ? 1 : 0);
            return r ? toRow(r) : null;
        },

        // ローカルの管理ページで非表示 / 元に戻すをしたとき（予備ローカル用）
        // 本番に伝える必要がある回答には「本番に連絡待ち」の付箋を貼る
        //   本番の番号がある回答、またはこれから送る設置スマホの回答が対象
        async setHiddenLocal(id, hidden) {
            const r = db
                .prepare(
                    `UPDATE answers
                     SET hidden = ?,
                         hidden_pending = CASE
                             WHEN remote_id IS NOT NULL THEN 1
                             WHEN sync_key IS NOT NULL AND send_error IS NULL THEN 1
                             ELSE 0
                         END
                     WHERE id = ?
                     RETURNING *`
                )
                .get(hidden ? 1 : 0, id);
            return r ? toRow(r) : null;
        },

        // 付箋が貼ってあって、本番の番号がある回答（本番に伝えに行く分）
        async listPendingHidden(limit = 20) {
            return db
                .prepare(
                    `SELECT * FROM answers
                     WHERE hidden_pending = 1 AND remote_id IS NOT NULL
                     ORDER BY id ASC
                     LIMIT ?`
                )
                .all(limit)
                .map(toRow);
        },

        // 本番に伝わったので付箋をはがす（伝えている間にまた変わっていたら、はがさない）
        clearPending(id, hidden) {
            db.prepare(
                `UPDATE answers SET hidden_pending = 0 WHERE id = ? AND hidden = ?`
            ).run(id, hidden ? 1 : 0);
        },

        async reset() {
            db.exec(`DELETE FROM answers`);
            // 番号も 1 からやり直す（PostgreSQL 版の RESTART IDENTITY と同じ）
            db.exec(`DELETE FROM sqlite_sequence WHERE name = 'answers'`);
        },
    };
}

module.exports = { createStore };
