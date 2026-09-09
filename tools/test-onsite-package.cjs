#!/usr/bin/env node
/**
 * 当日PC向けパッケージの「組み立ての決めごと」の単体テスト
 *
 *   node --test tools/test-onsite-package.cjs
 *
 * ■ 何を守っているか
 * ここで固定しているのは、**間違えても開発機では気づけない**ことばかり。
 *
 *   ・実行時依存の積み忘れ … 依存を1つ落としても**アプリは起動する**。
 *     ComfyUI へ画像を上げる瞬間（form-data を使う）に初めて落ちるので、
 *     当日「1枚目のカードだけが出ない」で気づくことになる
 *   ・package.json の宣言と実物の食い違い … 読んだ人が「入っているはず」と
 *     思い込む。積んでいない three を require したツールが当日落ちる
 *   ・配布物に載る未参照画像 … Vite が動的パターンでフォルダの全ファイルを
 *     出力するため、置いてあるだけで 18.6MB が USB とコピー時間に乗る
 *
 * このファイルは実物のコピーはしない（副作用のない判断だけを見る）。
 * 実際に組み立てられるかは `node tools/make-onsite-package.cjs --app-only` で見る。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const {
  buildOnsitePackageJson,
  collectRuntimeDeps,
  findForbiddenFiles,
  findUnsatisfiedRequires,
  shouldSkipCardBaseEntry,
  findStrayRendererImages,
  KNOWN_UNUSED_RENDERER_IMAGES,
} = require('./onsite-package-lib.cjs');

// ---------------------------------------------------------------- package.json

const samplePkg = () => ({
  name: 'kidspg-game-2026',
  version: '1.0.0',
  description: 'せつめい',
  main: 'dist/main/main/main.js',
  scripts: { build: 'tsc', dist: 'electron-builder', lint: 'eslint src' },
  dependencies: { 'form-data': '^4.0.4', react: '^18.3.0', three: '^0.180.0' },
  devDependencies: { electron: '^33.0.0', vite: '^6.0.0' },
  author: { name: 'KidsPG Team' },
  license: 'MIT',
});

test('main は必ず残す（Electron 本体がこれを見てアプリを起動する）', () => {
  const out = buildOnsitePackageJson(samplePkg(), ['form-data']);
  assert.strictEqual(out.main, 'dist/main/main/main.js');
});

test('devDependencies とビルド系 scripts は落とす（当日PCに道具が無い）', () => {
  const out = buildOnsitePackageJson(samplePkg(), ['form-data']);
  assert.strictEqual(out.devDependencies, undefined);
  assert.strictEqual(out.scripts.build, undefined);
  assert.strictEqual(out.scripts.dist, undefined);
  assert.strictEqual(out.scripts.lint, undefined);
  // 何もないと npm start を試されるので、ここで起動方法を書いておく
  assert.match(out.scripts._comment, /start-kidspg\.bat/);
});

test('dependencies は実際に積んだものだけにする（積んでいない three を宣言しない）', () => {
  const out = buildOnsitePackageJson(samplePkg(), ['form-data', 'combined-stream']);
  assert.deepStrictEqual(Object.keys(out.dependencies), ['form-data']);
  assert.strictEqual(out.dependencies.three, undefined);
  assert.strictEqual(out.dependencies.react, undefined);
});

test('private を立てる（当日PCから誤って publish されないように）', () => {
  assert.strictEqual(buildOnsitePackageJson(samplePkg(), []).private, true);
});

// ---------------------------------------------------------------- 実行時依存

test('form-data から辿ると、この node_modules にある依存がすべて解決できる', () => {
  const { packages, missing } = collectRuntimeDeps(path.join(ROOT, 'node_modules'), ['form-data']);
  assert.deepStrictEqual(missing, [], '解決できない依存があります');
  assert.ok(packages.includes('form-data'));
  // form-data が直に要求するもの。ここが落ちると ComfyUI への画像アップロードで死ぬ
  for (const need of ['combined-stream', 'mime-types', 'asynckit']) {
    assert.ok(packages.includes(need), need + ' が入っていません');
  }
  // renderer 側は Vite が dist へ焼き込むので、辿った先に出てきてはいけない
  for (const bundled of ['react', 'react-dom', 'three']) {
    assert.ok(!packages.includes(bundled), bundled + ' は同梱しない');
  }
});

test('node_modules に無いものは missing として返す（黙って飛ばさない）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kidspg-deps-'));
  fs.mkdirSync(path.join(dir, 'alpha'));
  fs.writeFileSync(
    path.join(dir, 'alpha', 'package.json'),
    JSON.stringify({ name: 'alpha', dependencies: { bravo: '^1.0.0' } })
  );
  const { packages, missing } = collectRuntimeDeps(dir, ['alpha']);
  assert.deepStrictEqual(packages, ['alpha']);
  assert.deepStrictEqual(missing, ['bravo']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('依存が環状でも終わる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kidspg-deps-'));
  for (const [name, dep] of [['a', 'b'], ['b', 'a']]) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(
      path.join(dir, name, 'package.json'),
      JSON.stringify({ name, dependencies: { [dep]: '*' } })
    );
  }
  const { packages, missing } = collectRuntimeDeps(dir, ['a']);
  assert.deepStrictEqual(packages, ['a', 'b']);
  assert.deepStrictEqual(missing, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 積み忘れの検出

test('組み込みモジュールと相対 require は積み忘れとみなさない', () => {
  const src = [
    "const fs = require('fs');",
    "const path = require('path');",
    "const { Worker } = require('worker_threads');",
    "const x = require('./services/card-output');",
    "const y = require('../shared/utils/helpers');",
    "const { app } = require('electron');",
  ].join('\n');
  assert.deepStrictEqual(findUnsatisfiedRequires([src], []), []);
});

test('積んでいない外部モジュールを require していたら名前を挙げる', () => {
  const src = "const FormData = require('form-data');\nconst sharp = require('sharp');";
  assert.deepStrictEqual(findUnsatisfiedRequires([src], ['form-data']), ['sharp']);
});

test('サブパス付きの require はパッケージ名で判断する', () => {
  const src = "require('form-data/lib/form_data');\nrequire('mime-types/index.js');";
  assert.deepStrictEqual(findUnsatisfiedRequires([src], ['form-data']), ['mime-types']);
});

test('スコープ付きパッケージは @scope/name まででまとめる', () => {
  const src = "require('@aws-sdk/client-s3/dist/index.js');";
  assert.deepStrictEqual(findUnsatisfiedRequires([src], []), ['@aws-sdk/client-s3']);
});

test('実際にビルドした dist/main は form-data の依存だけで足りる', () => {
  const mainDir = path.join(ROOT, 'dist', 'main');
  if (!fs.existsSync(mainDir)) {
    // dist が無いのは「まだビルドしていない」だけなので、ここでは落とさない。
    // 本番の組み立て（make-onsite-package.cjs）は dist が無ければ止まる。
    return;
  }
  const sources = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) sources.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(mainDir);
  const { packages } = collectRuntimeDeps(path.join(ROOT, 'node_modules'), ['form-data']);
  assert.deepStrictEqual(
    findUnsatisfiedRequires(sources, packages),
    [],
    'dist/main が、同梱しないモジュールを require しています'
  );
});

// ---------------------------------------------------------------- 除外の決めごと

test('card_base_images の superseded_* は配布に入れない', () => {
  assert.strictEqual(shouldSkipCardBaseEntry('superseded_20260902'), true);
  assert.strictEqual(shouldSkipCardBaseEntry('superseded_20260904/bg-card-rank-01-beginner.png'), true);
  assert.strictEqual(shouldSkipCardBaseEntry('bg-card-rank-01-beginner.png'), false);
});

test('現行のカード背景8枚は除外されない（当日ランクごとに全部使う）', () => {
  const dir = path.join(ROOT, 'card_base_images');
  const kept = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.png') && !shouldSkipCardBaseEntry(name));
  assert.strictEqual(kept.length, 8, 'カード背景はランク8段階と1対1で対応している');
});

// ---------------------------------------------------------------- 未参照画像の見張り

test('昨年の未参照画像が src/renderer/assets/images に戻っていない', () => {
  const stray = findStrayRendererImages(path.join(ROOT, 'src/renderer/assets/images'));
  assert.deepStrictEqual(
    stray,
    [],
    '置いてあるだけで dist に載ります（実測 18.6MB）。superseded_2025/ へ移してください'
  );
});

test('戻ってきたら気づける（検出そのものが動くことの確認）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kidspg-img-'));
  fs.writeFileSync(path.join(dir, KNOWN_UNUSED_RENDERER_IMAGES[0]), 'x');
  fs.writeFileSync(path.join(dir, 'title_gummy_01.png'), 'x'); // 今年のものは挙げない
  assert.deepStrictEqual(findStrayRendererImages(dir), [KNOWN_UNUSED_RENDERER_IMAGES[0]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('フォルダが無くても落ちない', () => {
  assert.deepStrictEqual(findStrayRendererImages(path.join(ROOT, 'そんなフォルダは無い')), []);
});

// -------------------------------------------------- 持ち出してはいけないものの検出

/**
 * 🔴 開発機の ComfyUI の input/ には検証で使った**実際の子どもの顔写真**が溜まる。
 * 2026-09-09 に資材を組んだ時点で input 44 件・output 51 件あった。
 * 除外の指定を1つ書き忘れただけで USB に載るので、組み立て後に機械的に見る。
 */
test('顔写真・AI画像・カードは持ち出しとして検出する', () => {
  const files = [
    'ai/ComfyUI/input/photo_20260902_100037.png',
    'ai/ComfyUI/output/photo_anime_20260902_100037_00001_.png',
    'ai/ComfyUI/input/compare_1788772951157.png',
    'app/results/20260912_101112/memorial_card_20260912_101112.png',
  ];
  const hits = findForbiddenFiles(files);
  assert.strictEqual(hits.length, 4, '4件すべてを検出できていません');
  for (const h of hits) assert.ok(h.why && h.why.length > 0, '理由が付いていません');
});

test('配って良いものを誤検出しない', () => {
  const ok = [
    'app/assets/dummy_photo.png',
    'app/assets/ComfyUI_KidsPG_2026_local.json',
    'app/card_base_images/bg-card-rank-01-beginner.png',
    'ai/models/checkpoints/DreamShaper_8_pruned.safetensors',
    'ai/ComfyUI/comfy_api/input/__init__.py',
    'bin/ImageMagick/magick.exe',
  ];
  assert.deepStrictEqual(findForbiddenFiles(ok), []);
});

test('作成スクリプトは mustBeEmpty を「中のファイル」で判定する', () => {
  const src = fs.readFileSync(path.join(__dirname, 'make-onsite-package.cjs'), 'utf8');
  assert.match(src, /mustBeEmpty/, 'mustBeEmpty を見ていません');
  // フォルダの有無ではなくファイル数で判断していること
  assert.match(src, /inside.files > 0/, 'ファイル数で判定していません');
});

test('作成スクリプトは組み立てたあとに持ち出し検査をする', () => {
  const src = fs.readFileSync(path.join(__dirname, 'make-onsite-package.cjs'), 'utf8');
  assert.match(src, /findForbiddenFiles/, '持ち出し検査を呼んでいません');
  // 検査は組み立てのあと（payload が出来てから）でないと意味がない
  const buildAt = src.indexOf("step('4/8'");
  const checkAt = src.indexOf('findForbiddenFiles(allPayloadFiles)');
  assert.ok(buildAt > 0 && checkAt > buildAt, '検査が組み立てより前にあります');
});

// ---------------------------------------------- 資材を組むスクリプト

test('資材を組むスクリプトが、実測で踏んだ落とし穴を押さえている', () => {
  const p = path.join(__dirname, 'onsite', 'build-materials.ps1');
  assert.ok(fs.existsSync(p), 'build-materials.ps1 がありません');
  const src = fs.readFileSync(p, 'utf8');
  // (1)(2) _pth の2箇所。どちらも欠けると ComfyUI が起動しない
  assert.match(src, /import site/, '_pth の import site を有効にしていません');
  assert.match(src, /\.\.\\ComfyUI/, '_pth に ..\\ComfyUI を足していません');
  // (3) /XD は名前一致。フルパスで渡していること（Join-Path で組んでいる）
  assert.match(src, /Join-Path \$ComfyUISource 'input'/, '/XD をフルパスで指定していません');
  assert.match(src, /comfy_api\\input/, '/XD の取りこぼしを検出していません');
  // (4) torch を先に、lock で固定
  const torchAt = src.indexOf('torch==2.13.0+cpu');
  const lockAt = src.indexOf('-r $LockFile');
  assert.ok(torchAt > 0 && lockAt > torchAt, 'torch を lock より後に入れています');
  assert.match(src, /download\.pytorch\.org\/whl\/cpu/, 'torch を CPU 版で入れていません');
  // (5) 顔写真を持ち出さない
  assert.match(src, /photo_\*\.png/, '顔写真の混入を見ていません');
});

// ------------------------------------------- Smart App Control 対策

/**
 * 🔴 **SAC はオフにしない**（2026-09-09 判断。オフは戻せないため利用者の判断で不可）。
 * 代わりに「前日までにオンラインで暖機して判定を取り切る」方式にした。
 *
 * 実測: 新しく置いた scipy の .pyd がブロックされて ComfyUI が落ちたが、
 * **中身が同一（SHA256 一致）で前から置いてあったファイルは動いていた**。
 * つまり SAC は危険と言っているのではなく、判定を取りに行っている間だけ止める。
 */
test('暖機の道具が揃っている', () => {
  for (const rel of ['tools/onsite/warmup.bat', 'tools/onsite/check-sac-blocks.ps1']) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel + ' がありません');
  }
  const warm = fs.readFileSync(path.join(ROOT, 'tools/onsite/warmup.bat'), 'utf8');
  // オンラインで実行することが伝わらないと暖機にならない
  assert.match(warm, /インターネットに繋いだ状態/);
  // 1回で取り切れないことがあるので、繰り返す案内が要る
  assert.match(warm, /もう一度このバッチを実行/);
  // オフにしろ**とは言わない**。
  // ⚠️ 「オフにする必要はない」という説明とは区別する必要がある
  //    （最初はここを雑に見て、自分の文面で落ちた）。見るのは命令形だけ。
  assert.ok(
    !/オフに(して|しま)/.test(warm),
    'SAC をオフにするよう指示しています（この方針は採らない）'
  );
  // 逆に「オフにしなくてよい」ことは書いてある必要がある
  assert.match(warm, /オフにする必要はない|オフにする必要はありません/);
});

test('起動バッチは失敗時に SAC のブロックを名前で出す', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'start-kidspg.bat'), 'utf8');
  assert.match(raw, /^:report_sac/m, 'report_sac が定義されていません');
  // ComfyUI が上がらなかったとき / 準備確認が時間切れのとき、両方から呼ぶ
  const calls = (raw.match(/call :report_sac/g) || []).length;
  assert.strictEqual(calls, 2, 'SAC の報告を呼ぶ箇所が 2 つではありません');
  assert.match(raw, /ウォームアップ/, '暖機への案内がありません');
});

test('パッケージは暖機バッチを当日PCの直下へ置く', () => {
  const src = fs.readFileSync(path.join(__dirname, 'make-onsite-package.cjs'), 'utf8');
  assert.match(src, /warmup.bat/, '暖機バッチを入れていません');
  // app/ ではなく payload の直下（= C:kidspg 直下）に置く
  assert.match(src, /payload, 'ウォームアップ.bat'/);
});

test('PowerShell スクリプトは UTF-8 BOM 付き', () => {
  // 🔴 powershell 5.1 は BOM の無い UTF-8 を CP932 と誤読する。
  // 2026-09-09 に check-sac-blocks.ps1 がそれで構文エラーになり、
  // build-materials.ps1 も同じ状態だった（実行前に気づけた）。
  for (const rel of [
    'tools/onsite/check-sac-blocks.ps1',
    'tools/onsite/verify-copy.ps1',
    'tools/onsite/build-materials.ps1',
  ]) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    assert.ok(
      buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
      rel + ' に UTF-8 BOM がありません（PowerShell 5.1 が日本語を誤読します）'
    );
  }
});

test('bat には BOM を付けない（cmd が1行目を実行しようとする）', () => {
  for (const rel of ['start-kidspg.bat', 'stop-kidspg.bat', 'tools/onsite/0_setup.bat', 'tools/onsite/warmup.bat']) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    assert.ok(
      !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf),
      rel + ' に BOM があります'
    );
  }
});

// ---------------------------------------------------------------- bat の作法

/**
 * 🔴 **cmd は LF だけの bat を正しく解釈できない。**
 * 2026-09-09 に 0_setup.bat を LF で書いてしまい、ラベルと括弧のブロックが壊れて
 * 日本語の行が次々とコマンドとして実行された（'音量とスピーカーの確認' is not
 * recognized as an internal or external command …）。
 * .gitattributes でも固定しているが、書き出す側の事故も拾えるようにする。
 */
test('当日PC用のスクリプトは CRLF（cmd が LF の bat を解釈できない）', () => {
  const targets = [
    'tools/onsite/0_setup.bat',
    'tools/onsite/warmup.bat',
    'tools/onsite/verify-copy.ps1',
    'tools/onsite/build-materials.ps1',
    'tools/onsite/check-sac-blocks.ps1',
    'start-kidspg.bat',
    'stop-kidspg.bat',
  ];
  for (const rel of targets) {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const loneLf = (raw.match(/(?<!\r)\n/g) || []).length;
    assert.strictEqual(loneLf, 0, rel + ' に CR の無い改行が ' + loneLf + ' 個あります');
  }
});

test('bat の先頭は ASCII だけ（CP932 のコンソールが UTF-8 を誤読するため）', () => {
  for (const rel of ['tools/onsite/0_setup.bat', 'tools/onsite/warmup.bat', 'start-kidspg.bat', 'stop-kidspg.bat']) {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // BOM があると cmd が1行目を実行しようとして失敗する
    assert.ok(!raw.startsWith('﻿'), rel + ' に BOM があります');
    const lines = raw.split('\r\n');
    const mainIndex = lines.findIndex((l) => l.trim() === ':main');
    assert.ok(mainIndex > 0, rel + ' に :main がありません');
    // :main より前に非 ASCII があると、chcp 65001 が効く前に読まれて行が割れる
    // （日本語の2バイト目に 0x7C '|' や 0x26 '&' を含む文字がある）
    const header = lines.slice(0, mainIndex).join('\n');
    const bad = [...header].filter((ch) => ch.charCodeAt(0) > 127);
    assert.deepStrictEqual(bad, [], rel + ' の :main より前に非 ASCII があります');
  }
});

test('0_setup.bat は results と logs を消さない（当日の成果物を守る）', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'tools/onsite/0_setup.bat'), 'utf8');
  // /MIR は出力先を鏡にするので、当日の results を消してしまう
  assert.ok(!/robocopy[^\r\n]*\/MIR/.test(raw), '/MIR を使うと results が消えます');
  assert.match(raw, /\/XD results logs/, 'results と logs を除外していません');
});

test('0_setup.bat は置き場所の食い違いを検出して止まる', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'tools/onsite/0_setup.bat'), 'utf8');
  // config.json の中の絶対パスが manifest の target を前提にしているため、
  // 違う場所へ入れたら黙って進めてはいけない
  assert.match(raw, /manifest\.json/);
  assert.match(raw, /PKG_TARGET/);
});

// ---------------------------------------------------------------- 資材の目録

test('外部資材の目録は必要な項目を持ち、venv を持ち込まない決めごとが書かれている', () => {
  const def = JSON.parse(fs.readFileSync(path.join(__dirname, 'onsite-materials.json'), 'utf8'));
  const keys = def.materials.map((m) => m.key);
  for (const need of ['models', 'comfyui', 'python_embeded', 'imagemagick', 'node']) {
    assert.ok(keys.includes(need), need + ' が目録にありません');
  }
  for (const m of def.materials) {
    assert.ok(m.dest, m.key + ' に dest がありません');
    assert.ok(m.note, m.key + ' に入手元・注意（note）がありません');
    assert.ok(m.kind === 'dir' || m.kind === 'file', m.key + ' の kind が不正です');
  }
  // venv をコピーで持ち込むと pyvenv.cfg の home がユーザー名を指していて壊れる。
  // その判断が目録から消えないように縛る
  const comfy = def.materials.find((m) => m.key === 'comfyui');
  assert.ok(comfy.mustNotContain.includes('venv'), 'venv を入れない決めごとが消えています');
  assert.ok(comfy.mustContain.includes('main.py'));

  // 🔴 input/ と output/ は**フォルダは要るが中は空**でなければならない。
  // ComfyUI が使うのでフォルダごと禁じると空の正しい状態まで弾いてしまい、
  // 逆に中身を許すと検証で使った顔写真が USB に載る。
  assert.ok(comfy.mustBeEmpty.includes('input'), 'input を空にする決めごとがありません');
  assert.ok(comfy.mustBeEmpty.includes('output'), 'output を空にする決めごとがありません');
  assert.ok(
    !comfy.mustNotContain.includes('input'),
    'input はフォルダごと禁じてはいけない（ComfyUI が使う）'
  );

  // モデルは local プロファイルの4本。サイズ照合が効いていること
  const models = def.materials.find((m) => m.key === 'models');
  assert.strictEqual(models.files.length, 4);
  for (const f of models.files) {
    assert.ok(f.expectedBytes > 0, f.path + ' の期待サイズが埋まっていません');
  }
});

/**
 * 目録の note は「どこを読めば作れるか」を指している。**指し先が無いと空手形**になる。
 * 実際に 2026-09-09 に、note が「組み方は docs/distribution-plan.md」と言っているのに
 * その文書に手順が書かれていない状態になっていた。
 */
test('目録が指している「埋め込み Python の組み方」が実在する', () => {
  const def = JSON.parse(fs.readFileSync(path.join(__dirname, 'onsite-materials.json'), 'utf8'));
  const py = def.materials.find((m) => m.key === 'python_embeded');
  const plan = fs.readFileSync(path.join(ROOT, 'docs/distribution-plan.md'), 'utf8');
  assert.match(py.note, /埋め込み Python の組み方/, 'note が組み方の節を指していません');
  assert.match(plan, /埋め込み Python の組み方/, 'distribution-plan.md にその節がありません');
  // 手順が本当に書かれているか（踏むと必ず詰まる2箇所を目印にする）
  assert.match(plan, /import site/, '_pth の import site を有効にする手順がありません');
  assert.match(plan, /download\.pytorch\.org\/whl\/cpu/, 'torch を CPU 版で入れる手順がありません');
});

test('パッケージには ComfyUI の構築手順と設計の文書も入れる', () => {
  const src = fs.readFileSync(path.join(__dirname, 'make-onsite-package.cjs'), 'utf8');
  // 当日PCで ComfyUI を作り直すことはできないが、「何がどう入っているのか」が
  // 分からないと壊れたときに何も判断できない
  assert.match(src, /setup-onsite\.md/, '当日手順書を入れていません');
  assert.match(src, /comfyui-local-setup\.md/, 'ComfyUI 構築手順を入れていません');
  assert.match(src, /distribution-plan\.md/, 'パッケージの設計を入れていません');
  for (const rel of ['docs/setup-onsite.md', 'docs/comfyui-local-setup.md', 'docs/distribution-plan.md']) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel + ' がありません');
  }
});

test('当日手順書は、入っている Python が venv ではないことを断っている', () => {
  // 同梱する構築手順（comfyui-local-setup.md）は venv 前提で書かれている。
  // 読み替えを案内しないと、当日 venv を作ろうとして詰まる
  const onsite = fs.readFileSync(path.join(ROOT, 'docs/setup-onsite.md'), 'utf8');
  assert.match(onsite, /venv/, 'venv との違いに触れていません');
  assert.match(onsite, /埋め込み/, '埋め込み配布版であることに触れていません');
});

test('目録のモデル4本は config.json のワークフローが要求するものと一致する', () => {
  const def = JSON.parse(fs.readFileSync(path.join(__dirname, 'onsite-materials.json'), 'utf8'));
  const models = def.materials.find((m) => m.key === 'models');
  const names = models.files.map((f) => path.basename(f.path));
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const templatePath = config.comfyui.profiles.local.templatePath;
  const workflow = fs.readFileSync(path.join(ROOT, templatePath), 'utf8');
  for (const name of names) {
    assert.ok(
      workflow.includes(name),
      name + ' が local のワークフローから参照されていません（目録が古い可能性）'
    );
  }
});
