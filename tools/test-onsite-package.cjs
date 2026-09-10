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

// 追加したテストはライブラリを名前で引くので、パスを1か所に持つ
const LIB = require.resolve('./onsite-package-lib.cjs');

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

test('OS が作るファイルでは落ちない（OneDrive 配下で npm run check が止まらないため）', () => {
  const { OS_BOOKKEEPING_FILES } = require(LIB);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kidspg-os-'));
  fs.writeFileSync(path.join(dir, 'title_gummy_01.png'), 'x');
  fs.writeFileSync(path.join(dir, 'dummy_photo.png'), 'x');
  for (const name of OS_BOOKKEEPING_FILES) fs.writeFileSync(path.join(dir, name), 'x');
  // 🔴 これで落ちると make-onsite-package が「npm run check が通りません」で
  //    止まり、**パッケージを作れなくなる**（逃げ道は --skip-check だけ）
  assert.deepStrictEqual(findStrayRendererImages(dir), [], 'OS のファイルを挙げています');

  // フォルダの中の画像は挙げる（dist に載るので）
  fs.mkdirSync(path.join(dir, 'old'));
  fs.writeFileSync(path.join(dir, 'old', 'title_image_01.png'), 'x');
  assert.deepStrictEqual(findStrayRendererImages(dir), ['old/title_image_01.png']);
  fs.rmSync(dir, { recursive: true, force: true });
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
  // 🔴 **/MIR だけを禁止しても足りない。** /PURGE も宛先の余分なファイルを消す。
  //    実測（3巡目のレビュー）: /E /PURGE の robocopy を1行足しても63件すべて緑だった。
  //    robocopy の行を**全部**拾い、1行ずつ見る。
  //    🔴 ここは一度やらかした。宛先の書き方を `%PKG_TARGET%\app` と決め打ちしたが、
  //    実際の行は `"%TARGET%"` で、条件が**一度も成立しない到達不能コード**だった。
  //    しかも旧来の `assert.match(raw, /\/XD results logs/)` を消してしまったので、
  //    /XD を丸ごと削っても緑のままになっていた（＝守りが減った）。
  const lines = raw.split('\r\n').filter((l) => /robocopy/i.test(l) && !/^\s*rem\b/i.test(l));
  assert.ok(lines.length > 0, 'robocopy の行が見つかりません');
  let toTarget = 0;
  for (const line of lines) {
    // 宛先が当日の置き場（%TARGET% / %PKG_TARGET%）なら、消すフラグは禁止
    const destIsTarget = /"%(PKG_)?TARGET%[^"]*"/i.test(line);
    if (destIsTarget) {
      toTarget += 1;
      assert.ok(
        !/\/(MIR|PURGE)\b/i.test(line),
        '宛先を消すフラグを使っています（当日の results が消えます）: ' + line.trim()
      );
      assert.match(
        line,
        /\/XD[^\r\n]*\bresults\b/i,
        '当日の置き場へのコピーが results を除外していません: ' + line.trim()
      );
      assert.match(
        line,
        /\/XD[^\r\n]*\blogs\b/i,
        '当日の置き場へのコピーが logs を除外していません: ' + line.trim()
      );
    }
  }
  assert.ok(toTarget >= 1, '当日の置き場へコピーする robocopy が見つかりません（検査が空振りしています）');

  // robocopy 以外の消し方も塞ぐ（xcopy は上書きだけだが、rmdir /s と del /s は消す）
  for (const line of raw.split('\r\n')) {
    if (/^\s*(rem|::)/i.test(line)) continue;
    if (!/(rmdir|rd)\s+\/s|del\s+[^\r\n]*\/s/i.test(line)) continue;
    assert.ok(
      !/\b(results|logs)\b/i.test(line),
      '当日の成果物を消す行があります: ' + line.trim()
    );
  }
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

// ------------------------------------ 当日の救済ツールが配布された形で動くか

/**
 * 🔴 当日いちばん切迫した場面で使う道具が、**配布された形では1つも動かなかった**
 * （敵対的レビュー 2026-09-09 の指摘）。当日PCの形はこうなっている:
 *
 *   C:\kidspg\app\results\   ← 実物
 *   C:\kidspg\ops\           ← 救済ツールはここから実行する
 *
 * ツールは <ルート>/results を既定にしていたため ops\results を見て止まっていた。
 */
test('救済ツールは配布された ops から実物の results を見つける', () => {
  const { resolveResultsDir, describeMissing } = require('./lib/resolve-results-dir.cjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kidspg-onsite-'));
  fs.mkdirSync(path.join(base, 'ops'), { recursive: true });
  fs.mkdirSync(path.join(base, 'app', 'results'), { recursive: true });
  const r = resolveResultsDir(path.join(base, 'ops'));
  assert.strictEqual(r.dir, path.join(base, 'app', 'results'), '実物を指していません');
  fs.rmSync(base, { recursive: true, force: true });

  // 開発機（自分の下に results がある）ではそちらを使う
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kidspg-repo-'));
  fs.mkdirSync(path.join(repo, 'results'), { recursive: true });
  assert.strictEqual(resolveResultsDir(repo).dir, path.join(repo, 'results'));
  fs.rmSync(repo, { recursive: true, force: true });

  // 見つからないときは**探した場所を全部見せる**（パスを出さないと当日直せない）
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'kidspg-none-'));
  const msg = describeMissing(resolveResultsDir(none));
  assert.match(msg, /探した場所/);
  assert.match(msg, /KIDSPG_RESULTS_DIR/);
  fs.rmSync(none, { recursive: true, force: true });
});

test('救済ツール3本とも、その判断を共有している', () => {
  for (const rel of [
    'tools/purge-photos.cjs',
    'tools/place-regen-bat.cjs',
    'tools/retry-failed.cjs',
  ]) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(src, /resolve-results-dir/, rel + ' が判断を共有していません');
    // 自前で ROOT/results を既定にしていないこと（判断が2箇所に分かれる）
    assert.ok(
      !/:\s*path\.join\(ROOT, 'results'\)/.test(src),
      rel + ' が自前で ROOT/results を既定にしています'
    );
  }
});

test('再生成.bat は node を PATH 前提で呼ばない', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/place-regen-bat.cjs'), 'utf8');
  // 🔴 当日PCの node は ops\node\node.exe だけで PATH に無い。
  // 素の `node` を呼ぶと必ず 9009 で終わる
  assert.match(src, /ops.*node.*node\.exe/, 'node を絶対パスで探していません');
  assert.match(src, /NODEEXE/, 'node の探索結果を使っていません');
  // 道具の置き場所も探すこと（app 側に tools は無い）
  assert.match(src, /TOOLDIR/, 'ツールの置き場所を探していません');
  // 失敗時に ComfyUI へ誤誘導しないこと
  assert.ok(
    !/ComfyUI が動いているか、上のメッセージを確認してください/.test(src),
    '失敗の原因を ComfyUI に決めつけています'
  );
});

test('写真削除ツールは値の書き忘れで全件消さない', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/purge-photos.cjs'), 'utf8');
  // 🔴 `--only --apply` で ONLY が null になり、全プレイの写真を消していた
  assert.match(src, /flagErrors/, '指定の検証がありません');
  // ⚠️ 正規表現で書くと \d が「数字」として解釈され、ソース中の
  // リテラル \d{8}_\d{6} を探せない（最初はそれで空振りした）。文字列で探す。
  assert.ok(
    src.includes(String.raw`^\d{8}_\d{6}$`),
    '日時の形を検査していません'
  );
  // 読めなかったカードを完成扱いにしないこと
  assert.match(src, /include-unverified/, '確かめられなかったカードの扱いがありません');
  assert.match(src, /確かめられなかった/, 'unknown を完成扱いにしています');
});

test('カードの合成が npm 無しでできる（当日PCには npm が無い）', () => {
  // 🔴 以前は `npm run recovery`（tsx で TS ソースを直接実行）を呼んでいた。
  // 当日PCには npm も node_modules も src/ も無いため、**カードの作り直しが
  // 構造的に不可能**で、しかもパターンA が成功しても B で必ず落ちるので
  // 「成功したのに [失敗] と出る」形になっていた（敵対的レビュー 2026-09-09）。
  const src = fs.readFileSync(path.join(ROOT, 'tools/retry-failed.cjs'), 'utf8');
  assert.ok(!src.includes("'npm'"), 'まだ npm に依存しています');
  assert.match(src, /RECOVERY_JS/, 'ビルド済みの合成実装を使っていません');
  assert.match(src, /process\.execPath/, '同じ node で呼んでいません');
  // ImageMagick は PATH に無いので自分で足すこと
  assert.match(src, /withMagickPath/, 'ImageMagick を PATH に足していません');

  // 合成実装が dist に出ていること（tsconfig.main.json の include に入っているか）
  const tsconfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.main.json'), 'utf8'));
  assert.ok(
    tsconfig.include.some((i) => i.includes('memorial-card-recovery')),
    'tsconfig.main.json が合成実装をビルド対象にしていません'
  );
  const built = path.join(ROOT, 'dist/main/test/memorial-card-recovery.js');
  if (fs.existsSync(path.join(ROOT, 'dist/main'))) {
    assert.ok(fs.existsSync(built), 'ビルドしても合成実装が dist に出ていません: ' + built);
  }
});

test('パッケージの ops には合成実装まで入る', () => {
  // ops に入れるのは dist/main。その下に test/memorial-card-recovery.js が
  // 含まれていなければ、当日カードを作り直せない
  const src = fs.readFileSync(path.join(__dirname, 'make-onsite-package.cjs'), 'utf8');
  assert.match(src, /dist\/main.*opsDir, 'dist\/main'/s, 'ops に dist/main を入れていません');
});
// ================================================================
// 2026-09-09 の敵対的レビュー（パッケージ作成と当日セットアップ）
// ================================================================

test('診断と修復.bat が USB のルートと C:\\kidspg の両方に載る', () => {
  // 🔴 0_セットアップ.bat は照合に数分〜十数分かかるので、確認のたびに
  //    回させてはいけない（実機で「時間の無駄」と指摘された）。
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'make-onsite-package.cjs'), 'utf-8');
  assert.match(src, /'4_診断と修復\.bat'/, 'USB のルートに置いていません');
  assert.match(src, /payload, '診断と修復\.bat'/, 'C:\\kidspg 直下に置いていません');
});

test('診断と修復.bat は cmd の決めごとを守っている', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'tools', 'onsite', 'diagnose.bat'), 'utf-8');
  // CRLF（cmd は LF だけの bat を正しく行分割できない）
  assert.strictEqual((bat.match(/(?<!\r)\n/g) || []).length, 0, 'CR の無い改行があります');
  // chcp より上は ASCII のみ（CP932 のコンソールで行が割れる）
  const lines = bat.split('\r\n');
  const chcpAt = lines.findIndex((l) => l.trim() === 'chcp 65001 > nul');
  assert.ok(chcpAt > 0, 'chcp がありません');
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7F]/.test(lines.slice(0, chcpAt).join('')), 'chcp より上に非 ASCII があります');
  // 出力を横取りしている間に pause で待つと、画面に何も出ず固まって見える
  assert.strictEqual((bat.match(/^pause$/gm) || []).length, 1, 'pause は外側の1回だけにしてください');
});

test('原因を名指しする点検がバッチの隣に載る', () => {
  // 🔴 「PNG を扱えません」だけでは実機を何度も往復させることになる。
  //    LoadLibrary の Win32 番号で、依存の不在／探索の届かなさ／
  //    セキュリティのブロックを切り分けられるようにした。
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'make-onsite-package.cjs'), 'utf-8');
  assert.match(src, /outDir, 'check-imagemagick.ps1'/, 'USB のルートに置いていません');
  assert.match(src, /payload, 'check-imagemagick.ps1'/, 'C:\kidspg 直下に置いていません');

  const ps1 = fs.readFileSync(path.join(ROOT, 'tools', 'onsite', 'check-imagemagick.ps1'), 'utf-8');
  assert.ok(ps1.charCodeAt(0) === 0xfeff, 'BOM がありません（PowerShell 5.1 が CP932 と誤読します）');
  assert.match(ps1, /LoadLibraryExW/, 'LoadLibrary を直に呼んでいません');
  // 原因の別を機械が読める形で返すこと
  for (const c of ['blocked', 'missing-dep', 'search-path', 'no-file']) {
    assert.ok(ps1.includes(c), '原因の種別 ' + c + ' がありません');
  }
  // エラー本文は magick が ANSI(CP932) で書くので、既定で読むと化ける
  assert.match(ps1, /-Encoding Default/, 'エラー本文の文字コードを合わせていません');

  const bat = fs.readFileSync(path.join(ROOT, 'tools', 'onsite', 'diagnose.bat'), 'utf-8');
  assert.match(bat, /check-imagemagick.ps1/, '診断と修復.bat が呼んでいません');
  assert.match(bat, /-Fix/, '直せるものを直させていません');
});

test('診断と修復.bat はログを自分と同じ場所へ残す', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'tools', 'onsite', 'diagnose.bat'), 'utf-8');
  // USB から実行したら USB に残る（そのまま送れるように）
  assert.match(bat, /set "LOG=%~dp0診断ログ_/, 'バッチと同じ場所に残していません');
  // 書けない場所なら %TEMP% へ逃がす
  assert.match(bat, /if not exist "%LOG%" set "LOG=%TEMP%/, '書けないときの逃げ道がありません');
});

test('診断と修復.bat は -version ではなく実際に PNG を扱わせる', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'tools', 'onsite', 'diagnose.bat'), 'utf-8');
  assert.match(bat, /-size 4x4 xc:white/, 'PNG を書かせていません');
  assert.match(bat, /identify "!BASEPNG!"/, '本物のカード土台を読ませていません');
  assert.match(bat, /MAGICK_CODER_MODULE_PATH/, 'コーダーの置き場を教えていません');
  // 🔴 エラー本文を握り潰さない（前回これで原因が分からなかった）
  assert.match(bat, /type "%ERRFILE%"/, 'エラー本文を表示していません');
});

test('生成される start-comfyui.bat は日本語コンソールで読める（chcp と ASCII 先頭）', () => {
  const { buildStartComfyUIBat } = require(LIB);
  const bat = buildStartComfyUIBat();
  const lines = bat.split('\r\n');
  // 🔴 このバッチの唯一のエラー文（python_embeded が無い）は日本語。
  //    chcp が無いと CP932 コンソールで化けて、当日の手掛かりが失われる
  assert.ok(lines.some((l) => l.trim() === 'chcp 65001 > nul'), 'chcp 65001 がありません');
  const chcpAt = lines.findIndex((l) => l.trim() === 'chcp 65001 > nul');
  const above = lines.slice(0, chcpAt).join('\n');
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7F]/.test(above), 'chcp より上に非 ASCII があります: ' + above);
});

test('生成される start-comfyui.bat の上げ直しには上限がある', () => {
  const { buildStartComfyUIBat } = require(LIB);
  const bat = buildStartComfyUIBat();
  // 8188 番が埋まっていると python は即死するので、上限が無いと
  // 5秒ごとに torch を読み込み直して CPU とディスクを食い続ける
  // 🔴 **語の存在だけを見ない。** TRYMAX は解説コメントにも出るので、
  //    比較や exit を削っても緑になり得た（敵対的レビュー 2026-09-09 の指摘）。
  assert.match(bat, /set TRYMAX=\d+/, '上限の値がありません');
  assert.match(bat, /if %TRIES% GEQ %TRYMAX% \(/, '上限との比較がありません');
  assert.match(bat, /set \/a TRIES\+=1/, '試行回数を数えていません');
  assert.match(bat, /goto loop/, 'ループそのものが無くなっています');
  assert.match(bat, /giving up/, '諦めたことをログに残していません');
  assert.match(bat, /exit \/b 1/, '諦めたときに終了していません（ループから抜けません）');
});

test('生成される start-comfyui.bat は CRLF（cmd が LF を解釈できない）', () => {
  const { buildStartComfyUIBat } = require(LIB);
  const bat = buildStartComfyUIBat();
  assert.strictEqual((bat.match(/(?<!\r)\n/g) || []).length, 0, 'CR の無い改行があります');
});

test('renderer の画像は「使っているもの以外は全部挙げる」', () => {
  const { findStrayRendererImages, USED_RENDERER_IMAGES } = require(LIB);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kidspg-imgs-'));
  for (const name of USED_RENDERER_IMAGES) fs.writeFileSync(path.join(dir, name), 'x');
  assert.deepStrictEqual(findStrayRendererImages(dir), [], '使っているものを挙げています');

  // 🔴 実写を kid.jpg として置くと、名前のパターンには当たらないまま
  //    dist に載って USB へ出ていた。既知の名前だけを見る作りでは検出できない
  fs.writeFileSync(path.join(dir, 'kid.jpg'), 'x');
  assert.deepStrictEqual(
    findStrayRendererImages(dir),
    ['kid.jpg'],
    '知らない画像を挙げていません（実写を置いても素通りします）'
  );
});

test('禁じる場所には当日の成果物も入っている', () => {
  const { findForbiddenFiles } = require(LIB);
  const hits = findForbiddenFiles([
    'app/results/20260912_101112/photo_20260912_101112.png',
    'app/logs/comfyui.log',
    'app/assets/dummy_photo.png',
  ]);
  const files = hits.map((h) => h.file);
  assert.ok(files.includes('app/results/20260912_101112/photo_20260912_101112.png'), 'results を通しています');
  assert.ok(files.includes('app/logs/comfyui.log'), 'logs を通しています');
  assert.ok(!files.includes('app/assets/dummy_photo.png'), '正しい同梱物を弾いています');
});

test('コピー前の検査はリポジトリ側の素材も見る', () => {
  const { REPO_SOURCE_DIRS_TO_SCAN } = require(LIB);
  // 🔴 以前は ComfyUI 配下だけを見ていたので、assets/ に混じった実写は
  //    6.4GB 書き終えたあとにようやく検出され、しかも消さないので USB に残った
  for (const dir of ['assets', 'src/renderer/assets/images']) {
    assert.ok(REPO_SOURCE_DIRS_TO_SCAN.includes(dir), dir + ' を見ていません');
  }
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'make-onsite-package.cjs'), 'utf-8');
  // 🔴 **位置で比べる。** 以前は「コピーより前」を slice で切って
  //    match(/REPO_SOURCE_DIRS_TO_SCAN/) していたが、**冒頭の require の
  //    分割代入に一致**するため、走査をコピーの後ろへ移しても緑だった
  //    （敵対的レビュー 2026-09-09 の指摘）。
  const scanAt = src.indexOf('listMaterialFiles(path.join(ROOT, relDir), relDir)');
  const copyAt = src.indexOf("say('       コピー中 : '");
  assert.ok(scanAt > 0, 'リポジトリ側の走査が見つかりません');
  assert.ok(copyAt > 0, 'コピーの呼び出しが見つかりません');
  assert.ok(scanAt < copyAt, 'リポジトリ側の走査がコピーより後ろにあります（USB に載ってから検出する）');
});

test('--no-hash は古い SHA256SUMS を残さない', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'make-onsite-package.cjs'), 'utf-8');
  const noHash = src.slice(src.indexOf('if (NO_HASH) {'), src.indexOf('} else {', src.indexOf('if (NO_HASH) {')));
  // 残すと「中身は新しいのに目録は古い」状態になり、当日の照合が
  // 消えない誤警告を出し続け、増えたファイルは検査されない
  assert.match(noHash, /unlinkSync/, '古い目録を消していません');
});

test('SHA256SUMS は payload の外（prereq・手順書）も載せる', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'make-onsite-package.cjs'), 'utf-8');
  const hashPart = src.slice(src.indexOf('hashWalk(payload);'));
  // 🔴 **コメントに一致させない。** 以前は /prereq/ だけを見ていたので、
  //    直後の注釈に当たって extraTargets のループを削っても緑だった
  //    （敵対的レビュー 2026-09-09 の指摘）。実際の処理を見る。
  assert.match(hashPart, /const extraTargets = \['prereq'\]/, 'prereq を照合対象にしていません');
  assert.match(hashPart, /if \(fs\.existsSync\(dir\)\) hashWalk\(dir\)/, 'prereq を走査していません');
  assert.match(hashPart, /readdirSync\(outDir/, 'ルート直下を載せていません');
  assert.match(hashPart, /e\.name === 'SHA256SUMS'/, '目録自身を除いていません');
  // VC_redist は唯一インストール操作が要るもの。壊れていたら当日詰む
});

test('照合はコピー先と USB 側を分けて数える', () => {
  const ps1 = fs.readFileSync(path.join(ROOT, 'tools', 'onsite', 'verify-copy.ps1'), 'utf-8');
  assert.match(ps1, /COPIED=/, 'コピー先の件数を返していません');
  assert.match(ps1, /MEDIA=/, 'USB 側の件数を返していません');
  // payload の外は USB 側を起点に見る（コピー先には置かれないので必ず食い違う）
  assert.match(ps1, /usbRoot/, 'USB 側を起点にしていません');
  const bat = fs.readFileSync(path.join(ROOT, 'tools', 'onsite', '0_setup.bat'), 'utf-8');
  assert.match(bat, /HASH_MEDIA/, 'bat 側が USB 側の件数を読んでいません');
  assert.match(bat, /やり直しても直りません/, '対処の違いを伝えていません');
});

test('セットアップはモデル4本と Electron 本体を確かめる', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'tools', 'onsite', '0_setup.bat'), 'utf-8');
  // いちばんコピーが失敗しやすい 4.1GB を1つも見ていなかった
  for (const m of [
    'DreamShaper_8_pruned.safetensors',
    'sd-vae-ft-mse.safetensors',
    'control_v11p_sd15_canny.safetensors',
    'Hyper-SD15-8steps-CFG-lora.safetensors',
  ]) {
    assert.ok(bat.includes(m), m + ' を確かめていません');
  }
  assert.match(bat, /electron\.exe/, 'Electron 本体を確かめていません');
});

test('セットアップは致命的な欠落があるときに前向きな手順を出さない', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'tools', 'onsite', '0_setup.bat'), 'utf-8');
  assert.match(bat, /MISSING_CORE/, '致命的な欠落を区別していません');
  assert.match(bat, /:sum_missing_core/, '欠落時の案内がありません');
  // 「このあとやること」より前で分岐していること
  const idxBranch = bat.indexOf('if defined MISSING_CORE goto :sum_missing_core');
  const idxNext = bat.indexOf('echo   このあとやること');
  assert.ok(idxBranch > 0 && idxBranch < idxNext, '分岐が手順の後ろにあります');
});

test('セットアップは当日の config.json を黙って巻き戻さない', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'tools', 'onsite', '0_setup.bat'), 'utf-8');
  // 設定画面から保存でき、手順書の退避策も config.json を書き換える
  assert.match(bat, /config\.json\.before-setup/, '退避していません');
  const idxBackup = bat.indexOf('config.json.before-setup');
  const idxCopy = bat.indexOf('robocopy "%~dp0payload"');
  assert.ok(idxBackup > 0 && idxBackup < idxCopy, '上書きの後に退避しています');
});

test('資材の組み立ては検証で溜まるものを毎回空にする', () => {
  const ps1 = fs.readFileSync(path.join(ROOT, 'tools', 'onsite', 'build-materials.ps1'), 'utf-8');
  // /MIR は /XD で除外したフォルダを消さないので、検証で作られた
  // user\comfyui.db と temp\ が残り、再実行でも直らなかった
  assert.match(ps1, /'input', 'output', 'temp', 'user'/, '4つを空にしていません');
  // 🔴 **-LiteralPath にワイルドカードを渡していないこと。** 展開されないので
  //    1件も消えず、-ErrorAction SilentlyContinue と合わせて**無言で通る**
  //    （実測 2026-09-09。「空にします」と表示だけして何もしていなかった）。
  assert.ok(
    !/-LiteralPath \(Join-Path \$dir '\*'\)/.test(ps1),
    '-LiteralPath にワイルドカードを渡しています（1件も消えません）'
  );
  assert.match(
    ps1,
    /foreach \(\$item in @\(Get-ChildItem -Force -LiteralPath \$dir/,
    '子を列挙して消していません'
  );
  assert.match(ps1, /Remove-Item -Recurse -Force -LiteralPath \$item\.FullName/, '中身を消していません');
  assert.match(ps1, /を空にできませんでした/, '消し残りを検出していません');
});

test('顔写真の後始末は ComfyUI の input/output も対象にする', () => {
  const { resolveComfyUIRoot, listScratchFiles } = require(path.join(ROOT, 'tools', 'lib', 'comfyui-scratch.cjs'));
  // 🔴 アプリは /upload/image で写真を上げるので、当日PCの ComfyUI に
  //    参加者全員の生の顔写真が残る。実測（開発機・何度も再起動後）で
  //    input 44 件・output 51 件。「再起動で消える」は誤りだった
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kidspg-comfy-'));
  fs.mkdirSync(path.join(dir, 'input', '3d'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'input', 'photo_20260912_101112.png'), 'x');
  fs.writeFileSync(path.join(dir, 'input', '3d', 'sample.obj'), 'x');
  fs.writeFileSync(path.join(dir, 'output', 'KidsPG_00001_.png'), 'x');

  // 🔴 危険と認めた4つ（input / output / temp / user）すべてを見る。
  //    以前は input/output の2つだけで、**自分たちが持ち出し禁止にしている
  //    場所の半分が未処理**だった（敵対的レビュー 2026-09-09 の指摘）。
  fs.mkdirSync(path.join(dir, 'temp'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'user'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'temp', 'ComfyUI_temp_abcde_00001_.png'), 'x');
  fs.writeFileSync(path.join(dir, 'user', 'comfyui.db'), 'x');

  const groups = listScratchFiles(dir);
  const all = groups.flatMap((g) => g.files.map((f) => path.basename(f.path)));
  assert.ok(all.includes('photo_20260912_101112.png'), '顔写真を見ていません');
  assert.ok(all.includes('KidsPG_00001_.png'), '生成画像を見ていません');
  assert.ok(all.includes('ComfyUI_temp_abcde_00001_.png'), 'temp のプレビューを見ていません');
  assert.ok(all.includes('comfyui.db'), 'user の履歴を見ていません');
  // サブフォルダのサンプルは触らない
  assert.ok(!all.includes('sample.obj'), 'サブフォルダまで対象にしています');
  // 掴み損ねを「空です」と言わないための印
  const missing = listScratchFiles(path.join(dir, 'nope'));
  assert.ok(missing.every((g) => g.missing), '見つからないことを伝えていません');

  // config.json から場所を解決できる
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({
    comfyui: { activeProfile: 'local', profiles: { local: { paths: { root: dir } } } },
  }));
  assert.strictEqual(resolveComfyUIRoot(cfg).root, path.resolve(dir));
});

test('後始末ツールは「input は再起動で消える」と書いていない（事実と違う）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'purge-photos.cjs'), 'utf-8');
  // 注釈として「以前はそう書いていた」と残すのは正しい。
  // 事実の説明として残っていないことを見る
  assert.ok(
    !/（ComfyUI の input は再起動で消えるため）/.test(src),
    '事実と違う説明が残っています（実測で残ることを確認済み）'
  );
  assert.match(src, /そうなる仕組みはどこにも無い/, '誤りだったことを書き残していません');
  assert.match(src, /purgeComfyUIScratch/, 'ComfyUI 側の後始末がありません');
});
