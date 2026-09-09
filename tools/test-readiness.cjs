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
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'dist', 'main', 'main', 'services', 'readiness.js');
if (!fs.existsSync(MODULE_PATH)) {
  throw new Error(`dist が見つかりません。先に \`npm run build\` を実行してください: ${MODULE_PATH}`);
}
const {
  buildReadinessWarnings,
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
  ...overrides,
});

// ---------------------------------------------------------------- 判定

test('すべて整っていれば警告なし（＝準備完了）', () => {
  assert.deepStrictEqual(buildReadinessWarnings(healthy()), []);
});

test('results に書けないことは必ず伝える（カードが1枚も残らない）', () => {
  const w = buildReadinessWarnings(healthy({ results: { dir: 'D:\\x', writable: false } }));
  assert.strictEqual(w.length, 1);
  assert.match(w[0], /書き込めません/);
  // どこに書けないのかが分からないと当日直せない
  assert.match(w[0], /D:\\x/);
});

test('カメラが無ければ伝える（全員ダミー写真になり AI 変換も走らない）', () => {
  const w = buildReadinessWarnings(healthy({ usingDummyCamera: true }));
  assert.strictEqual(w.length, 1);
  assert.match(w[0], /カメラ/);
  // 当日その場で直せる場所を書いておく
  assert.match(w[0], /プライバシー/);
});

test('カメラの初期化が決着していなければ伝える', () => {
  const w = buildReadinessWarnings(healthy({ cameraReady: false }));
  assert.ok(w.some((x) => /初期化が終わっていません/.test(x)));
});

test('ComfyUI に繋がらなければ伝える（絵が全員同じプレースホルダになる）', () => {
  const w = buildReadinessWarnings(
    healthy({ comfyui: { profile: 'local', baseUrl: 'http://127.0.0.1:8188', healthy: false } })
  );
  assert.strictEqual(w.length, 1);
  assert.match(w[0], /ComfyUI/);
  assert.match(w[0], /127\.0\.0\.1:8188/);
});

test('ComfyUI の設定が無い場合も黙って通さない（AI変換なしで動くと伝える）', () => {
  const w = buildReadinessWarnings(healthy({ comfyui: null }));
  assert.strictEqual(w.length, 1);
  assert.match(w[0], /AI変換なし/);
});

test('問題が重なったら全部挙げる（1つ直して満足させない）', () => {
  const w = buildReadinessWarnings(
    healthy({
      usingDummyCamera: true,
      results: { dir: 'D:\\x', writable: false },
      comfyui: { profile: 'local', baseUrl: 'http://x', healthy: false },
    })
  );
  assert.strictEqual(w.length, 3);
});

// ---------------------------------------------------------------- 印の読み書き

test('印は書いたとおりに読める（起動バッチが JSON として読む）', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kidspg-ready-'));
  const report = { ...healthy(), warnings: [] };
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
  await writeReadiness(base, { ...healthy(), warnings: [] });
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
  const src = fs.readFileSync(path.join(ROOT, 'tools/make-onsite-package.cjs'), 'utf8');
  for (const name of ['HF_HOME', 'TORCH_HOME', 'XDG_CACHE_HOME']) {
    assert.ok(src.includes(name), name + ' を設定していません');
  }
  // 当日はオフライン。外へ探しに行って待たされないように
  assert.ok(src.includes('HF_HUB_OFFLINE=1'), 'オフライン指定がありません');
});
