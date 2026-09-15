#!/usr/bin/env node
/**
 * メモリアルカードアルバムのビルド
 * ------------------------------------------------------------------
 * 入力は2種類。どちらでも同じ出力になる。
 *
 *  (A) 公開用フォルダ（本番はこちら）
 *      <publish>/index.json  … items[] に nickname / rank / level / score /
 *                               playedAt / card を持つ
 *      <publish>/cards/*.png … カード原寸
 *      → node _tools/build-gallery.mjs --from "C:\KidsPG\work_20260912\publish_20260912"
 *
 *  (B) ゲームの results フォルダ（開発中の確認用）
 *      <results>/<日時>/result.json ＋ memorial_card_*.png
 *      → node _tools/build-gallery.mjs
 *
 * 出力（すべて 03_release の中）:
 *      card_images/memorial_card_<id>.png  … 原寸（ダウンロード用）
 *      card_thumbs/memorial_card_<id>.jpg  … 一覧用サムネイル
 *      2026-memorial-gallery.html          … CARDS 配列を差し込む
 *
 * 🔴 入力フォルダは読むだけで、書き換えません。
 *
 * その他のオプション:
 *      --dry-run   … コピーも差し込みもせず、件数と除外だけ出す
 *
 * 前提: ImageMagick の `magick` が PATH にあること（サムネイル生成に使う）。
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, existsSync, statSync, rmSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = join(ROOT, "03_release");
const IMG_OUT = join(OUT, "card_images");
const THUMB_OUT = join(OUT, "card_thumbs");
const HTML = join(OUT, "2026-memorial-gallery.html");

const DEFAULT_RESULTS = resolve(ROOT, "../kidspg-game-2026/results");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const fromIdx = argv.indexOf("--from");
const FROM = fromIdx !== -1 ? argv[fromIdx + 1] : null;

const THUMB_WIDTH = 320;      // 一覧はこの幅で足りる（原寸は 1017x1512）
const THUMB_QUALITY = 80;

const START = "/* @@CARD_DATA_START@@ */";
const END = "/* @@CARD_DATA_END@@ */";

/* ---------------------------------------------------------------- */

const log = (...a) => console.log(...a);
const warn = (...a) => console.log("  ⚠", ...a);

function hasMagick() {
  try { execFileSync("magick", ["-version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

/** (A) publish フォルダの index.json から読む */
function collectFromPublish(dir) {
  const indexPath = join(dir, "index.json");
  if (!existsSync(indexPath)) { throw new Error(`index.json がありません: ${indexPath}`); }

  const j = JSON.parse(readFileSync(indexPath, "utf8"));
  const items = j.items;
  if (!Array.isArray(items)) { throw new Error("index.json に items の配列がありません"); }
  if (typeof j.count === "number" && j.count !== items.length) {
    warn(`index.json の count(${j.count}) と items(${items.length}) が食い違っています`);
  }

  const cards = [];
  const skipped = [];

  for (const it of items) {
    const id = it.id || "(id不明)";
    if (!it.card) { skipped.push([id, "card のパスが無い"]); continue; }
    if (/\.dummy\./i.test(it.card)) { skipped.push([id, "dummy 画像なので除外"]); continue; }

    const src = join(dir, it.card);
    if (!existsSync(src)) { skipped.push([id, "画像が見つからない: " + it.card]); continue; }

    const base = basename(it.card);
    cards.push({
      nickname: String(it.nickname ?? "なまえなし"),
      rank: it.rank ? String(it.rank) : null,
      level: it.level ? String(it.level) : null,
      score: Number.isFinite(it.score) ? it.score : null,
      playedAt: String(it.playedAt ?? ""),
      file: base,
      thumb: base.replace(/\.png$/i, ".jpg"),
      _src: src,
    });
  }

  // index.json 側で既に外されていたものも、記録として見せる
  for (const id of j.excluded || []) { skipped.push([id, "index.json の excluded（生成元で除外済み）"]); }

  return { cards, skipped, meta: `index.json / generatedAt=${j.generatedAt ?? "不明"}` };
}

/** (B) ゲームの results フォルダから読む */
function collectFromResults(dir) {
  if (!existsSync(dir)) { throw new Error(`results フォルダが見つかりません: ${dir}`); }

  const cards = [];
  const skipped = [];

  const dirs = readdirSync(dir)
    .filter((n) => /^\d{8}_\d{6}$/.test(n))
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .sort();

  for (const d of dirs) {
    const jsonPath = join(dir, d, "result.json");
    if (!existsSync(jsonPath)) { skipped.push([d, "result.json が無い"]); continue; }

    let r;
    try { r = JSON.parse(readFileSync(jsonPath, "utf8")); }
    catch (e) { skipped.push([d, "result.json が壊れている: " + e.message]); continue; }

    let file = null;
    if (r.memorialCardPath && !/\.dummy\.png$/i.test(r.memorialCardPath)) {
      const cand = join(dir, r.memorialCardPath);
      if (existsSync(cand)) { file = cand; }
    }
    if (!file) {
      const found = readdirSync(join(dir, d))
        .filter((n) => /^memorial_card_.*\.png$/i.test(n) && !/\.dummy\.png$/i.test(n));
      if (found.length) { file = join(dir, d, found[0]); }
    }
    if (!file) { skipped.push([d, "カード画像が無い（未生成 or dummy のみ）"]); continue; }

    const base = `memorial_card_${d}.png`;
    cards.push({
      nickname: String(r.nickname ?? "なまえなし"),
      rank: r.rank ? String(r.rank) : null,
      level: r.level ? String(r.level) : null,
      score: Number.isFinite(r.score) ? r.score : null,
      playedAt: String(r.timestampJST ?? ""),
      file: base,
      thumb: base.replace(/\.png$/i, ".jpg"),
      _src: file,
    });
  }

  return { cards, skipped, meta: "results/<日時>/result.json" };
}

/** 今回のデータに含まれない古い画像を消す（前回ビルドの残骸対策） */
function removeStale(cards) {
  const keepImg = new Set(cards.map((c) => c.file));
  const keepTh = new Set(cards.map((c) => c.thumb));
  let n = 0;

  for (const [dir, keep] of [[IMG_OUT, keepImg], [THUMB_OUT, keepTh]]) {
    if (!existsSync(dir)) { continue; }
    for (const f of readdirSync(dir)) {
      if (keep.has(f)) { continue; }
      rmSync(join(dir, f));
      n++;
    }
  }
  return n;
}

function makeImages(cards, magick) {
  mkdirSync(IMG_OUT, { recursive: true });
  mkdirSync(THUMB_OUT, { recursive: true });

  let copied = 0, thumbed = 0, reused = 0;

  for (const c of cards) {
    const dst = join(IMG_OUT, c.file);
    if (!existsSync(dst) || statSync(dst).size !== statSync(c._src).size) {
      copyFileSync(c._src, dst);
      copied++;
    } else {
      reused++;
    }

    const thumb = join(THUMB_OUT, c.thumb);
    if (existsSync(thumb) && statSync(thumb).mtimeMs >= statSync(dst).mtimeMs) { continue; }

    if (magick) {
      execFileSync("magick", [
        dst, "-resize", `${THUMB_WIDTH}x`, "-strip",
        "-quality", String(THUMB_QUALITY), thumb,
      ]);
      thumbed++;
    } else {
      copyFileSync(dst, join(THUMB_OUT, c.file));
      c.thumb = c.file;
    }
  }

  return { copied, thumbed, reused };
}

function inject(cards) {
  let html = readFileSync(HTML, "utf8");
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a === -1 || b === -1 || b < a) {
    throw new Error(`差し込みマーカーが見つかりません: ${START} / ${END}`);
  }

  const rows = cards.map((c) => {
    const { _src, ...keep } = c;
    return "  " + JSON.stringify(keep);
  });

  const block = START + "\nconst CARDS = [\n" + rows.join(",\n") + "\n];\n" + END;
  writeFileSync(HTML, html.slice(0, a) + block + html.slice(b + END.length), "utf8");
  return rows.length;
}

/* ---------------------------------------------------------------- */

log("── メモリアルカードアルバムのビルド ──");

const source = FROM ? resolve(FROM) : DEFAULT_RESULTS;
const usePublish = FROM ? true : false;
log("  入力   : " + source + (usePublish ? "  （読むだけ。書き換えません）" : ""));
log("  出力先 : " + OUT);

const magick = hasMagick();
if (!magick) { warn("ImageMagick(magick) が見つかりません。サムネイルは原寸で代替します。"); }

const { cards, skipped, meta } = usePublish ? collectFromPublish(source) : collectFromResults(source);
log("  読み元 : " + meta);

log(`\n  採用: ${cards.length} 件 / 除外: ${skipped.length} 件`);
for (const [id, why] of skipped) { log(`    - ${id}: ${why}`); }

// ニックネームの重複は、子どもが自分のカードを探すときに効いてくるので見せる
const dup = {};
for (const c of cards) { dup[c.nickname] = (dup[c.nickname] || 0) + 1; }
const dups = Object.entries(dup).filter(([, n]) => n > 1);
log(`\n  ニックネーム: ユニーク ${Object.keys(dup).length} / 全 ${cards.length}`);
if (dups.length) {
  log(`    同名が ${dups.length} 種あります（検索すると複数出ます）`);
  log("    " + dups.slice(0, 6).map(([k, v]) => `${k}×${v}`).join(" / ") + (dups.length > 6 ? " …" : ""));
}

if (DRY) {
  log("\n  --dry-run なので、コピーも差し込みもしていません。");
  process.exit(0);
}

if (!cards.length) {
  warn("採用0件。差し込みを中止します（既存のHTMLは変更しません）。");
  process.exit(1);
}

const stale = removeStale(cards);
if (stale) { log(`\n  今回のデータに無い古いファイルを ${stale} 件削除しました`); }

const io = makeImages(cards, magick);
log(`  画像: 新規コピー ${io.copied} / 既存流用 ${io.reused} / サムネイル生成 ${io.thumbed}`);

const n = inject(cards);
log(`  HTML: CARDS に ${n} 件を差し込みました`);

const sum = (dir) => readdirSync(dir).reduce((a, f) => a + statSync(join(dir, f)).size, 0);
const mb = (b) => (b / 1048576).toFixed(1) + " MB";
log(`\n  原寸    : ${mb(sum(IMG_OUT))}（ダウンロードしたときだけ読み込む）`);
log(`  サムネ  : ${mb(sum(THUMB_OUT))}（一覧を開いたときに読み込む）`);
log("\n  完了。03_release の中身をFTPで上げてください。");
