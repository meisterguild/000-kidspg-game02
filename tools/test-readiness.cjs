#!/usr/bin/env node
/**
 * 「準備OK」の判定と、起動バッチとの取り決めの単体テスト
 *
 *   npm run build && node --test tools/test-readiness.cjs
 *
 * ■ 何を守っているか
 * 当日の運用は「モニタとPCを置く → 電源 → 起動バッチ → 準備完了」だけにしたい。
 * その「準備完了」がここの判定にかかっている。間違えると次の2つが起きる。
 *
 *   ・**準備できていないのに準備完了と出る** … いちばん危ない。
 *     カメラが無い（全員ダミー写真）・ComfyUI が落ちている（全員同じ絵）・
 *     results に書けない（カードが1枚も残らない）まま開場してしまう
 *   ・準備できているのに準備できていないと出る … 当日その場で原因を探すことになる
 *
 * 起動バッチ側の取り決め（印を消す順番・中止経路の扱い）も、間違えると
 * 「起動していないのに準備完了」になるのでここで縛る。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'dist', 'main', 'main', 'services', 'readiness.js');
if (!fs.existsSync(MODULE_PATH)) {
  throw new Error(`dist が見つかりません。先に \`npm run build\` を実行してください: ${MODULE_PATH}`);
}
const {
  classifyReadiness,
  checkResultsWritable,
  clearReadiness,
  readinessFilePath,
  writeReadiness,
} = require(MODULE_PATH);

/** 何も問題が無い状態 */
const healthy = (overrides = {}) => ({
  assetsLoaded: true,
  cameraReady: true,
  usingDummyCamera: false,
  screen: 'TOP',
  readyAt: '2026-09-12T01:02:03.000Z',
  appVersion: '1.0.0',
  packaged: false,
  pid: 1234,
  comfyui: { profile: 'local', baseUrl: 'http://127.0.0.1:8188', healthy: true },
  results: { dir: 'C:\\kidspg\\app\\results', writable: true },
  configLoaded: true,
  memorialCard: {
    enabled: true,
    ready: true,
    magickCommand: 'C:\\kidspg\\bin\\ImageMagick\\magick.exe',
    magickUsable: true,
  },
  ...overrides,
});

// ---------------------------------------------------------------- 判定

/**
 * 🔴 **ここの分け方が当日の運用判断そのもの。**
 * 当日手順書は「★★★ 準備完了 ★★★ が出たら受付を開けてよい」と約束している。
 * blockers に入れるのは「本当に遊べないもの」だけ。遊べるのに開場を止めると
 * 回復手段が無いまま列が止まる（敵対的レビュー 2026-09-09 の指摘）。
 */
test('すべて整っていれば blockers も notes も空（＝★★★ 準備完了 ★★★）', () => {
  const r = classifyReadiness(healthy());
  assert.deepStrictEqual(r.blockers, []);
  assert.deepStrictEqual(r.notes, []);
});

test('results に書けないのは「遊べない」（カードが1枚も残らない）', () => {
  const r = classifyReadiness(healthy({ results: { dir: 'D:/x', writable: false } }));
  assert.strictEqual(r.blockers.length, 1);
  assert.match(r.blockers[0], /書き込めません/);
  assert.match(r.blockers[0], /D:\/x/);
  assert.deepStrictEqual(r.notes, []);
});

test('素材が読めていないのは「遊べない」（コピーが不完全）', () => {
  const r = classifyReadiness(healthy({ assetsLoaded: false }));
  assert.strictEqual(r.blockers.length, 1);
  assert.match(r.blockers[0], /背景アセット/);
});

test('カメラの初期化が決着していないのは「遊べない」（撮影画面で止まりうる）', () => {
  const r = classifyReadiness(healthy({ cameraReady: false }));
  assert.strictEqual(r.blockers.length, 1);
  assert.match(r.blockers[0], /初期化が終わっていません/);
  assert.match(r.blockers[0], /プライバシー/);
});

test('カメラが無いのは「遊べるが困る」（全員ダミー写真）', () => {
  const r = classifyReadiness(healthy({ usingDummyCamera: true }));
  assert.deepStrictEqual(r.blockers, [], '遊べるのに開場を止めています');
  assert.strictEqual(r.notes.length, 1);
  assert.match(r.notes[0], /カメラ/);
});

test('ComfyUI が落ちているのは「遊べるが困る」（絵が全員同じ）', () => {
  const r = classifyReadiness(
    healthy({ comfyui: { profile: 'local', baseUrl: 'http://127.0.0.1:8188', healthy: false } })
  );
  assert.deepStrictEqual(r.blockers, [], '遊べるのに開場を止めています');
  assert.strictEqual(r.notes.length, 1);
  assert.match(r.notes[0], /127.0.0.1:8188/);
});

test('AI 変換を意図して切った構成を異常扱いにしない', () => {
  // README の退避策「config.json の comfyui セクションごと外す」を採った状態。
  // 以前はこれで「準備できていません」と出て、最後の逃げ道を塞いでいた
  const r = classifyReadiness(healthy({ comfyui: null }));
  assert.deepStrictEqual(r.blockers, [], '意図した構成を遊べない扱いにしています');
  assert.strictEqual(r.notes.length, 1);
  assert.match(r.notes[0], /意図した構成なら問題ありません/);
});

/**
 * 🔴 ここから3件は「準備完了と出るのに遊べない」を塞ぐためのもの。
 * いずれも 2026-09-09 の敵対的レビューで見つかった経路で、共通点は
 * **TOP 画面までは描けてしまう**ため renderer 側は準備完了と報告すること。
 */
test('config.json が読めていないのは「遊べない」（画面が読み込み中で止まる）', () => {
  const r = classifyReadiness(healthy({ configLoaded: false }));
  assert.ok(r.blockers.length >= 1, '遊べないのに開場を止めていません');
  assert.match(r.blockers.join('\n'), /config\.json/);
});

test('config が読めないとき、ComfyUI の注意書きが「問題ありません」にならない', () => {
  // 以前はこの状態で comfyui が null になり、唯一の表示が
  // 「意図した構成なら問題ありません」だった（正反対の案内）
  const r = classifyReadiness(healthy({ configLoaded: false, comfyui: null }));
  assert.ok(r.blockers.length >= 1, 'blocker が立っていません');
  assert.match(r.blockers.join('\n'), /config\.json/);
});

test('記念カードの設定が無いのは「遊べない」（カードが1枚も作られない）', () => {
  const r = classifyReadiness(
    healthy({ memorialCard: { enabled: true, ready: false, magickCommand: 'magick', magickUsable: true } })
  );
  assert.ok(r.blockers.length >= 1);
  assert.match(r.blockers.join('\n'), /memorialCard/);
});

test('ImageMagick を起動できないのは「遊べない」（results に書けないのと同じ結果）', () => {
  const r = classifyReadiness(
    healthy({ memorialCard: { enabled: true, ready: true, magickCommand: 'magick', magickUsable: false } })
  );
  assert.ok(r.blockers.length >= 1, 'カードが0枚になるのに開場を止めていません');
  assert.match(r.blockers.join('\n'), /ImageMagick/);
  // 「どこを見ればよいか」まで出す（当日その場で判断するため）
  assert.match(r.blockers.join('\n'), /magick/);
});

test('遊べないものと困ることが重なったら、両方を挙げる', () => {
  const r = classifyReadiness(
    healthy({
      usingDummyCamera: true,
      results: { dir: 'D:/x', writable: false },
      comfyui: { profile: 'local', baseUrl: 'http://x', healthy: false },
    })
  );
  assert.strictEqual(r.blockers.length, 1);
  assert.strictEqual(r.notes.length, 2);
});

// ---------------------------------------------------------------- 印の読み書き

test('印は書いたとおりに読める（起動バッチが JSON として読む）', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kidspg-ready-'));
  const report = { ...healthy(), blockers: [], notes: [] };
  await writeReadiness(base, report);
  const file = readinessFilePath(base);
  assert.ok(fs.existsSync(file));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), report);
  // 書きかけを読ませないための一時ファイルが残っていないこと
  assert.ok(!fs.existsSync(file + '.tmp'));
  fs.rmSync(base, { recursive: true, force: true });
});

test('印は logs の下に置く（当日「様子を見るならこのフォルダ」を1つに絞る）', () => {
  assert.strictEqual(
    readinessFilePath(path.join('C:', 'kidspg', 'app')),
    path.join('C:', 'kidspg', 'app', 'logs', 'ready.json')
  );
});

test('印を消せる。無いところで消しても落ちない', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kidspg-ready-'));
  await writeReadiness(base, { ...healthy(), blockers: [], notes: [] });
  await clearReadiness(base);
  assert.ok(!fs.existsSync(readinessFilePath(base)));
  // 2回目（もう無い）でも例外にしない
  await clearReadiness(base);
  await clearReadiness(path.join(base, 'そんなフォルダは無い'));
  fs.rmSync(base, { recursive: true, force: true });
});

test('results に書けるかは、実際に書いて確かめる（書き跡を残さない）', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kidspg-results-'));
  const dir = path.join(base, 'results');
  assert.strictEqual(await checkResultsWritable(dir), true);
  // フォルダが無ければ作る。確かめるために置いたファイルは片付ける
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 起動バッチとの取り決め

const startBat = () => fs.readFileSync(path.join(ROOT, 'start-kidspg.bat'), 'utf8');

test('起動バッチは古い印を消し、**消せたことを確かめる**', () => {
  const raw = startBat();
  // 🔴 前回の印が残っていると、今回起動に失敗しても待ち時間ゼロで
  // 「準備完了」と出る（当日いちばん危ない壊れ方）。
  // 以前は del の結果を > nul で潰し、消せたかを見ていなかった
  // （敵対的レビュー 2026-09-09 の指摘）。
  assert.match(raw, /^:clear_ready/m, ':clear_ready がありません');
  const routine = raw.slice(raw.indexOf(':clear_ready'));
  const delAt = routine.indexOf('del /f /q "!READY_FILE!"');
  assert.ok(delAt > 0, '消していません');
  // del のあとに存在を確かめ、失敗を呼び出し側へ伝えること
  const checkAt = routine.indexOf('if not exist "!READY_FILE!" exit /b 0', delAt);
  assert.ok(checkAt > delAt, 'del のあとに消せたかを確かめていません');
  assert.match(routine, /READY_CLEAR_FAILED=1/, '失敗を呼び出し側へ伝えていません');
});

test('消せなかったら起動しない（「準備完了」と言わせない）', () => {
  const raw = startBat();
  const callAt = raw.indexOf('call :clear_ready');
  assert.ok(callAt > 0, ':clear_ready を呼んでいません');
  const after = raw.slice(callAt, callAt + 400);
  assert.match(after, /if defined READY_CLEAR_FAILED/, '失敗を見ていません');
  assert.match(after, /STOP_BEFORE_LAUNCH=1/, '中止の印を立てていません');
  // アプリを起こすより前に呼ぶこと
  const appLaunchAt = raw.indexOf('set "LD_PATHARG=%~dp0."');
  assert.ok(appLaunchAt > callAt, 'アプリを起こしたあとに消しています');
});

test('すでに生きている場合も印を消して測り直させる', () => {
  const raw = startBat();
  // 以前は「生きているときは消さない」形だった。報告が1回だけなので消すと
  // 必ず時間切れになるためだが、そのぶん**何時間前の印でも準備完了と読んでいた**
  // （敵対的レビュー 2026-09-09 の指摘）。
  // main が second-instance で再報告を依頼するようにしたので、常に消せる。
  const callAt = raw.indexOf('call :clear_ready');
  const alreadyAt = raw.indexOf('if defined ALREADY_LIVE');
  assert.ok(callAt > 0 && alreadyAt > 0);
  assert.ok(callAt < alreadyAt, 'すでに生きている分岐より後で消しています');
  const main = fs.readFileSync(path.join(ROOT, 'src/main/main.ts'), 'utf8');
  assert.match(main, /request-ready-report/, 'main が再報告を依頼していません');
  const hook = fs.readFileSync(path.join(ROOT, 'src/renderer/hooks/useReportReady.ts'), 'utf8');
  assert.match(hook, /onRequestReadyReport/, 'renderer が再報告の依頼を受けていません');
});

test('判定がいつのものかを表示する', () => {
  const raw = startBat();
  // 判定は「その瞬間のスナップショット」で、報告後に ComfyUI が落ちても
  // 印は変わらない。時刻が出ていれば「さっきの話か」と判断できる
  assert.match(raw, /RAT=/, '判定時刻を読んでいません');
  assert.match(raw, /判定時刻 !RAT!/, '判定時刻を表示していません');
});

test('起動バッチは印を待ち、出なければ準備できていないと言う', () => {
  const raw = startBat();
  assert.match(raw, /\[7\/7\] 準備確認/);
  assert.match(raw, /READY_WAIT/);
  assert.match(raw, /READY_NG/);
  assert.match(raw, /準備完了/);

  // 🔴 **文字列があるかだけでは、条件を反転しても通る。**
  //    実測（3巡目のレビュー）: `if not "!RBLOCK!"=="0" (` を `if "!RBLOCK!"=="0" (`
  //    に反転しても、`if not defined RBLOCK set "RBLOCK=-1"` を
  //    `set "RBLOCK=0"` にしても、41件すべて緑だった。
  //    ここは当日手順書の「★★★ 準備完了 ★★★ が出たら受付を開けてよい」という
  //    約束そのものなので、条件式まで縛る。

  // 1) 遊べないもの（blockers）が1件でもあれば READY_NG を立てる
  const ngAt = raw.indexOf('set /a WARN+=!RBLOCK!');
  assert.ok(ngAt > 0, 'blockers の件数を WARN に足していません');
  const ifs = [...raw.slice(0, ngAt).matchAll(/if (not )?"!RBLOCK!"=="0" \(/g)];
  assert.ok(ifs.length > 0, 'RBLOCK による分岐が見つかりません');
  assert.strictEqual(
    ifs[ifs.length - 1][1],
    'not ',
    'blockers が 0 のときに READY_NG を立てています（条件が反転しています）'
  );
  assert.match(
    raw.slice(ngAt, ngAt + 200),
    /set "READY_NG=1"/,
    'blockers があるのに READY_NG を立てていません'
  );

  // 2) ready.json を読めなかったときは「読めた」ことにしない
  assert.match(
    raw,
    /if not defined RBLOCK set "RBLOCK=-1"/,
    '報告を読めなかったときに素通りします（-1 にしていません）'
  );
  const unknownAt = raw.indexOf('if "!RBLOCK!"=="-1" (');
  assert.ok(unknownAt > 0, '「読めなかった」の分岐がありません');
  assert.match(
    raw.slice(unknownAt, unknownAt + 300),
    /set "READY_NG=1"/,
    '報告を読めなくても準備完了と言います'
  );

  // 3) まとめは READY_NG を見て分岐する
  assert.match(
    raw,
    /if defined READY_NG goto :sum_notready/,
    'まとめが READY_NG を見ていません'
  );
});

test('準備できているかの入口（書き込みの実測）が、成功も失敗も返す', async () => {
  // 🔴 classifyReadiness は12本のテストで丁寧に見ているのに、その**入力**を
  //    作るところは「書ける場合に true」しか試していなかった。実測（3巡目）:
  //    main.ts の `writable: await checkResultsWritable(...)` を `writable: true`
  //    に潰しても41件すべて緑だった。false 側を1本足しておく。
  const okDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kidspg-ready-'));
  try {
    assert.strictEqual(await checkResultsWritable(okDir), true, '書ける場所で false を返しました');
  } finally {
    fs.rmSync(okDir, { recursive: true, force: true });
  }
  // 存在しないドライブレターは Windows で確実に失敗する
  assert.strictEqual(
    await checkResultsWritable('Z:\\kidspg-does-not-exist\\results'),
    false,
    '書けない場所で true を返しました（「準備完了」が嘘になります）'
  );
});

test('準備報告の組み立てが、判定結果をそのまま載せている', () => {
  // 🔴 実測（3巡目）: main.ts で `const { notes } = classifyReadiness(base); const blockers = [];`
  //    と**判定結果を捨てて**も41件すべて緑だった。配線そのものを見る。
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.ts'), 'utf-8');
  assert.match(
    main,
    /const \{ blockers, notes \} = classifyReadiness\(/,
    '判定結果（blockers）を受け取っていません'
  );
  assert.match(
    main,
    /writable: await checkResultsWritable\(/,
    '書き込みを実測せずに報告しています'
  );
  // 受け取った blockers / notes をそのまま報告に載せていること
  const clsAt = main.indexOf('classifyReadiness(');
  const after = main.slice(clsAt, clsAt + 800);
  assert.match(after, /blockers,?\s/, '受け取った blockers を報告に載せていません');
  assert.match(after, /notes,?\s/, '受け取った notes を報告に載せていません');
});

test('中止の印を立てたら、必ずまとめへ飛ぶ', () => {
  const raw = startBat();
  // ⚠️ **件数を固定してはいけない。** 以前は「ちょうど3件」を見ていたので、
  // 正当な中止経路を足すとテストが落ち、次の人は数字を書き換えるだけで済み、
  // 「印を立てたのに goto を忘れた」は誰も見ていなかった
  // （敵対的レビュー 2026-09-09 の指摘）。立てた各所が中止へ行くかを見る。
  const lines = raw.split(/\r?\n/);
  const marks = [];
  lines.forEach((line, i) => {
    if (line.includes('set "STOP_BEFORE_LAUNCH=1"')) marks.push(i);
  });
  assert.ok(marks.length >= 3, '中止経路が想定より少ないです: ' + marks.length);
  for (const i of marks) {
    // 印の直後（数行以内）に :summary へ飛ぶこと。
    // ただし :clear_ready のように「呼び出し側で中止する」形もあるので、
    // exit /b（サブルーチンからの復帰）も認める
    const near = lines.slice(i, i + 4).join('\n');
    assert.match(
      near,
      /goto :summary|exit \/b/,
      (i + 1) + ' 行目で印を立てたあと、まとめへ行く経路がありません'
    );
  }
  assert.match(raw, /if defined STOP_BEFORE_LAUNCH goto :sum_stopped/);
  assert.match(raw, /アプリは起動していません/);
});

/**
 * 🔴 **バッチを実際に動かす唯一のテスト。**
 *
 * これまでのテストはすべてソースを文字列として grep するだけだったので、
 * 変数展開の事故（`set /a WARN+=` の `Missing operand.`）・ラベルの取り違え・
 * 文字化けを1つも捕まえられなかった（敵対的レビュー 2026-09-09 の指摘）。
 * `/dryrun` は**何も起動しない**ので、テストから安全に通せる。
 */
test('/dryrun が最後まで通り、英語のエラーや文字化けを出さない', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows 以外では cmd を動かせません');
    return;
  }
  // 絶対パスで渡す。カレント頼みだと環境によって
  // 「内部コマンドまたは外部コマンドとして認識されていません」になる（実測）
  const out = spawnSync('cmd', ['/c', path.join(ROOT, 'start-kidspg.bat'), '/dryrun'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    input: '',
  });
  const text = (out.stdout || '') + (out.stderr || '');
  assert.ok(text.length > 0, 'バッチが何も出力しませんでした');

  // 7段すべてを通ること（ラベルの取り違えで飛ばされていないか）
  for (let i = 1; i <= 7; i++) {
    assert.ok(text.includes('[' + i + '/7]'), '[' + i + '/7] が出ていません');
  }
  // 何らかの結論を出して終わること
  assert.match(text, /点検 :|準備完了|準備できていません/, 'まとめが出ていません');

  // cmd / PowerShell の事故を示す文字列が出ていないこと
  for (const bad of [
    'Missing operand',
    'is not recognized',
    'was unexpected at this time',
    'The syntax of the command is incorrect',
    'Unexpected token',
  ]) {
    assert.ok(!text.includes(bad), 'バッチが壊れています: ' + bad);
  }
  // 文字化けの目印（CP932 誤読で出る典型）
  assert.ok(!text.includes('繧'), '文字化けしています（UTF-8 の誤読）');
});

test('まとめの分岐に else if を使わない（cmd では黙って外れることがある）', () => {
  for (const rel of ['start-kidspg.bat', 'stop-kidspg.bat', 'tools/onsite/0_setup.bat', 'tools/onsite/warmup.bat']) {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.deepStrictEqual(raw.match(/\) else if /g), null, rel + ' に else if の連鎖があります');
  }
});

test('停止バッチは印を片付ける（止まっているのに準備完了に見えないように）', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'stop-kidspg.bat'), 'utf8');
  assert.match(raw, /logs\\ready\.json/);
});

// ------------------------------------------------- フォルダ完結の取り決め

/**
 * 当日PCは「1つのフォルダで完結」させる方針（2026-09-09 判断）。
 * ComfyUI もアプリ本体も、当日できたデータも C:\kidspg の中だけで済ませる。
 * 片付けはフォルダを消すだけ、持ち帰りは丸ごとコピーだけ、にしたいため。
 *
 * 実測では既定で %APPDATA%\kidspg-game-2026 に 6.8MB（Chromium の Cache /
 * GPUCache / Local Storage / Network / Preferences）が作られていた。
 */
test('Electron のデータ置き場をアプリ配下へ寄せている', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'src/main/main.ts'), 'utf8');
  assert.match(raw, /setPath\('userData'/, 'userData を動かしていません');
  assert.match(raw, /setPath\('sessionData'/);
  assert.match(raw, /setPath\('crashDumps'/);
  // 🔴 ready より前でないと効かない
  const callAt = raw.indexOf('this.redirectAppDataIntoAppFolder()');
  const readyAt = raw.indexOf('app.whenReady()');
  assert.ok(callAt > 0, '呼び出しがありません');
  assert.ok(callAt < readyAt, 'ready より後で呼んでいます（動かしても効きません）');
});

test('OS のテンポラリへ書き出さない', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'src/main/main.ts'), 'utf8');
  // ワークフローの書き出し先が %TEMP% だとフォルダ完結が崩れる。
  // ⚠️ コメントは対象外にする——「以前は temp を使っていた」という説明が
  // 残っているだけで落ちてしまい、テストが意味を失う（最初にそれで落ちた）。
  const codeLines = raw
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
  const hits = codeLines.filter((line) => /getPath\('temp'\)/.test(line));
  assert.deepStrictEqual(
    hits,
    [],
    "app.getPath('temp') を使っています（フォルダの外へ出ます）"
  );
});

test('起動バッチは ImageMagick の一時ファイルもフォルダ内へ向ける', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'start-kidspg.bat'), 'utf8');
  assert.match(raw, /MAGICK_TEMPORARY_PATH=%~dp0tmp/);
});

test('生成する start-comfyui.bat は Python のキャッシュもフォルダ内へ向ける', () => {
  // 組み立ては tools/onsite-package-lib.cjs へ移した（生成物にテストを書けるように）。
  // ソースの文字列ではなく**生成されたバッチ**を見る
  const { buildStartComfyUIBat } = require(path.join(ROOT, 'tools', 'onsite-package-lib.cjs'));
  const bat = buildStartComfyUIBat();
  for (const name of ['HF_HOME', 'TORCH_HOME', 'XDG_CACHE_HOME']) {
    assert.ok(bat.includes(name), name + ' を設定していません');
  }
  // 当日はオフライン。外へ探しに行って待たされないように
  assert.ok(bat.includes('HF_HUB_OFFLINE=1'), 'オフライン指定がありません');
});
// ================================================================
// 当日運用スクリプトの取り決め（2026-09-09 の敵対的レビューで見つかった経路）
//
// いずれも「当日その場では直せないのに、表示は正常に見える」ものだった。
// 実機で1回確かめただけでは戻ってしまうので、ここで固定する。
// ================================================================

test('cmd の括弧ブロックの中にラベルを置いていない（ブロック全体が構文エラーになる）', () => {
  // 🔴 実測で踏んだ: "( ... )" の中にラベルがあると cmd はブロック全体を
  //    構文エラーにする（") was unexpected at this time." / 終了コード 255）。
  //    0_setup.bat のまとめでこれをやってしまい、**まとめ・警告・pause が
  //    1行も出ず窓が即閉じる**状態になった（敵対的レビュー 2026-09-09 の指摘）。
  //    ラベルと goto を足すときは括弧をやめること。
  for (const rel of [
    'start-kidspg.bat',
    'stop-kidspg.bat',
    'tools/onsite/0_setup.bat',
    'tools/onsite/warmup.bat',
  ]) {
    const bat = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    let depth = 0;
    let lineNo = 0;
    for (const line of bat.split('\r\n')) {
      lineNo += 1;
      const trimmed = line.trim();
      if (trimmed.startsWith('rem ') || trimmed.startsWith('::')) continue;
      if (depth > 0 && /^:[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
        assert.fail(rel + ':' + lineNo + ' 括弧ブロックの中にラベルがあります: ' + trimmed);
      }
      // 文字列の中の括弧は数えない（echo の ^( はエスケープ済み）
      const bare = line.replace(/\^./g, '');
      depth += (bare.match(/\(/g) || []).length;
      depth -= (bare.match(/\)/g) || []).length;
      if (depth < 0) depth = 0;
    }
  }
});

test('起動バッチは ComfyUI をローカルで起こすかを baseUrl と root で決める（プロファイル名で決めない）', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'start-kidspg.bat'), 'utf-8');
  // 🔴 手順書の退避策は activeProfile を local_light にすること。
  //    プロファイル名の一致で決めていると、その瞬間に ComfyUI を誰も起こさなくなる
  // 🔴 1つの書き方だけを禁止しても、NEQ や if not の別表記で素通りする
  //    （実測: `if /i "!PROFILE!" NEQ "local" set "COMFY_IS_LOCAL="` で41件緑だった）。
  //    COMFY_IS_LOCAL を触っている行を**全部**拾い、そこに !PROFILE! が無いことを見る。
  for (const line of bat.split('\r\n')) {
    if (!/set "COMFY_IS_LOCAL=/.test(line)) continue;
    assert.ok(
      !/!PROFILE!/.test(line),
      'プロファイル名で「ローカルかどうか」を決めています（local_light で壊れます）: ' +
        line.trim()
    );
  }
  assert.match(bat, /COMFY_IS_LOCAL/, 'baseUrl と root による判定がありません');
  assert.match(bat, /\/\/127\.0\.0\.1:/, 'baseUrl がこのPCを指すかを見ていません');
});

test('起動バッチは待受しているだけで「起動しています」と言わない', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'start-kidspg.bat'), 'utf-8');
  // 8188 番は別プロジェクトの ComfyUI や無関係なプログラムでも LISTENING になる
  // 🔴 ラベル定義があるかだけだと、呼び出しを rem で潰しても通る（実測）。
  //    **呼び出し側**を数える。
  const calls = (bat.match(/^\s*call :comfy_answers/gm) || []).length;
  assert.ok(calls >= 1, '応答の確認（:comfy_answers）を呼んでいません');
  assert.match(bat, /^:comfy_answers\s*$/m, ':comfy_answers の定義がありません');
  assert.match(bat, /system_stats/, '/system_stats を見ていません');
});

test('起動バッチは ComfyUI を二重に起こさない（起動中の印を使う）', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'start-kidspg.bat'), 'utf-8');
  assert.match(bat, /comfy-starting\.flag/, '起動中の印がありません');
  // 🔴 印が残ったまま当日詰まないよう、古い印は捨てること
  assert.match(bat, /COMFY_FLAG_FRESH/, '古い印を捨てる仕組みがありません');
});

test('起動バッチはアプリの出力をログへ落とす（当日の調べ物の入口）', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'start-kidspg.bat'), 'utf-8');
  assert.match(bat, /logs\\app\.log/, 'アプリのログを取っていません');
  // ログのために cmd で包むと窓が出る。隠していないと当日ずっと黒い窓が残る
  const launchBlock = bat.slice(bat.indexOf('[6/7]'), bat.indexOf(':launch_done'));
  assert.match(launchBlock, /LD_HIDE=1/, 'ログ用の cmd の窓を隠していません');
});

test('launch_detached はログを取るときもパス引数を渡す', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'start-kidspg.bat'), 'utf-8');
  const sub = bat.slice(bat.indexOf(':launch_detached'));
  // 🔴 以前は $log のある枝で LD_PATHARG が組み立てから漏れており、
  //    ログを取りながら Electron を起こすとアプリのフォルダ引数が落ちた
  assert.match(sub, /\$pathArg/, 'パス引数を変数に取っていません');
  const build = sub.slice(sub.indexOf('$inner='), sub.indexOf('$args=@{'));
  assert.match(build, /if\(\$pathArg\)\{\$inner\+=/, 'パス引数がログ有りの経路で渡っていません');
});

test('停止バッチはフォルダ名ではなくフルパスで自分のプロセスを絞る', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'stop-kidspg.bat'), 'utf-8');
  // 当日の置き場所は C:\kidspg\app なのでフォルダ名は "app"。
  // '*app*' は無関係な Electron アプリにほぼ全部当たる（実測3件）
  assert.ok(
    !/CommandLine -like '\*%PROJ%\*'/.test(bat),
    'フォルダ名で絞っています（当日は "app" になり無関係なアプリを落とします）'
  );
  assert.match(bat, /CommandLine -like '\*%APPDIR%\*'/, 'フルパスで絞っていません');
});

test('停止バッチは ComfyUI の監視ループも止める（5秒後に復活させない）', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'stop-kidspg.bat'), 'utf-8');
  assert.match(bat, /start-comfyui/, '監視ループを止めていません');
  // 確認側の条件も同じにする。片方だけだと「止め切ったのに残っていると出る」
  const confirm = bat.slice(bat.indexOf('残っているものの確認'));
  assert.match(confirm, /start-comfyui/, '確認側が監視ループを見ていません');
});

test('停止バッチは自分自身を巻き込まない', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'stop-kidspg.bat'), 'utf-8');
  // 🔴 条件に 'start-comfyui' という文字列を入れると、その条件を実行している
  //    powershell.exe のコマンド行にその文字列が載るので**自分が一致する**
  //    （2026-09-09 に実測。確認側が「残っています : powershell.exe」を出した）
  const count = (bat.match(/Win32_Process\*'/g) || []).length;
  assert.ok(count >= 2, '停止側と確認側の両方で自己除外していません（' + count + ' 箇所）');
});

test('SAC のパス抽出は空白を含むパスでも切れない', () => {
  // .ps1 から実際の正規表現を取り出し、実際のイベント本文で試す。
  // 🔴 以前は (\S+) だったため \Device\HarddiskVolume3\Program で切れ、
  //    Program Files や OneDrive 配下にある自分たちの資材が
  //    「無関係なソフト」に分類されていた（前日の暖機はそこで行う）
  const ps1 = fs.readFileSync(path.join(ROOT, 'tools', 'onsite', 'check-sac-blocks.ps1'), 'utf-8');
  const m = ps1.match(/-match '(attempted to load[^']+)'/);
  assert.ok(m, '正規表現が見つかりません');
  const message =
    'Code Integrity determined that a process ' +
    '(\\Device\\HarddiskVolume3\\Program Files\\Git\\usr\\bin\\bash.exe) attempted to load ' +
    '\\Device\\HarddiskVolume3\\Users\\owner\\OneDrive - A B\\kidspg\\electron.exe ' +
    'that did not meet the Enterprise signing level requirements.';
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-Command',
      '$m = $env:KIDSPG_MSG -match $env:KIDSPG_RE; if($m){ $Matches[1] } else { "NOMATCH" }'],
    { encoding: 'utf8', env: { ...process.env, KIDSPG_MSG: message, KIDSPG_RE: m[1] } }
  ).trim();
  assert.strictEqual(
    out,
    '\\Device\\HarddiskVolume3\\Users\\owner\\OneDrive - A B\\kidspg\\electron.exe',
    'パスが途中で切れています: ' + out
  );
});

test('SAC の点検は 3118 を、近い時刻のパス付き記録があれば重複として数えない', () => {
  const ps1 = fs.readFileSync(path.join(ROOT, 'tools', 'onsite', 'check-sac-blocks.ps1'), 'utf-8');
  // 実測（2026-09-09 / 30日分 57 件）では 3118 は**必ず**同じ瞬間の 3033/3077 と
  // 対で出ており、3118 単独の時刻グループは 0 件だった。無条件に数えると
  // 無関係なブロック1件で UNKNOWN が立ち、暖機の成功に原理的に到達しない
  // 🔴 突き合わせは**自分たちのパス付き**と**無関係なパス付き**を分けて持つ。
  //    以前は1つの表に混ぜていたため、自分たちの 3118 が単独で出ても
  //    ±2秒に無関係なブロックが1件あるだけで重複として捨てられ、
  //    「★★★ 暖機できました ★★★」という偽の成功になった
  //    （敵対的レビュー 2026-09-09 の指摘）。
  assert.match(ps1, /oursTimes/, '自分たちの時刻表がありません');
  assert.match(ps1, /otherTimes/, '無関係なブロックの時刻表がありません');
  const block = ps1.slice(ps1.indexOf('$e.Id -eq 3118'));
  assert.match(block, /TotalSeconds\) -le 2/, '近い時刻かどうかを見ていません');
  assert.match(block, /foreach \(\$t in \$oursTimes\)/, '自分たちの記録と突き合わせていません');
  assert.match(block, /foreach \(\$t in \$otherTimes\)/, '無関係な記録との対も見ていません');
  // 正規表現が外れたパス付きを黙って捨てない
  assert.match(ps1, /どこにも数えずに消さない/, '取りこぼしを数えていません');
});

test('暖機はブロックされたファイル名を表示する', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'tools', 'onsite', 'warmup.bat'), 'utf-8');
  // 以前は COUNT/OTHER/UNKNOWN の3行だけ拾い、一覧行を黙って捨てていた
  assert.match(bat, /:sac_line/, '一覧行を振り分けるサブルーチンがありません');
  assert.match(bat, /ブロックされたファイル/, '一覧の見出しがありません');
  // 🔴 サブルーチンは exit /b 0 の**後ろ**に置く（前だと通常の流れが
  //    通り抜けて勝手に走る）。以前はその位置を計算した変数を
  //    **一度も使っていなかった**ため、この性質は検査されていなかった
  //    （tools は lint の対象外なので未使用変数でも落ちない。
  //    敵対的レビュー 2026-09-09 の指摘）。
  const labelAt = bat.indexOf('\r\n:sac_line\r\n');
  assert.ok(labelAt > 0, ':sac_line のラベルが見つかりません');
  const exitAt = bat.lastIndexOf('exit /b 0', labelAt);
  assert.ok(exitAt > 0 && exitAt < labelAt, ':sac_line が exit /b 0 より前にあります（勝手に走ります）');
});
