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
  // ⚠️ 区切りは `\` と `/` の**両方**を見る。呼び出し側は path.relative の
  // 結果（Windows では superseded_x\\foo.png）を渡すので、/ だけを見ていると
  // 1段深い場所に置かれた瞬間に除外が外れる（敵対的レビュー 2026-09-09 の指摘）。
  relativePath.split(/[\\\/]/).some((seg) => seg.startsWith('superseded_'));

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

/**
 * 🔴 **いま使っているもの以外は全部「知らないもの」として挙げる。**
 *
 * 以前は KNOWN_UNUSED_RENDERER_IMAGES（既知の6つ）が戻っていないかだけを
 * 見ていた。しかしこのフォルダは「置いてあるだけで dist に載る」性質なので、
 * **一覧に無い名前は原理的に検出できない**——たとえば画質の詰めのために
 * 実写の顔を `kid.jpg` として置くと（config.json と README が
 * 「判断は必ず実写の顔で行うこと」と指示しているので実際に起こりうる）、
 * `dist/renderer/assets/kid.jpg` として app と ops の両方に載り、
 * 名前のパターン検査にも1つも当たらないまま USB へ出ていた
 * （敵対的レビュー 2026-09-09 の指摘）。
 *
 * そこで判定を逆にする。**使っているものを列挙し、それ以外を挙げる。**
 * ここは assets.ts の IMAGE_ASSET_RELATIVE_PATHS と揃えること
 * （片方だけ増やすと「使っているのに知らないもの扱い」になるが、
 * その場合も**止まる方向**なので安全側に倒れる）。
 */
const USED_RENDERER_IMAGES = [
  'title_gummy_01.png',
  'dummy_photo.png',
];

/**
 * OS が勝手に作るもの。**これで npm run check を落としてはいけない。**
 *
 * 🔴 このリポジトリは OneDrive 配下にあるので `Thumbs.db` や `desktop.ini` が
 * 現れる。反転した検出をそのまま厳格アサーションに繋いだため、
 * それだけで `npm test` が落ち、`make-onsite-package` の
 * 「npm run check が通りませんでした」で**パッケージを作れなくなる**
 * （逃げ道は --skip-check だけ。敵対的レビュー 2026-09-09 の指摘）。
 * これらは Vite の動的パターンでも読み込み対象にならない（画像ではない）。
 */
const OS_BOOKKEEPING_FILES = ['Thumbs.db', 'desktop.ini', '.DS_Store'];

/**
 * 参照されていない画像を挙げる。
 *
 * 判定は「使っているもの以外は全部」（USED_RENDERER_IMAGES の注釈）。
 * ただし OS が作るものと**フォルダ**は除く——フォルダは
 * `superseded_2025/` のような退避先を作る運用（このリポジトリでは
 * リポジトリ直下に置いてある）と衝突するし、そもそもファイル名ではない。
 * フォルダの中に画像を置いた場合は dist に載るので、
 * **中身を1段だけ覗いて挙げる**（見逃すより挙げるほうを選ぶ）。
 */
const findStrayRendererImages = (imagesDir) => {
  let entries;
  try {
    entries = fs.readdirSync(imagesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const stray = [];
  for (const entry of entries) {
    if (OS_BOOKKEEPING_FILES.includes(entry.name)) continue;
    if (entry.isDirectory()) {
      // 1段だけ覗く。中に画像があると dist に載る
      let inner = [];
      try {
        inner = fs.readdirSync(path.join(imagesDir, entry.name));
      } catch {
        inner = [];
      }
      for (const name of inner) {
        if (OS_BOOKKEEPING_FILES.includes(name)) continue;
        stray.push(entry.name + '/' + name);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (USED_RENDERER_IMAGES.includes(entry.name)) continue;
    stray.push(entry.name);
  }
  return stray.sort();
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

/**
 * 🔴 **名前ではなく「場所」で禁じる。**
 *
 * 名前のパターンだけに頼ると、想像していない名前が素通りする。実例:
 *   ・ComfyUI が PreviewImage で書く `ComfyUI_temp_xxxxx_00001_.png`（temp/）
 *   ・`user/comfyui.db`（開いたワークフローと入力画像名の履歴が入る）
 *   ・拡張子違いの写真（`.jpg`）、カメラ由来の `IMG_1234.jpg`
 * いずれも上の4パターンに1つも当たらない（敵対的レビュー 2026-09-09 の指摘）。
 *
 * ComfyUI のこの4フォルダは**当日PCでは空で配る**もので、中身が入っている
 * ということは開発機で動かした痕跡がそのまま載っているということ。
 * 名前を想像するのをやめて、**この下にファイルがあれば全部アウト**にする。
 */
const FORBIDDEN_LOCATIONS = [
  { prefix: 'ai/ComfyUI/input', why: 'ComfyUI の input（撮影した顔写真が溜まる）' },
  { prefix: 'ai/ComfyUI/output', why: 'ComfyUI の output（顔写真から作った絵）' },
  { prefix: 'ai/ComfyUI/temp', why: 'ComfyUI の temp（プレビュー画像が溜まる）' },
  { prefix: 'ai/ComfyUI/user', why: 'ComfyUI の user（開いた画像名の履歴が入る）' },
  // 当日の成果物。パッケージには絶対に入らない（0_setup も /XD で守っている）
  { prefix: 'app/results', why: '当日の成果物（顔写真・カードが入る）' },
  { prefix: 'ops/results', why: '当日の成果物（顔写真・カードが入る）' },
  { prefix: 'app/logs', why: '当日のログ（ファイル名から写真が辿れる）' },
];

/**
 * 素材ではなく**リポジトリ側**にある「これは配ってよいのか」を見る対象。
 *
 * 🔴 顔写真の検査が ComfyUI 配下にしか効いていなかった
 * （敵対的レビュー 2026-09-09 の指摘）。`assets/` や
 * `src/renderer/assets/images/` へ実写を置くと、payload の
 * `app/assets`・`ops/assets`・`app/dist` として**6.4GB 書き終えたあと**に
 * ようやく検出され、しかも消さないので USB 上に残っていた。
 * コピーする前に、リポジトリ側のこれらを見る。
 */
const REPO_SOURCE_DIRS_TO_SCAN = [
  'assets',
  'card_base_images',
  'src/renderer/assets/images',
  'dist/renderer/assets',
];

const findForbiddenFiles = (files) => {
  const hits = [];
  for (const file of files) {
    const normalized = file.split(/[\\/]/).join('/');
    // 場所で禁じる（こちらが主）
    const place = FORBIDDEN_LOCATIONS.find(
      (l) => normalized === l.prefix || normalized.startsWith(l.prefix + '/')
    );
    if (place) {
      hits.push({ file, why: place.why });
      continue;
    }
    // 名前で禁じる（場所の外に出てしまったものの保険）
    const name = normalized.split('/').pop();
    const named = FORBIDDEN_PAYLOAD_PATTERNS.find(({ pattern }) => pattern.test(name));
    if (named) hits.push({ file, why: named.why });
  }
  return hits;
};

/**
 * 当日PC 用の start-comfyui.bat の中身を作る。
 *
 * ■ なぜここに置くか
 * 以前は make-onsite-package.cjs の中に文字列の配列として埋め込まれており、
 * **生成物に対するテストが1本も書けなかった**。実際、
 *   ・chcp 65001 と ASCII のみのブートストラップが無く、日本語コンソールでは
 *     唯一のエラーメッセージ（python_embeded が無い）が文字化けする
 *   ・落ちたら上げ直すループに**上限が無く**、8188 番が埋まっていると
 *     5秒ごとに torch を読み込み直して CPU とディスクを食い続ける
 * という2つが、他の bat では守られている決めごとから外れていた
 * （敵対的レビュー 2026-09-09 の指摘）。関数にして固定する。
 *
 * 🔴 戻すのは CRLF の文字列。cmd は LF だけの bat を正しく行分割できない。
 */
const buildStartComfyUIBat = () => [
    '@echo off',
    'REM ---------------------------------------------------------------',
    'REM  ASCII-only bootstrap. DO NOT put Japanese text above ":main".',
    'REM  A Japanese (CP932) console mis-parses this UTF-8 file, and the',
    'REM  only error message this script has (python_embeded missing)',
    'REM  becomes unreadable. Same rule as start-kidspg.bat and',
    'REM  the generated regen bat.',
    'REM ---------------------------------------------------------------',
    'chcp 65001 > nul',
    'if "%KIDSPG_COMFY_BOOT%"=="1" goto :main',
    'set "KIDSPG_COMFY_BOOT=1"',
    'cmd /d /c ""%~f0" %*"',
    'exit /b %errorlevel%',
    '',
    ':main',
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
    'REM 🔴 上げ直しに上限を付ける。上限が無いと、8188 番が既に埋まっている場合',
    'REM    （start-kidspg.bat が先に起こしていた／このバッチを二重に叩いた）に',
    'REM    python が bind に失敗して即死し、**5秒ごとに torch を読み込み直す**。',
    'REM    CPU を食い続け、ログでディスクを埋め、誰にも通知されない',
    'REM    （敵対的レビュー 2026-09-09 の指摘）。',
    'REM    ふつうの運用（落ちたら上げ直す）には 20 回もあれば足りる。',
    'set /a TRIES=0',
    'set TRYMAX=20',
    '',
    ':loop',
    'set /a TRIES+=1',
    'echo [%date% %time%] starting (try %TRIES%/%TRYMAX%): %COMFY_ARGS% >> "logs\\supervisor.log"',
    '"%COMFY_PY%" main.py %COMFY_ARGS% >> "logs\\comfyui.log" 2>&1',
    'echo [%date% %time%] exited with %ERRORLEVEL% - restarting in 5s >> "logs\\supervisor.log"',
    'if %TRIES% GEQ %TRYMAX% (',
    '  echo [%date% %time%] giving up after %TRIES% tries >> "logs\\supervisor.log"',
    '  echo.',
    '  echo   ComfyUI was restarted %TRIES% times and keeps exiting. Giving up.',
    '  echo   Check logs\\comfyui.log. If port 8188 is already in use,',
    '  echo   another ComfyUI is running - close this window and use that one.',
    '  echo.',
    '  pause',
    '  exit /b 1',
    ')',
    'REM 🔴 timeout は stdin が無いと即エラーで抜ける',
    'REM    （"ERROR: Input redirection is not supported" / 終了コード 1）。',
    'REM    アプリ経由でこのバッチを起こすと stdio は NUL なので、待ちが消えて',
    'REM    1秒に何百回もループし、ログでディスクを埋める。ping で待つ。',
    'ping -n 6 127.0.0.1 > nul',
    'goto loop',
    '',
].join('\r\n');

module.exports = {
  buildStartComfyUIBat,
  findForbiddenFiles,
  FORBIDDEN_PAYLOAD_PATTERNS,
  FORBIDDEN_LOCATIONS,
  buildOnsitePackageJson,
  collectRuntimeDeps,
  findUnsatisfiedRequires,
  shouldSkipCardBaseEntry,
  findStrayRendererImages,
  OS_BOOKKEEPING_FILES,
  KNOWN_UNUSED_RENDERER_IMAGES,
  USED_RENDERER_IMAGES,
  REPO_SOURCE_DIRS_TO_SCAN,
  NODE_BUILTINS,
};
