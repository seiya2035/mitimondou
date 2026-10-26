// 禁止用語チェックと、同じ端末からの同じ回答の判定をまとめたファイル
const fs = require("fs");
const path = require("path");

// ------------------------------------------------------------
// 1. 文字のゆれをそろえる（正規化）
//   「バカ」「ﾊﾞｶ」「ば か」「ば・か」などを、すべて「ばか」として扱う
// ------------------------------------------------------------
function normalize(text) {
    return String(text ?? "")
        .normalize("NFKC")                     // 全角英数・半角カナなどをそろえる
        .toLowerCase()                         // 英字を小文字に
        .replace(/[\u30a1-\u30f6]/g, (c) =>    // カタカナ → ひらがな
            String.fromCharCode(c.charCodeAt(0) - 0x60))
        .replace(/[\s\p{P}\p{S}]/gu, "");      // 空白・記号・絵文字を取り除く
}

// ------------------------------------------------------------
// 2. 禁止用語リストの読み込み
//   ng-words.txt  … 禁止したい言葉（1行に1つ）
//   ok-words.txt  … 禁止用語を含むけど許可したい言葉（1行に1つ）
//   # で始まる行と空行は無視する
// ------------------------------------------------------------
function loadList(fileName) {
    const file = path.join(__dirname, fileName);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map(normalize)
        .filter(Boolean);
}

const ngWords = loadList("ng-words.txt");
const okWords = loadList("ok-words.txt");
console.log(`禁止用語 ${ngWords.length} 件、許可用語 ${okWords.length} 件を読み込みました`);

// 禁止用語が含まれていたら true
function containsNgWord(text) {
    let n = normalize(text);
    // 許可用語の部分を先に取り除いてからチェックする
    for (const ok of okWords) n = n.split(ok).join("");
    return ngWords.some((ng) => n.includes(ng));
}

// ------------------------------------------------------------
// 3. 同じ端末からの同じ回答の判定
//   「端末ID ＋ お題 ＋ 正規化した回答」の組み合わせで覚えておく
//   別の端末なら同じ回答でも通る
// ------------------------------------------------------------
const sentKeys = new Set();

function makeKey(deviceId, topicId, text) {
    return `${deviceId}|${topicId ?? ""}|${normalize(text)}`;
}

// この端末がすでに同じお題に同じ回答を送っていたら true
function isRepeated(deviceId, topicId, text) {
    if (!deviceId) return false; // 端末IDがない古い画面からの送信はチェックしない
    return sentKeys.has(makeKey(deviceId, topicId, text));
}

// 送信できた回答を覚える
function remember(deviceId, topicId, text) {
    if (!deviceId) return;
    sentKeys.add(makeKey(deviceId, topicId, text));
}

module.exports = { normalize, containsNgWord, isRepeated, remember };
