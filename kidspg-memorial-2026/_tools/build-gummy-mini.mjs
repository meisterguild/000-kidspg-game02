#!/usr/bin/env node
/**
 * スマホ版ミニゲーム（AIグミパク！ミニ）のビルド
 * ------------------------------------------------------------------
 * 1枚の HTML に、実機版と同じ three.js とタイトル画像を埋め込む。
 * CDN を読まない「完全自己完結の1ファイル」にするための手順。
 *
 *   正本   : _src/2026-gummy-mini.src.html      ← 直すのはここ
 *   生成物 : 03_release/2026-gummy-mini.html    ← 触らない（上書きされる）
 *
 * 埋め込むもの
 *   three .......... 会場用アプリ（../kidspg-game-2026）の node_modules から、
 *                    **使う部品だけ**を esbuild で束ねて minify（約510KB）。
 *                    版を実機版とそろえるため、そちらの three を使う。
 *   タイトル画像 ... 実機版の src/renderer/assets/images/title_gummy_01.png を
 *                    640px の WebP へ落としたもの（ImageMagick）。
 *                    一度作れば _src に残るので、次回からは magick が無くても通る。
 *   ファビコン ..... 案内ページ（03_release/2026-gummy-memorial.html）から借りる。
 *
 * 使い方:
 *   node _tools/build-gummy-mini.mjs            … 03_release へ書き出す
 *   node _tools/build-gummy-mini.mjs --debug    … 検証用のフックを残したまま作る
 *
 * 必要なもの（無いときは、その場で何が足りないか出して止まります）
 *   ・Node.js
 *   ・会場用アプリ ../kidspg-game-2026 に node_modules（three と esbuild）
 *   ・ImageMagick 7（初回だけ。WebP を作るため）
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/* three は会場用アプリの node_modules から取る（版を実機版とそろえるため）。
   この資材フォルダは 2 か所に置かれうるので、両方を順に探す。
     ・ローカル : 05_kidspg\202609\kidspg-memorial-2026  → 隣の kidspg-game-2026
     ・GitHub   : 000-kidspg-game02\kidspg-memorial-2026 → 親がそのままアプリ */
const GAME_CANDIDATES = [
  resolve(ROOT, "..", "kidspg-game-2026"),
  resolve(ROOT, ".."),
];
const GAME = GAME_CANDIDATES.find(
  (dir) => existsSync(join(dir, "node_modules", "three", "build", "three.module.js"))
) || GAME_CANDIDATES[0];

const SRC       = join(ROOT, "_src", "2026-gummy-mini.src.html");
const ENTRY     = join(ROOT, "_src", "gummy-mini-three-entry.js");
const TITLE_WEBP= join(ROOT, "_src", "gummy-mini-title.webp");
const LP        = join(ROOT, "03_release", "2026-gummy-memorial.html");
const OUT       = join(ROOT, "03_release", "2026-gummy-mini.html");

const KEEP_DEBUG = process.argv.includes("--debug");

const die = (msg) => { console.error("\n  ✗ " + msg + "\n"); process.exit(1); };

console.log("── スマホ版ミニゲームのビルド ──");

if (!existsSync(SRC)) die("正本が見つかりません: " + SRC);
if (!existsSync(ENTRY)) die("three の入口が見つかりません: " + ENTRY);
if (!existsSync(LP)) die("案内ページが見つかりません（ファビコンを借りています）: " + LP);

/* --- 1. three を束ねる --------------------------------------------- */
const threeModule = join(GAME, "node_modules", "three", "build", "three.module.js");
const esbuildBin  = join(GAME, "node_modules", "esbuild", "bin", "esbuild");
if (!existsSync(threeModule)) {
  die("three が見つかりません: " + threeModule + "\n    会場用アプリ側で `npm ci` を実行してください。");
}
if (!existsSync(esbuildBin)) {
  die("esbuild が見つかりません: " + esbuildBin + "\n    会場用アプリ側で `npm ci` を実行してください。");
}

const work = mkdtempSync(join(tmpdir(), "gummy-mini-"));
const bundlePath = join(work, "three-bundle.js");
try {
  execFileSync(process.execPath, [
    esbuildBin, ENTRY,
    "--bundle", "--minify", "--format=iife", "--target=es2019",
    "--legal-comments=none",
    "--alias:three=" + threeModule,
    "--outfile=" + bundlePath,
  ], { stdio: ["ignore", "ignore", "inherit"] });
} catch (e) {
  rmSync(work, { recursive: true, force: true });
  die("three の束ね直しに失敗しました");
}
let three = readFileSync(bundlePath, "utf8");
rmSync(work, { recursive: true, force: true });
// インライン <script> の中で終端に見える並びがあると、そこで切れてしまう
three = three.split("</script").join("<\\/script");
const threeVersion = JSON.parse(
  readFileSync(join(GAME, "node_modules", "three", "package.json"), "utf8")).version;
console.log("  three " + threeVersion + " : " + three.length.toLocaleString() + " 文字");

/* --- 2. タイトル画像 ------------------------------------------------ */
if (!existsSync(TITLE_WEBP)) {
  const png = join(GAME, "src", "renderer", "assets", "images", "title_gummy_01.png");
  if (!existsSync(png)) die("タイトル画像の原本がありません: " + png);
  try {
    execFileSync("magick", [png, "-resize", "640x", "-quality", "72",
                            "-define", "webp:method=6", TITLE_WEBP], { stdio: "inherit" });
  } catch (e) {
    die("ImageMagick（magick）が必要です。`magick -version` が通るか確かめてください。");
  }
  console.log("  タイトル画像を作りました: " + TITLE_WEBP);
}
const title = "data:image/webp;base64," + readFileSync(TITLE_WEBP).toString("base64");
console.log("  タイトル画像 : " + title.length.toLocaleString() + " 文字");

/* --- 3. ファビコン（案内ページから借りる）--------------------------- */
const icon = readFileSync(LP, "utf8")
  .match(/<link rel="icon" href="data:image\/x-icon;base64,[^"]+">/);
if (!icon) die("案内ページにファビコンが見つかりません");

/* --- 4. 差し込み ---------------------------------------------------- */
let out = readFileSync(SRC, "utf8");

if (!KEEP_DEBUG) {
  out = out.split("\n").filter((line) => !/window\.__(dbg|step)\s*=/.test(line)).join("\n");
  out = out.replace(/^\s*debug: \(\) => \{[\s\S]*?\n/m, "");
  out = out.replace(/\s*step: step,/, "");   // 検証用に1フレームだけ進める口
  if (/__dbg|__step|debug: \(\)|step: step/.test(out)) die("検証用フックが残っています");
}

const put = (token, value, label) => {
  if (!out.includes(token)) die("差し込み口がありません: " + token);
  out = out.split(token).join(value);
  console.log("  " + label + " を差し込みました");
};
put("/*__THREE__*/", three, "three");
put("__TITLE_IMAGE__", title, "タイトル画像");
put("<!--FAVICON-->", "<!-- ファビコン（案内ページと同じもの） -->\n" + icon[0], "ファビコン");

/* --- 5. 点検（完全自己完結であること）------------------------------- */
const external = out.match(/https?:\/\/(?!poc\.meisterguild|www\.w3\.org|ogp\.me)[^"' )]+/g);
if (external && external.length) die("外部参照が残っています: " + external.slice(0, 5).join(", "));
if (/<script[^>]*\ssrc=/.test(out)) die("外部スクリプトの読み込みがあります");
if (/<link[^>]+stylesheet/.test(out)) die("外部スタイルシートの読み込みがあります");

writeFileSync(OUT, out, "utf8");
console.log("\n  ✅ 書き出しました: " + OUT +
            " (" + statSync(OUT).size.toLocaleString() + " bytes)");
console.log("     外部参照なし（CDN・画像・フォントを読みません）\n");
