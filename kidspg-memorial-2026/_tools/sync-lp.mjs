#!/usr/bin/env node
/**
 * 案内ページ（LP）の同期
 * ------------------------------------------------------------------
 * LP は 02_release と 03_release の2つに置いてあるが、
 * **違うのは2か所だけ**なので、正本を1つにして片方を自動生成する。
 *
 *   正本   : 03_release/2026-gummy-memorial.html   ← ここだけ直す
 *   生成物 : 02_release/2026-gummy-memorial.html   ← 触らない（上書きされる）
 *
 * 差分は次の2か所。どちらもHTMLコメントのマーカーで囲んである。
 *
 *   @@TOC_ALBUM_START@@ … @@TOC_ALBUM_END@@
 *       目次の「メモリアルカードのアルバムを見る」の行。02版では削除する。
 *   @@MEMORIAL_START@@ … @@MEMORIAL_END@@
 *       カードの節。02版では _src/memorial-preparing.html に差し替える。
 *
 * 使い方:
 *   node _tools/sync-lp.mjs             … 02_release を作り直す
 *   node _tools/sync-lp.mjs --check     … 書き換えずに、ずれているかだけ見る
 *
 * ⚠ 02_release/2026-gummy-memorial.html を手で直しても、次の実行で消えます。
 *    直すのは必ず 03_release 側にしてください。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const SRC = join(ROOT, "03_release", "2026-gummy-memorial.html");
const DST = join(ROOT, "02_release", "2026-gummy-memorial.html");
const PREPARING = join(ROOT, "_src", "memorial-preparing.html");

const CHECK = process.argv.includes("--check");

/** マーカーで囲まれた範囲を body に差し替える（body が null なら範囲ごと削除） */
function swap(html, name, body) {
  const open = `<!-- @@${name}_START@@`;
  const close = `<!-- @@${name}_END@@ -->`;

  const a = html.indexOf(open);
  if (a === -1) { throw new Error(`マーカーが無い: @@${name}_START@@`); }
  const b = html.indexOf(close, a);
  if (b === -1) { throw new Error(`マーカーが閉じていない: @@${name}_END@@`); }

  // 開始マーカーは同じ行で終わる（コメント内に説明文を書いているため）
  const openEnd = html.indexOf("-->", a);
  if (openEnd === -1 || openEnd > b) { throw new Error(`@@${name}_START@@ のコメントが閉じていない`); }

  // 行ごと消せるように、前の改行から後ろの改行までを対象にする
  let from = html.lastIndexOf("\n", a);
  from = from === -1 ? 0 : from + 1;
  let to = html.indexOf("\n", b + close.length);
  to = to === -1 ? html.length : to + 1;

  return html.slice(0, from) + (body === null ? "" : body) + html.slice(to);
}

for (const [p, label] of [[SRC, "正本"], [PREPARING, "準備中版の節"]]) {
  if (!existsSync(p)) { throw new Error(`${label}が見つかりません: ${p}`); }
}

const src = readFileSync(SRC, "utf8");
let preparing = readFileSync(PREPARING, "utf8");
if (!preparing.endsWith("\n")) { preparing += "\n"; }

let out = src;
out = swap(out, "TOC_ALBUM", null);        // 目次の行を削る
out = swap(out, "MEMORIAL", preparing);    // カードの節を差し替える

// 生成物にマーカーは残さない（残っていたら差し替え漏れ）
for (const m of ["TOC_ALBUM", "MEMORIAL"]) {
  if (out.includes(`@@${m}_`)) { throw new Error(`生成物に @@${m}_ が残っています`); }
}
// ギャラリーへの参照が残っていたら 02 版としては誤り（404になる）
if (out.includes("2026-memorial-gallery.html")) {
  throw new Error("生成物にギャラリーへのリンクが残っています（02版では404になります）");
}
if (out.includes('href="#album"')) {
  throw new Error("生成物に #album へのリンクが残っています");
}

const before = existsSync(DST) ? readFileSync(DST, "utf8") : "";
const same = before === out;

console.log("── 案内ページの同期 ──");
console.log("  正本  : 03_release/2026-gummy-memorial.html  (" + src.length + " B)");
console.log("  生成物: 02_release/2026-gummy-memorial.html  (" + out.length + " B)");

if (CHECK) {
  console.log(same ? "\n  ✅ 02_release は正本と同期しています。" : "\n  ⚠ 02_release が古くなっています。`node _tools/sync-lp.mjs` を実行してください。");
  process.exit(same ? 0 : 1);
}

if (same) {
  console.log("\n  変更なし（すでに同期済み）");
} else {
  writeFileSync(DST, out, "utf8");
  console.log("\n  02_release/2026-gummy-memorial.html を作り直しました");
}
