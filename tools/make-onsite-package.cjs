#!/usr/bin/env node
/**
 * 当日PC向けの持ち出しパッケージを作る（USB へ入れて、別PCでコピーして動かす）
 *
 *   node tools/make-onsite-package.cjs --out D:\KidsPG2026_setup
 *   node tools/make-onsite-package.cjs --out tmp\pkg --app-only        # app と ops だけ（反復用）
 *   node tools/make-onsite-package.cjs --out D:\... --materials C:\WORK\AI\onsite-materials
 *   node tools/make-onsite-package.cjs --out D:\... --skip-check --no-hash
 *
 * ■ 何を作るか（docs/distribution-plan.md に全体像）
 *   <out>/0_セットアップ.bat        … 当日PCでこれを実行する
 *   <out>/payload/app/             … アプリ（Electron 本体 + dist。**exe は作らない**）
 *   <out>/payload/ops/             … 当日の救済ツール（node 携帯版 + tools + dist/main）
 *   <out>/payload/ai/              … ComfyUI + 埋め込み Python + モデル4本
 *   <out>/payload/bin/             … ImageMagick 携帯版
 *   <out>/manifest.json            … 版・日付・ファイル数・サイズ
 *   <out>/SHA256SUMS               … コピー漏れと破損の検出用
 *
 * ■ exe を作らない理由
 * electron-builder が作る exe は「署名が無く、世の中に出回っていない新品の exe」に
 * なるため Windows 11 の Smart App Control に弾かれる。Electron 本体で dist を
 * 読ませる経路（start-kidspg.bat の electron モード）を配布の主経路にする。
 *
 * ■ 黙って穴あきパッケージを作らない
 * リポジトリの外の資材（モデル・埋め込み Python・ImageMagick・Node）が欠けていたら
 * **入手元と期待サイズを表示して止まる**。当日PCで初めて足りないと分かるのが
 * いちばん高くつくため。--app-only を付けたときだけ、その確認を飛ばす。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const {
  buildOnsitePackageJson,
  collectRuntimeDeps,
  findForbiddenFiles,
  findUnsatisfiedRequires,
  shouldSkipCardBaseEntry,
  findStrayRendererImages,
} = require('./onsite-package-lib.cjs');

const ROOT = path.resolve(__dirname, '..');

// ------------------------------------------------------------------ 引数
const argv = process.argv.slice(2);
const has = (name) => argv.includes('--' + name);
const flag = (name) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const OUT = flag('out');
const MATERIALS = flag('materials') || 'C:/WORK/AI/onsite-materials';
// 当日PCでの置き場所。パッケージの中の config.json などをこの場所に合わせて書き換える。
// **ここで確定させてしまうのは、当日PC上で 19KB のコメント入り JSON を書き換えるより
// 手元で作って目で確かめられるほうが安全だから。** 別の場所へ入れたい場合は
// --target を変えて作り直す（0_セットアップ.bat は食い違いを検出して止まる）。
const TARGET = (flag('target') || 'C:\\kidspg').replace(/[\\/]+$/, '');
const APP_ONLY = has('app-only');
const SKIP_CHECK = has('skip-check');
const NO_HASH = has('no-hash');

if (!OUT) {
  console.error('使い方: node tools/make-onsite-package.cjs --out <出力先> [--materials <資材置き場>]');
  console.error('        [--app-only] [--skip-check] [--no-hash]');
  process.exit(1);
}

const outDir = path.resolve(OUT);
const payload = path.join(outDir, 'payload');

// ------------------------------------------------------------------ 小道具
const say = (msg) => console.log(msg);
const step = (n, msg) => console.log('\n[' + n + '] ' + msg);
const die = (msg) => {
  console.error('\n✗ ' + msg);
  process.exit(1);
};
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';

const dirSize = (dir) => {
  let total = 0;
  let files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        total += fs.statSync(p).size;
        files += 1;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { bytes: total, files };
};

const hasRobocopy = spawnSync('where', ['robocopy'], { stdio: 'ignore' }).status === 0;

/**
 * フォルダをまるごとコピーする。
 *
 * 大きいもの（electron 268MB・モデル 4.1GB）は robocopy を使う。fs.cpSync でも
 * 同じことはできるが、**数分のあいだ何も表示されない**ので「固まった」に見える。
 * robocopy は進みを出し、途中で失敗しても再実行で続けられる。
 * 除外条件つきのコピーだけは fs.cpSync を使う（robocopy の除外指定と
 * 判断が二重になるのを避けるため。除外が要るのは card_base_images と tools だけ）。
 */
const copyTree = (src, dest, options) => {
  const filter = options && options.filter;
  const progress = options && options.progress;
  if (!fs.existsSync(src)) die('コピー元がありません: ' + src);
  fs.mkdirSync(dest, { recursive: true });
  if (filter || !hasRobocopy) {
    fs.cpSync(src, dest, { recursive: true, filter });
    return;
  }
  // /MIR: 出力先を鏡にする（作り直しても前回の残骸が残らない）
  // /NDL /NJH /NJS: フォルダ名・見出し・集計を出さない（何千行にもなる）
  // /NFL: ファイル名も出さない。**progress:true のときだけ外す**——
  //       2.1GB のモデル1本のコピーで何も表示されないと「固まった」に見えるため、
  //       大きいものだけはファイルごとの進みを出す
  // /R:2 /W:2: USB の一時的な失敗で止まらない程度に再試行する
  const args = [src, dest, '/MIR', '/NDL', '/NJH', '/NJS', '/R:2', '/W:2'];
  if (!progress) args.push('/NFL');
  const r = spawnSync('robocopy', args, {
    stdio: 'inherit',
  });
  // robocopy は成功でも 0〜7 を返す（1=コピーした / 2=余分を消した …）。
  // 8 以上が本当の失敗。0 だけを成功とみなすと毎回失敗扱いになる。
  if (r.status === null || r.status >= 8) die('robocopy が失敗しました (' + r.status + '): ' + src);
};

const copyFile = (src, dest) => {
  if (!fs.existsSync(src)) die('コピー元がありません: ' + src);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
};

// ------------------------------------------------------------------ 1. 事前点検
step('1/8', '事前点検');

const gitInfo = (() => {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
    return { commit, dirty: dirty.length > 0 };
  } catch {
    return { commit: '(git 情報を取れませんでした)', dirty: false };
  }
})();
say('       コミット : ' + gitInfo.commit);
if (gitInfo.dirty) {
  // 止めはしない。当日直前の微修正を配れなくなるほうが困る。
  // ただし「どの版か分からないパッケージ」は後から追えないので必ず言う。
  say('       [注意] 作業ツリーに未コミットの変更があります。');
  say('              このパッケージの中身はコミットから再現できません。');
}

const stray = findStrayRendererImages(path.join(ROOT, 'src/renderer/assets/images'));
if (stray.length > 0) {
  say('       [注意] 参照されていない画像が src/renderer/assets/images に戻っています:');
  say('              ' + stray.join(', '));
  say('              assets.ts は動的パターンで画像を読むため、置いてあるだけで');
  say('              dist に載ります（実測 18.6MB）。superseded_2025/ へ移してください。');
}

if (!fs.existsSync(path.join(ROOT, 'node_modules/electron/dist/electron.exe'))) {
  die('node_modules/electron が見つかりません。npm ci を実行してください。');
}

// ------------------------------------------------------------------ 2. 資材の確認
step('2/8', 'リポジトリの外の資材の確認');

const manifestDef = JSON.parse(fs.readFileSync(path.join(__dirname, 'onsite-materials.json'), 'utf8'));
const materialReport = [];

if (APP_ONLY) {
  say('       ＊ --app-only なので飛ばします（app と ops だけ作ります）');
} else {
  const problems = [];
  for (const m of manifestDef.materials) {
    const src = path.join(MATERIALS, m.dest);
    if (!fs.existsSync(src)) {
      if (m.required) problems.push({ m, reason: '見つかりません' });
      else say('       - ' + m.key + ' : ありません（必須ではないので飛ばします）');
      continue;
    }
    if (m.kind === 'dir') {
      for (const need of m.mustContain || []) {
        if (!fs.existsSync(path.join(src, need))) problems.push({ m, reason: need + ' がありません' });
      }
      for (const forbid of m.mustNotContain || []) {
        if (fs.existsSync(path.join(src, forbid))) {
          problems.push({ m, reason: forbid + ' が入っています（入れてはいけません）' });
        }
      }
      // 「フォルダはあってよいが、中にファイルがあってはいけない」もの。
      // ComfyUI は input/ と output/ を使うので**空で用意する必要がある**が、
      // そこに検証で使った顔写真が残るのは絶対に避けたい。
      // フォルダの存在自体を禁じると、空で用意した正しい状態まで弾いてしまう
      // （2026-09-09 にそれで作成が止まった）。
      for (const mustEmpty of m.mustBeEmpty || []) {
        const dir = path.join(src, mustEmpty);
        if (!fs.existsSync(dir)) continue;
        const inside = dirSize(dir);
        if (inside.files > 0) {
          problems.push({
            m,
            reason:
              mustEmpty + '/ に ' + inside.files + ' 件のファイルがあります（空でなければいけません）',
          });
        }
      }
      for (const f of m.files || []) {
        const p = path.join(src, f.path);
        if (!fs.existsSync(p)) {
          problems.push({ m, reason: f.path + ' がありません' });
          continue;
        }
        const size = fs.statSync(p).size;
        if (f.expectedBytes && size !== f.expectedBytes) {
          problems.push({
            m,
            reason: f.path + ' のサイズが違います（期待 ' + f.expectedBytes + ' / 実際 ' + size + '）',
          });
        }
      }
      const s = dirSize(src);
      materialReport.push({ key: m.key, bytes: s.bytes, files: s.files });
      say('       OK : ' + m.key + '  ' + mb(s.bytes) + ' / ' + s.files + ' ファイル');
    } else {
      const size = fs.statSync(src).size;
      if (m.expectedBytes && size !== m.expectedBytes) {
        problems.push({ m, reason: 'サイズが違います（期待 ' + m.expectedBytes + ' / 実際 ' + size + '）' });
      } else {
        materialReport.push({ key: m.key, bytes: size, files: 1 });
        say('       OK : ' + m.key + '  ' + mb(size));
      }
    }
  }
  if (problems.length > 0) {
    console.error('\n✗ 資材が揃っていないので作りません（穴あきパッケージを配らないため）:\n');
    for (const item of problems) {
      console.error('  ・' + item.m.key + ' (' + MATERIALS + '/' + item.m.dest + ') : ' + item.reason);
      console.error('      ' + item.m.note);
    }
    console.error('\n  資材の置き場所は --materials で変えられます（いま: ' + MATERIALS + '）');
    process.exit(1);
  }
}

// ------------------------------------------------------------------ 3. ビルド
step('3/8', 'ビルドと検査');
if (SKIP_CHECK) {
  say('       ＊ --skip-check なので飛ばします（dist が古いままでも作ります）');
} else {
  say('       npm run check を実行します（build / tsc / lint / test）…');
  const r = spawnSync('npm', ['run', 'check'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) die('npm run check が通りませんでした。直してから作り直してください。');
}
if (!fs.existsSync(path.join(ROOT, 'dist/main/main/main.js'))) {
  die('dist/main/main/main.js がありません。npm run build を実行してください。');
}

// ------------------------------------------------------------------ 4. app
step('4/8', 'app（アプリ本体）を組み立て');
const appDir = path.join(payload, 'app');
fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });

const originalPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// main プロセスが実行時に require するものだけを積む（form-data とその依存）。
// react / react-dom / three は Vite が dist へ焼き込むので要らない。
// **package.json の dependencies もこの一覧に合わせる**ので、先に決める。
const deps = collectRuntimeDeps(path.join(ROOT, 'node_modules'), ['form-data']);
if (deps.missing.length > 0) die('node_modules に無い依存があります: ' + deps.missing.join(', '));

// package.json は当日向けに絞った版を書き出す（理由は onsite-package-lib.cjs）
fs.writeFileSync(
  path.join(appDir, 'package.json'),
  JSON.stringify(buildOnsitePackageJson(originalPkg, deps.packages), null, 2) + '\n'
);

for (const f of ['config.json', 'start-kidspg.bat', 'stop-kidspg.bat', 'CREDITS.md', 'LICENSE']) {
  copyFile(path.join(ROOT, f), path.join(appDir, f));
}
copyTree(path.join(ROOT, 'dist'), path.join(appDir, 'dist'));
copyTree(path.join(ROOT, 'assets'), path.join(appDir, 'assets'));
copyTree(path.join(ROOT, 'card_base_images'), path.join(appDir, 'card_base_images'), {
  filter: (src) => {
    const rel = path.relative(path.join(ROOT, 'card_base_images'), src);
    return rel === '' || !shouldSkipCardBaseEntry(rel);
  },
});

// Electron 本体。node_modules/electron の JS ラッパは要らない（exe を直接叩くため）
copyTree(
  path.join(ROOT, 'node_modules/electron/dist'),
  path.join(appDir, 'node_modules/electron/dist')
);

for (const name of deps.packages) {
  copyTree(path.join(ROOT, 'node_modules', name), path.join(appDir, 'node_modules', name));
}
say('       実行時依存 : ' + deps.packages.length + ' パッケージ（form-data とその依存）');

// 当日ここに溜まるフォルダは先に作っておく
fs.mkdirSync(path.join(appDir, 'results'), { recursive: true });
fs.mkdirSync(path.join(appDir, 'logs'), { recursive: true });

const appSize = dirSize(appDir);
say('       app : ' + mb(appSize.bytes) + ' / ' + appSize.files + ' ファイル');

// ------------------------------------------------------------------ 5. ops
step('5/8', 'ops（当日の救済ツール）を組み立て');
const opsDir = path.join(payload, 'ops');
fs.rmSync(opsDir, { recursive: true, force: true });
fs.mkdirSync(opsDir, { recursive: true });

// tools/ は「1つ上」に dist と config.json がある前提で書かれているので、
// ops/ を小さなリポジトリの形に見せる（tools/ と dist/ と config.json を並べる）。
// 単体テスト（test-*）は当日使わないので入れない。
copyTree(path.join(ROOT, 'tools'), path.join(opsDir, 'tools'), {
  filter: (src) => !path.basename(src).startsWith('test-'),
});
copyTree(path.join(ROOT, 'dist/main'), path.join(opsDir, 'dist/main'));
// 🔴 **assets を必ず積む。** comfyui-smoke.cjs は
//   ・ワークフロー: config.json の templatePath（= assets/ComfyUI_KidsPG_2026_local.json）
//   ・写真        : assets/dummy_photo.png
// を ops のルート基準で探す。これが無いと smoke は「写真がありません」で即終了し、
// **暖機の「1枚生成」が構造的に必ず失敗する**。しかも warmup.bat は
// ブロック 0 件を見て「暖機できました」と出すため、
// **暖機という仕組み全体が機能しないまま成功と表示される**
// （敵対的レビュー 2026-09-09 の指摘。出来上がったパッケージで再現を確認した）。
copyTree(path.join(ROOT, 'assets'), path.join(opsDir, 'assets'));
copyFile(path.join(ROOT, 'config.json'), path.join(opsDir, 'config.json'));
fs.writeFileSync(
  path.join(opsDir, 'package.json'),
  JSON.stringify(
    { name: 'kidspg-onsite-ops', private: true, version: originalPkg.version },
    null,
    2
  ) + '\n'
);
if (!APP_ONLY) {
  copyTree(path.join(MATERIALS, 'ops/node'), path.join(opsDir, 'node'));
}
const opsSize = dirSize(opsDir);
say('       ops : ' + mb(opsSize.bytes) + ' / ' + opsSize.files + ' ファイル');

// ------------------------------------------------------------------ 6. ai / bin
step('6/8', 'ai（ComfyUI・埋め込み Python・モデル）と bin（ImageMagick）');
if (APP_ONLY) {
  say('       ＊ --app-only なので飛ばします');
} else {
  for (const key of ['ai/ComfyUI', 'ai/python_embeded', 'ai/models', 'bin/ImageMagick']) {
    const src = path.join(MATERIALS, key);
    const size = dirSize(src);
    say('       コピー中 : ' + key + '  (' + mb(size.bytes) + ')');
    // 1GB を超えるものはファイルごとの進みを出す（モデルと埋め込み Python）
    copyTree(src, path.join(payload, key), { progress: size.bytes > 1024 * 1024 * 1024 });
    say('       OK : ' + key);
  }
  const vc = path.join(MATERIALS, 'prereq/VC_redist.x64.exe');
  if (fs.existsSync(vc)) copyFile(vc, path.join(outDir, 'prereq/VC_redist.x64.exe'));
}

// --------------------------------------------------- 6.5 当日PCの置き場所へ合わせる
step('6.5/8', '当日PCの置き場所（' + TARGET + '）へ合わせる');

/**
 * config.json の ComfyUI の物理パスを、当日PCの置き場所へ書き換える。
 *
 * 🔴 **JSON を parse して stringify し直さない。** この config.json は 1 行に
 * 数百文字の日本語の注釈（_comment_*）を持ち、字下げも 2 の倍数で揃っていない。
 * 再出力すると全体の字下げが変わり、差分が読めなくなる。
 * ここでは**古いルートの文字列だけを置換**し、そのあと必ず parse し直して
 * 「壊れていないこと」と「置き換わった件数」を確かめる。
 */
const retargetConfig = (configPath) => {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  const profiles = (parsed.comfyui && parsed.comfyui.profiles) || {};
  const roots = new Set();
  for (const p of Object.values(profiles)) {
    if (p && p.paths && p.paths.root) roots.add(p.paths.root);
  }
  if (parsed.comfyui && parsed.comfyui.paths && parsed.comfyui.paths.root) {
    roots.add(parsed.comfyui.paths.root);
  }
  if (roots.size === 0) {
    say('       [注意] config.json に comfyui...paths.root がありません。書き換えません。');
    return;
  }
  if (roots.size > 1) {
    die(
      'config.json の paths.root が複数あります（' +
        [...roots].join(' / ') +
        '）。当日PCの1箇所へ寄せてから作り直してください。'
    );
  }
  const oldRoot = [...roots][0];
  const newRoot = path.join(TARGET, 'ai', 'ComfyUI');
  // JSON の文字列の中ではバックスラッシュが 2 文字で書かれている
  const asJson = (s) => JSON.stringify(s).slice(1, -1);
  const before = asJson(oldRoot);
  const after = asJson(newRoot);
  const count = raw.split(before).length - 1;
  if (count === 0) die('config.json の中に ' + oldRoot + ' が見つかりませんでした。');
  const updated = raw.split(before).join(after);

  // 書き換えた結果が JSON として成立していること、実際に新しい場所を指していることを確かめる
  const check = JSON.parse(updated);
  for (const [name, p] of Object.entries(check.comfyui.profiles || {})) {
    if (p && p.paths && p.paths.root && !p.paths.root.startsWith(newRoot)) {
      die('プロファイル ' + name + ' の paths.root を書き換えられませんでした');
    }
  }
  fs.writeFileSync(configPath, updated);
  say('       config.json : ' + oldRoot);
  say('                  → ' + newRoot + '（' + count + ' 箇所）');
};

retargetConfig(path.join(appDir, 'config.json'));
retargetConfig(path.join(opsDir, 'config.json'));

if (!APP_ONLY) {
  // extra_model_paths.yaml の base_path（ComfyUI がモデルを探す場所）
  const yamlPath = path.join(payload, 'ai', 'ComfyUI', 'extra_model_paths.yaml');
  if (fs.existsSync(yamlPath)) {
    const modelsPath = path.join(TARGET, 'ai', 'models').split(path.sep).join('/');
    const yaml = fs.readFileSync(yamlPath, 'utf8');
    const updated = yaml.replace(/^(\s*base_path:\s*).*$/m, '$1' + modelsPath);
    if (updated === yaml) die('extra_model_paths.yaml の base_path を書き換えられませんでした');
    fs.writeFileSync(yamlPath, updated);
    say('       extra_model_paths.yaml : base_path → ' + modelsPath);
  } else {
    die('extra_model_paths.yaml がありません（ComfyUI がモデルを見つけられなくなります）');
  }

  // start-comfyui.bat を埋め込み Python 向けに置き換える。
  // 資材側の bat は venv を前提にしているので、そのまま配ると当日動かない。
  const startBat = [
    '@echo off',
    'REM ============================================================',
    'REM  KidsPG 2026 用 ComfyUI 起動スクリプト（当日PC / CPU モード）',
    'REM',
    'REM  make-onsite-package.cjs が書き出したもの。手で直さないこと',
    'REM  （作り直すと上書きされる）。',
    'REM',
    'REM  ・Python は隣の python_embeded を使う（インストール不要・',
    'REM    ユーザー名に依存しない）。venv は別PCへコピーすると壊れるため使わない。',
    'REM  ・出力は logs\\ に落とす。コンソールに垂れ流すと、うっかりウィンドウ内を',
    'REM    クリックした瞬間に QuickEdit の範囲選択で出力がブロックされ ComfyUI が止まる。',
    'REM  ・落ちたら自動で上げ直す。落ちてもアプリ側は静かに退避してしまい気づけないため。',
    'REM',
    'REM  確認: http://127.0.0.1:8188/system_stats が JSON を返せば起動完了',
    'REM ============================================================',
    'setlocal',
    'cd /d "%~dp0"',
    'if not exist "logs" mkdir "logs"',
    '',
    'REM CPU 実行は全論理コアを食い尽くす。同じPCで動くゲーム(Electron + WebGL)が',
    'REM カクついて操作不能になるため絞る。',
    'set OMP_NUM_THREADS=6',
    '',
    'REM Python のライブラリが勝手に外へ書くキャッシュを、このフォルダの中へ寄せる。',
    'REM 当日PCは「1つのフォルダで完結」させる方針（片付けはフォルダを消すだけ、',
    'REM 持ち帰りは丸ごとコピーだけ、を保つ）。既定では %USERPROFILE%\\.cache 配下に',
    'REM 作られる。いまのワークフローは手元の safetensors だけを使うので実際には',
    'REM ほとんど書かれないが、外に出る経路は先に塞いでおく。',
    'set "HF_HOME=%~dp0..\\cache\\huggingface"',
    'set "HF_HUB_CACHE=%~dp0..\\cache\\huggingface\\hub"',
    'set "TRANSFORMERS_CACHE=%~dp0..\\cache\\huggingface\\transformers"',
    'set "TORCH_HOME=%~dp0..\\cache\\torch"',
    'set "XDG_CACHE_HOME=%~dp0..\\cache"',
    'REM 🔴 オフラインで動かす。モデルを探しに外へ出て待たされるのを防ぐ',
    'set HF_HUB_OFFLINE=1',
    'set TRANSFORMERS_OFFLINE=1',
    'if not exist "%~dp0..\\cache" mkdir "%~dp0..\\cache"',
    '',
    'set "COMFY_PY=%~dp0..\\python_embeded\\python.exe"',
    'if not exist "%COMFY_PY%" (',
    '  echo [ERROR] python_embeded が見つかりません: %COMFY_PY%',
    '  echo         0_setup.bat をやり直してください。',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    'set COMFY_ARGS=--cpu --listen 127.0.0.1 --port 8188 --disable-auto-launch',
    '',
    ':loop',
    'echo [%date% %time%] starting: %COMFY_ARGS% >> "logs\\supervisor.log"',
    '"%COMFY_PY%" main.py %COMFY_ARGS% >> "logs\\comfyui.log" 2>&1',
    'echo [%date% %time%] exited with %ERRORLEVEL% - restarting in 5s >> "logs\\supervisor.log"',
    'REM 🔴 timeout は stdin が無いと即エラーで抜ける',
    'REM    （"ERROR: Input redirection is not supported" / 終了コード 1）。',
    'REM    アプリ経由でこのバッチを起こすと stdio は NUL なので、待ちが消えて',
    'REM    1秒に何百回もループし、ログでディスクを埋める。ping で待つ。',
    'ping -n 6 127.0.0.1 > nul',
    'goto loop',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(payload, 'ai', 'ComfyUI', 'start-comfyui.bat'), startBat);
  say('       start-comfyui.bat : 埋め込み Python（../python_embeded）向けに書き出しました');
}

// ------------------------------------------------------------------ 7. 入口と手順書
step('7/8', 'セットアップ用の入口と手順書');
copyFile(path.join(__dirname, 'onsite', '0_setup.bat'), path.join(outDir, '0_セットアップ.bat'));
// 暖機は**当日PC側**で（コピー後に）実行するので、payload の直下に置く。
// これが C:\kidspg\ウォームアップ.bat になる。
// 🔴 Smart App Control をオフにせずに済ませるための要。前日までにオンラインで通す
copyFile(path.join(__dirname, 'onsite', 'warmup.bat'), path.join(payload, 'ウォームアップ.bat'));
// 0_セットアップ.bat が隣から呼ぶ。忘れると照合だけが黙って飛ぶ
copyFile(path.join(__dirname, 'onsite', 'verify-copy.ps1'), path.join(outDir, 'verify-copy.ps1'));
copyFile(path.join(ROOT, 'docs', 'setup-onsite.md'), path.join(outDir, '1_当日手順書.md'));
// ComfyUI の構築手順も入れる。当日PCでは作り直せない（オフラインで pip も使えない）が、
// 「どう組んだものが入っているのか」が分からないと、壊れたときに何も判断できない。
// ⚠️ この文書は venv 前提で書かれている。当日PCに入るのは埋め込み Python なので、
//    Python の作り方の節は docs/distribution-plan.md のほうが正しい。
//    その読み替えは 1_当日手順書.md の中で案内している。
copyFile(
  path.join(ROOT, 'docs', 'comfyui-local-setup.md'),
  path.join(outDir, '2_ComfyUI構築手順（参考・開発機向け）.md')
);
copyFile(
  path.join(ROOT, 'docs', 'distribution-plan.md'),
  path.join(outDir, '3_このパッケージの設計.md')
);

// ------------------------------------------------------------------ 8. 目録と自己検証
step('8/8', '目録（manifest / SHA256SUMS）と自己検証');

// 積み忘れの検出。dist/main が require している外部モジュールが揃っているか。
// 依存を1つ落としても**起動はする**（ComfyUI へ画像を上げる瞬間に初めて落ちる）ので、
// 動かして確かめるより先にここで拾う。
const mainJs = [];
const collectJs = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) collectJs(p);
    else if (e.name.endsWith('.js')) mainJs.push(fs.readFileSync(p, 'utf8'));
  }
};
collectJs(path.join(appDir, 'dist', 'main'));
const unsatisfied = findUnsatisfiedRequires(mainJs, deps.packages);
if (unsatisfied.length > 0) {
  die(
    '積み忘れがあります（dist/main が require しているのに node_modules に無い）: ' +
      unsatisfied.join(', ')
  );
}
say('       OK : dist/main の require はすべて解決できます');

// 🔴 **持ち出してはいけないものが混じっていないか。**
// 開発機の ComfyUI の input/ には検証で使った実際の顔写真が溜まる
// （2026-09-09 の時点で 44 件あった）。除外の指定を1つ書き忘れただけで
// USB に載る。組み立てたあとに機械的に見る（理由は onsite-package-lib.cjs）。
const allPayloadFiles = [];
const listFiles = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) listFiles(p);
    else if (e.isFile()) allPayloadFiles.push(path.relative(payload, p));
  }
};
listFiles(payload);
const forbidden = findForbiddenFiles(allPayloadFiles);
if (forbidden.length > 0) {
  console.error('\n✗ 持ち出してはいけないものが混じっています:\n');
  for (const f of forbidden.slice(0, 20)) {
    console.error('  ・' + f.file + '  … ' + f.why);
  }
  if (forbidden.length > 20) console.error('  ほか ' + (forbidden.length - 20) + ' 件');
  console.error('\n  資材置き場から取り除いてから作り直してください。');
  console.error('  ComfyUI の input/ と output/ は持ち出しません（顔写真が入っています）。');
  process.exit(1);
}
say('       OK : 顔写真・生成画像・カードは入っていません（' + allPayloadFiles.length + ' ファイル検査）');

const total = dirSize(payload);
const manifest = {
  createdAt: new Date().toISOString(),
  appVersion: originalPkg.version,
  gitCommit: gitInfo.commit,
  gitDirty: gitInfo.dirty,
  launchMode: 'electron（exe は作らない。理由は docs/distribution-plan.md）',
  // 🔴 0_セットアップ.bat はこれと実際のコピー先を突き合わせ、違ったら止まる。
  // config.json の中の絶対パスがこの場所を前提にしているため。
  target: TARGET,
  builtOn: { node: process.version, platform: process.platform },
  appOnly: APP_ONLY,
  runtimeDeps: deps.packages,
  sections: { app: appSize, ops: opsSize },
  materials: materialReport,
  payload: total,
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
say('       payload 合計 : ' + mb(total.bytes) + ' / ' + total.files + ' ファイル');

if (NO_HASH) {
  say('       ＊ --no-hash なので SHA256SUMS は作りません');
} else {
  say('       SHA256SUMS を作ります（コピー漏れと破損の検出用。数分かかります）…');
  const lines = [];
  const hashWalk = (d) => {
    const entries = fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) hashWalk(p);
      else if (e.isFile()) {
        const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        lines.push(h + '  ' + path.relative(outDir, p).split(path.sep).join('/'));
      }
    }
  };
  hashWalk(payload);
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), lines.join('\n') + '\n');
  say('       OK : ' + lines.length + ' ファイル分');
}

console.log('\n✓ できました: ' + outDir);
console.log('  当日PCでは 0_セットアップ.bat を実行してください（1_当日手順書.md に手順）');
if (APP_ONLY) {
  console.log('  ⚠️ --app-only で作ったので、ai / bin が入っていません。当日には使えません。');
}
