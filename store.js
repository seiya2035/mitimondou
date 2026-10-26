// 回答の保存先
//   DATABASE_URL があれば PostgreSQL（Render 本番）
//   なければメモリ（手元での開発用。サーバーを止めると消えます）

function createStore(databaseUrl) {
    return databaseUrl ? createPgStore(databaseUrl) : createMemoryStore();
}

// ------------------------------------------------------------
// メモリ版
// ------------------------------------------------------------
function createMemoryStore() {
    let rows = [];
    let seq = 0;

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

        // 新しい順に返す
        async list({ includeHidden = false, limit = 500 } = {}) {
            return rows
                .filter((r) => includeHidden || !r.hidden)
                .slice(-limit)
                .reverse();
        },

        async setHidden(id, hidden) {
            const row = rows.find((r) => r.id === id);
            if (!row) return null;
            row.hidden = hidden;
            return row;
        },

        async reset() {
            rows = [];
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

        async setHidden(id, hidden) {
            const result = await pool.query(
                `UPDATE answers SET hidden = $2 WHERE id = $1 RETURNING *`,
                [id, hidden]
            );
            return result.rows[0] ? toRow(result.rows[0]) : null;
        },

        async reset() {
            await pool.query(`TRUNCATE answers RESTART IDENTITY`);
        },
    };
}

module.exports = { createStore };
