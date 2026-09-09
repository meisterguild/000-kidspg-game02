#!/usr/bin/env node
/**
 * 当日PC向けパッケージの「組み立ての決めごと」を、副作用なしで持つところ。
 *
 * ここに置いてあるのは *判断* だけ（何を入れるか・何を落とすか・どこから何を
 * 読むか）で、ファイルを触る処理は make-onsite-package.cjs 側にある。
 * 分けてあるのは、決めごとを単体テストで固定できるようにするため
 * （tools/test-onsite-package.cjs）。当日PCへ渡すものを間違えると、
 * 現地で「起動しない」だけが分かって原因が分からない状態になる。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 当日PCへ渡す package.json を作る。
 *
 * ■ なぜ元の package.json をそのまま置かないのか
 * Electron 本体は `package.json` の `main` を読んでアプリを起動する。必要なのは
 * それだけで、devDependencies（electron-builder・vite・typescript など700MB分の
 * 依存の宣言）と、当日PCでは動かない scripts（build / dist / lint）は
 * **書いてあるだけで害になる**。スタッフが `npm start` を試して失敗し、
 * 「壊れている」と判断してしまう経路を潰しておく。
 *
 * ■ dependencies は「実際に積んだものだけ」にする
 * 元の宣言をそのまま写すと react / react-dom / three が並ぶが、これらは Vite が
 * dist へ焼き込むので**同梱しない**。宣言だけ残すと、読んだ人に「入っているはず」
 * と思わせ、`require('three')` を足したツールが当日になって落ちる。
 * 積んだものと宣言を一致させておく。
 */
const buildOnsitePackageJson = (original, shippedDeps) => {
  const shipped = new Set(shippedDeps || []);
  const dependencies = {};
  for (const [name, range] of Object.entries(original.dependencies || {})) {
    if (shipped.has(name)) dependencies[name] = range;
  }
  return {
    name: original.name,
    version: original.version,
    description: original.description,
    // 🔴 Electron 本体はこれを見てアプリを起動する。落としてはいけない
    main: original.main,
    // 当日PCでできることだけを残す。ビルド系は道具が無いので置かない
    scripts: {
      _comment: 'このフォルダでは start-kidspg.bat から起動する。npm は使わない',
    },
    dependencies,
    author: original.author,
    license: original.license,
    private: true,
  };
};

/**
 * あるパッケージが実行時に必要とする node_modules を、package.json の
 * dependencies を辿って集める。
 *
 * renderer 側（react / react-dom / three）は Vite が dist へ焼き込むので**要らない**。
 * main プロセスが require するのは form-data だけなので、そこから辿った分だけを積む。
 * 全部コピーすると 719MB になり、USB とコピー時間に直接効く。
 */
const collectRuntimeDeps = (nodeModulesDir, entryNames) => {
  const found = new Set();
  const missing = new Set();
  const walk = (name) => {
    if (found.has(name) || missing.has(name)) return;
    const pkgPath = path.join(nodeModulesDir, name, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
      missing.add(name);
      return;
    }
    found.add(name);
    for (const dep of Object.keys(pkg.dependencies || {})) walk(dep);
  };
  for (const name of entryNames) walk(name);
  return { packages: [...found].sort(), missing: [...missing].sort() };
};

/** Node の組み込みモジュール。require の解決検査でこれらは無視する */
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);

/**
 * 積み忘れの検出。組み立てた dist/main が require している名前のうち、
 * 組み込みでも相対パスでもないものを拾い、渡した一覧に入っているか見る。
 *
 * これを入れているのは、**依存を1つ落としても起動するまで気づけない**ため。
 * 当日 ComfyUI へ画像を上げる瞬間（form-data を使う）に初めて落ちる、
 * というのが最悪の形。
 */
const findUnsatisfiedRequires = (jsSources, availablePackages) => {
  const available = new Set(availablePackages);
  available.add('electron'); // Electron 本体が自分で解決する
  const unsatisfied = new Set();
  for (const source of jsSources) {
    for (const m of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const name = m[1];
      if (name.startsWith('.') || name.startsWith('/')) continue;
      const bare = name.startsWith('@')
        ? name.split('/').slice(0, 2).join('/')
        : name.split('/')[0];
      if (NODE_BUILTINS.has(bare) || bare.startsWith('node:')) continue;
      if (!available.has(bare)) unsatisfied.add(bare);
    }
  }
  return [...unsatisfied].sort();
};

/**
 * card_base_images から外すもの。
 * `superseded_*` は意匠の変遷の記録で、当日は使わない（electron-builder の
 * filter と同じ判断。片方だけ直すと食い違うので、理由もここに書いておく）。
 */
const shouldSkipCardBaseEntry = (relativePath) =>
  relativePath.split(/[\/]/).some((seg) => seg.startsWith('superseded_'));

/**
 * 配布物が太る原因になる「置いてあるだけで dist に載る画像」の検出。
 *
 * assets.ts は new URL(`../assets/images/${relativePath}`, import.meta.url) と
 * いう動的パターンで画像を読むため、**Vite はあのフォルダの全ファイルを出力する**。
 * コードから参照されていなくても、置いてあるだけで配布物に載る（実測 18.6MB）。
 * 2026-09-09 に superseded_2025/ へ移したが、また戻ってきたら気づけるようにする。
 */
const KNOWN_UNUSED_RENDERER_IMAGES = [
  'title_image_01.png',
  'title_image_02.png',
  'title_image_03.png',
  'title_image_04.png',
  'sprite_items.png',
  'sprite_items.xcf',
];

const findStrayRendererImages = (imagesDir) => {
  let entries;
  try {
    entries = fs.readdirSync(imagesDir);
  } catch {
    return [];
  }
  return KNOWN_UNUSED_RENDERER_IMAGES.filter((name) => entries.includes(name));
};

/**
 * 🔴 **持ち出してはいけないものが混じっていないか。**
 *
 * 開発機の ComfyUI の `input/` には、検証で使った**実際の子どもの顔写真**
 * （`photo_<日時>.png`）が溜まる。`output/` にはそれを変換した絵が残る。
 * 2026-09-09 に資材を組んだ時点で input に 44 件・output に 51 件あった。
 *
 * これを USB に載せて別PCへ持ち出すのは、この企画でいちばんやってはいけないこと
 * （カードを後日公開する方針のため、生の顔写真の扱いは特に厳しくしている）。
 * 除外の指定を1つ書き忘れただけで起きるので、**組み立てたあとに機械的に見る**。
 *
 * 名前で見ているだけなので万能ではない。それでも「除外を書き忘れた」という
 * 現実に起きる事故は確実に捕まえられる。
 */
const FORBIDDEN_PAYLOAD_PATTERNS = [
  { pattern: /^photo_\d{8}_\d{6}\.png$/i, why: '撮影した生の顔写真' },
  { pattern: /^photo_anime_/i, why: '顔写真から作った AI 画像' },
  { pattern: /^compare_\d+/i, why: '検証用に顔写真から作った比較画像' },
  { pattern: /^memorial_card_/i, why: '実在の子どものカード' },
];

const findForbiddenFiles = (files) => {
  const hits = [];
  for (const file of files) {
    const name = file.split(/[\\/]/).pop();
    for (const { pattern, why } of FORBIDDEN_PAYLOAD_PATTERNS) {
      if (pattern.test(name)) {
        hits.push({ file, why });
        break;
      }
    }
  }
  return hits;
};

module.exports = {
  findForbiddenFiles,
  FORBIDDEN_PAYLOAD_PATTERNS,
  buildOnsitePackageJson,
  collectRuntimeDeps,
  findUnsatisfiedRequires,
  shouldSkipCardBaseEntry,
  findStrayRendererImages,
  KNOWN_UNUSED_RENDERER_IMAGES,
  NODE_BUILTINS,
};
