// ------------------------------------------------------------
// QRコードを作る道具（外部サービスは使わず、このMacの中だけで作る）
//
//   使い方：npm run make-qr
//
//   できるもの（qr フォルダの中）
//     qr-1.png 〜 qr-12.png … お題ごとのQRコード画像
//     print.html            … 印刷用ページ（1枚に1つ、番号とお題付き）
//
//   住所を変えたいとき（例：練習でローカルを使う）
//     QR_BASE_URL=http://192.168.0.10:3000 npm run make-qr
// ------------------------------------------------------------
const fs = require("node:fs");
const path = require("node:path");
const QRCode = require("qrcode");
const topics = require("./topics");

const BASE_URL = (process.env.QR_BASE_URL || "https://mitimondou.onrender.com").replace(/\/+$/, "");
const OUT_DIR = path.join(__dirname, "qr");

// 読み取りやすさの設定
//   errorCorrectionLevel "M" … 少し汚れても読める（L < M < Q < H）
//   margin 4 … QRのまわりの白い余白（規格で推奨される幅）
const QR_OPTIONS = { errorCorrectionLevel: "M", margin: 4 };

// HTML に文字を入れるときの安全対策（< や & をそのまま入れない）
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const pages = [];

    for (let i = 0; i < topics.length; i++) {
        const number = i + 1; // 人が数える番号は1始まり
        const url = `${BASE_URL}/?q=${number}`;

        // 画像（PNG）：幅1000ピクセル。大きく印刷してもぼやけにくい
        await QRCode.toFile(path.join(OUT_DIR, `qr-${number}.png`), url, {
            ...QR_OPTIONS,
            width: 1000,
        });

        // 印刷用ページ用（SVG）：拡大しても線がにじまない形式
        const svg = await QRCode.toString(url, { ...QR_OPTIONS, type: "svg" });

        pages.push(`
    <section class="page">
        <p class="number">${number}</p>
        <div class="qr">${svg}</div>
        <p class="topic">${escapeHtml(topics[i])}</p>
        <p class="url">${escapeHtml(url)}</p>
    </section>`);

        console.log(`${number}: ${url}`);
    }

    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>未知問答 QRコード</title>
<style>
    @page { size: A4 portrait; margin: 15mm; }
    body { margin: 0; font-family: sans-serif; color: #000; background: #fff; }
    .page {
        box-sizing: border-box;
        height: 267mm;            /* A4 の高さ 297mm − 上下の余白 */
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6mm;
        page-break-after: always;
        break-after: page;
        text-align: center;
    }
    .page:last-child { page-break-after: auto; break-after: auto; }
    .number { font-size: 28pt; font-weight: bold; margin: 0; }
    .qr svg { width: 150mm; height: 150mm; display: block; }
    .topic { font-size: 20pt; margin: 0 10mm; line-height: 1.5; }
    .url { font-size: 10pt; color: #555; margin: 0; }
    @media screen {
        body { background: #ccc; padding: 10px; }
        .page { background: #fff; width: 180mm; margin: 0 auto 10px; }
    }
</style>
</head>
<body>${pages.join("")}
</body>
</html>
`;
    fs.writeFileSync(path.join(OUT_DIR, "print.html"), html);

    console.log("");
    console.log(`できました：qr フォルダに ${topics.length} 枚の画像と print.html を作りました`);
    console.log("印刷する前に、スマホで何枚か読み取ってお題が合っているか確かめてください");
}

main().catch((err) => {
    console.error("QRコードを作れませんでした:", err.message);
    process.exit(1);
});
