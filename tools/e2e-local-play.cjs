#!/usr/bin/env node
/**
 * 撮影 → ComfyUI変換 → 記念カード → results.json までの通しテスト（ローカルPC用）
 *
 *   node tools/e2e-local-play.cjs [--photo <png>] [--nickname <名前>] [--score <点>]
 *                                 [--timeout-min <分>] [--keep] [--plays <回数>]
 *                                 [--no-ai] [--allow-dirty]
 *
 * 実アプリ（Electron）をそのまま起動し、CDP 経由で renderer から
 * `window.electronAPI.savePhoto` / `saveJson` を呼ぶ。
 * つまり main.ts の IPC ハンドラ・ComfyUIService・MemorialCardService・
 * ResultsManager を**本番と同じ経路で**動かしている。
 * サービスを個別に new し直す方式だと main.ts の配線ミスを取り逃すため、この形にした。
 *
 * --no-ai は計画書 §7「撤退判断①」の経路。ComfyUI を使わずに
 * 「固定プレースホルダを前景にしたカード」だけで成立することを確認する。
 * （撮影した本人の写真は前景に使わない。カードを後日公開する方針のため）
 * アプリ側は config.json に comfyui があれば必ず変換を試みるので、
 * **ComfyUI が動いていたらこのモードは実行を拒否する**（動いたまま回しても撤退経路を通らないため）。
 *
 * 前提:
 *   - `npm run build` 済み
 *   - ComfyUI が config.json の comfyui.baseUrl で起動している（--no-ai のときは逆に停止していること）
 *   - ImageMagick(magick) が PATH にある
 *
 * 判定（すべて満たせば成功）:
 *   1. results/<日時>/photo_<日時>.png        … 撮影写真が保存されている
 *   2. results/<日時>/image_generate.json     … filename_prefix / image が期待値へ置換され、seed が振り直されている
 *   3. results/<日時>/memorial_card_<日時>.dummy.png … プレースホルダ版カード（ComfyUI 不要）
 *   4. results/<日時>/photo_anime_<日時>_*.png … ComfyUI の生成画像（--no-ai では省略）
 *   5. results/<日時>/memorial_card_<日時>.png … AI画像を前景にしたカード。3 とはバイト内容が異なること
 *   6. results.json の recent 先頭と ranking_top の該当エントリが 5 を指し、その実体が存在すること
 *   7. --plays 2 以上なら、各プレイの seed が異なり、results ディレクトリが衝突していないこと
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEBUG_PORT = 9222;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const parseArgs = (argv) => {
  const a = {
    photo: path.join(ROOT, 'src', 'renderer', 'assets', 'images', 'dummy_photo.png'),
    // 2026 の候補（constants.ts の NICKNAME_OPTIONS）から採る。
    // 昨年の名前（'疾風の忍者'）のままだと、通しテストで出るカードの文言が
    // 当日のものと違い、目視確認の役に立たない
    nickname: 'グミマスター',
    score: 480,
    timeoutMs: 60 * 60 * 1000,
    keep: false,
    plays: 1,
    noAi: false,
    allowDirty: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--photo') { a.photo = path.resolve(v); i += 1; }
    else if (k === '--nickname') { a.nickname = v; i += 1; }
    else if (k === '--score') { a.score = Number(v); i += 1; }
    else if (k === '--timeout-min') { a.timeoutMs = Number(v) * 60 * 1000; i += 1; }
    else if (k === '--plays') { a.plays = Number(v); i += 1; }
    else if (k === '--keep') { a.keep = true; }
    else if (k === '--no-ai') { a.noAi = true; }
    else if (k === '--allow-dirty') { a.allowDirty = true; }
  }
  return a;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * dist が src より古くないかを見る。
 * 検証ツールは dist を require するので、ビルドし忘れると
 * **直したはずの実装が反映されないまま「成功」してしまう**。
 */
const assertDistFresh = (root) => {
  const fsx = require('fs');
  const pathx = require('path');
  const newest = (dir) => {
    let t = 0;
    for (const e of fsx.readdirSync(dir, { withFileTypes: true })) {
      const p = pathx.join(dir, e.name);
      t = Math.max(t, e.isDirectory() ? newest(p) : fsx.statSync(p).mtimeMs);
    }
    return t;
  };
  const src = newest(pathx.join(root, 'src', 'main'));
  const dist = newest(pathx.join(root, 'dist', 'main'));
  if (src > dist) {
    throw new Error(
      'dist が src より古いままです。先に `npm run build` を実行してください' +
      `（src の最終更新 ${new Date(src).toISOString()} > dist ${new Date(dist).toISOString()}）`
    );
  }
};

const log = (...m) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...m);

// ---------------------------------------------------------------------------
// CDP（依存パッケージ無しの最小実装。Node 22+ の global WebSocket を使う）
// ---------------------------------------------------------------------------
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.closed = null;
    this.consoleLines = [];
    this.listeners = new Map();

    const fail = (reason) => {
      // 接続が死んだら未解決の送信を全部落とす。
      // これをしないと Electron のクラッシュ時に evaluate が永久に解決せず、
      // finally も走らないのでプロセスが残る。
      this.closed = this.closed ?? new Error(reason);
      for (const [, p] of this.pending) p.reject(this.closed);
      this.pending.clear();
    };

    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error(`CDP 接続失敗: ${e.message ?? e.type}`)));
      this.ws.addEventListener('close', (e) => reject(new Error(`CDP が接続前に閉じました (code=${e.code})`)));
    });
    this.ws.addEventListener('error', (e) => fail(`CDP エラー: ${e.message ?? e.type}`));
    this.ws.addEventListener('close', (e) => fail(`CDP が閉じました (code=${e.code})`));

    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; } // 壊れたフレームで落とさない
      if (msg.method) {
        if (msg.method === 'Runtime.consoleAPICalled') {
          const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
          this.consoleLines.push(`[console.${msg.params.type}] ${text}`);
        }
        const handler = this.listeners.get(msg.method);
        if (handler) handler(msg.params);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else p.resolve(msg.result);
    });
  }

  on(method, handler) { this.listeners.set(method, handler); }

  send(method, params = {}, timeoutMs = 60_000) {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} が ${timeoutMs}ms で応答しませんでした`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  /** renderer 内で式を評価し、Promise なら解決を待って値を取り出す。 */
  async evaluate(expression, timeoutMs = 60_000) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, timeoutMs);
    if (res.exceptionDetails) {
      throw new Error(`renderer 例外: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    // シリアライズ不能で undefined 化されたのか、本当に undefined なのかを区別する
    if (res.result.type === 'object' && !('value' in res.result)) {
      throw new Error(`renderer の戻り値をシリアライズできませんでした: ${res.result.className ?? res.result.subtype}`);
    }
    return res.result.value;
  }

  close() { try { this.ws.close(); } catch { /* すでに閉じている */ } }
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------
const fetchJson = async (url, timeoutMs = 10_000) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
};

const portInUse = (port) => new Promise((resolve) => {
  const sock = net.connect({ host: '127.0.0.1', port });
  const done = (v) => { sock.destroy(); resolve(v); };
  sock.setTimeout(1500);
  sock.on('connect', () => done(true));
  sock.on('timeout', () => done(false));
  sock.on('error', () => done(false));
});

/** Windows で Electron の子孫まで確実に落とす。child.killed は「シグナルを送った」だけで真になる。 */
const killTree = (child) => {
  if (!child.pid || child.exitCode !== null) return;
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    try { child.kill('SIGKILL'); } catch { /* 既に終了 */ }
  }
};

/**
 * ファイルが現れ、かつ**書き込みが落ち着く**まで待つ。
 * readdir に見えた瞬間を成功にすると、0バイトや書き込み途中を掴む。
 */
const waitForStableFile = async (dir, matcher, deadline, label) => {
  let found = null;
  while (Date.now() < deadline) {
    let files = [];
    try { files = await fsp.readdir(dir); } catch { /* まだ無い */ }
    const hit = files.find(matcher);
    if (hit) { found = path.join(dir, hit); break; }
    await sleep(1000);
  }
  if (!found) throw new Error(`${label} が期限内に現れませんでした: ${dir}`);

  let prev = -1;
  while (Date.now() < deadline) {
    const size = (await fsp.stat(found)).size;
    if (size > 0 && size === prev) return found;
    prev = size;
    await sleep(700);
  }
  throw new Error(`${label} のサイズが安定しませんでした: ${found}`);
};

const assertPng = async (filePath, label) => {
  const fd = await fsp.open(filePath, 'r');
  try {
    const head = Buffer.alloc(8);
    await fd.read(head, 0, 8, 0);
    if (!head.equals(PNG_MAGIC)) throw new Error(`${label} が PNG ではありません: ${filePath}`);
  } finally {
    await fd.close();
  }
};

// ---------------------------------------------------------------------------
const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
  const resultsDir = path.join(ROOT, 'results'); // 開発起動時は app.getAppPath()/results
  const { resolveComfyUIConfig } = require(
    path.join(ROOT, 'dist', 'main', 'main', 'services', 'comfyui-config.js')
  );
  const comfy = resolveComfyUIConfig(config.comfyui);
  const outputPrefix = comfy.workflow.outputPrefix;

  if (!fs.existsSync(path.join(ROOT, 'dist', 'main', 'main', 'main.js'))) {
    throw new Error('dist が見つかりません。先に `npm run build` を実行してください');
  }
  assertDistFresh(ROOT);
  if (!fs.existsSync(args.photo)) throw new Error(`写真がありません: ${args.photo}`);

  // ランク名はアプリと同じ関数から作る。文字列を手で書くと
  // image-composition-config が未知のランクを黙ってビギナー背景へフォールバックさせ、
  // 「8種類の背景のうち1種類しか検証していない」状態に気づけない。
  const { calculateRank, RANK_NAMES, calculateLevel } = require(
    path.join(ROOT, 'dist', 'main', 'shared', 'utils', 'helpers.js')
  );
  const rank = calculateRank(args.score, config.game.rankThresholds);
  const level = calculateLevel(args.score, config.game.levelUpScoreInterval);
  if (!Object.values(RANK_NAMES).includes(rank)) {
    throw new Error(`calculateRank が未知のランクを返しました: ${rank}`);
  }
  log(`score=${args.score} -> rank="${rank}" level=${level}`);

  // 既存の results があると押し出し（maxRecent/maxRanking）で結果が変わる
  if (!args.allowDirty && fs.existsSync(resultsDir) && fs.readdirSync(resultsDir).length > 0) {
    throw new Error(`results/ が空ではありません。退避してから実行するか --allow-dirty を付けてください: ${resultsDir}`);
  }

  // ComfyUI の状態。--no-ai は「ComfyUI が居ないこと」が前提なので、居たら拒否する。
  let comfyAlive = false;
  try {
    const stats = await fetchJson(`${comfy.baseUrl}/system_stats`);
    comfyAlive = true;
    log(`ComfyUI 応答あり: ${comfy.baseUrl} (${comfy.profileLabel}) device=${stats.devices?.[0]?.type ?? '?'}`);
  } catch { comfyAlive = false; }

  if (args.noAi) {
    if (comfyAlive) {
      throw new Error(
        '--no-ai は ComfyUI を停止した状態で実行してください。' +
        'アプリは config.json に comfyui があれば必ず変換を試みるため、' +
        'ComfyUI が動いていると撤退経路（計画書 §7）を一切通らずに PASS してしまいます。'
      );
    }
    log('--no-ai: ComfyUI 停止を確認。撤退経路（計画書 §7 撤退判断①）を検証します');
  } else if (!comfyAlive) {
    throw new Error(`ComfyUI に繋がりません (${comfy.baseUrl})`);
  }

  // 9222 が既に使われていると、いま起動する Electron の bind は失敗するのに起動は続き、
  // 前回 --keep で残したインスタンスや npm run dev に接続して「古いビルドで PASS」になる。
  if (await portInUse(DEBUG_PORT)) {
    throw new Error(`ポート ${DEBUG_PORT} が使用中です。前回の Electron が残っていないか確認してください`);
  }

  const photoDataUrl = `data:image/png;base64,${fs.readFileSync(args.photo).toString('base64')}`;

  log('Electron を起動します');
  const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronBin)) {
    // npx 経由だと shell 越しになり、kill しても孫の electron.exe が残る
    throw new Error(`electron の実行ファイルが見つかりません: ${electronBin}`);
  }
  const child = spawn(electronBin, ['.', `--remote-debugging-port=${DEBUG_PORT}`, '--enable-logging'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appLog = [];
  const capture = (buf) => { appLog.push(buf.toString()); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  let exited = null;
  child.on('exit', (code, signal) => { exited = `code=${code} signal=${signal}`; });

  let cdp = null;
  let failed = null;
  const deadline = Date.now() + args.timeoutMs;
  const seenSeeds = new Set();
  const seenDirs = new Set();

  try {
    // renderer ターゲットを待つ。起動したプロセス自身のものか PID で突き合わせる。
    let target = null;
    const targetDeadline = Math.min(Date.now() + 60_000, deadline);
    while (Date.now() < targetDeadline) {
      if (exited) throw new Error(`Electron が起動直後に終了しました (${exited})`);
      try {
        const targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
        const page = targets.find(
          (t) => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('ranking')
        );
        if (page?.webSocketDebuggerUrl) { target = page; break; }
      } catch { /* まだ起動していない */ }
      await sleep(500);
    }
    if (!target) throw new Error('Electron の renderer ターゲットが見つかりませんでした');

    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    log('renderer に接続しました');

    // 接続先が「いま起動した dist」かを確認する
    const loadedFrom = await cdp.evaluate('location.href');
    const expectedHref = 'dist/renderer/index.html';
    if (!loadedFrom.replace(/\\/g, '/').includes(expectedHref)) {
      throw new Error(`想定外の renderer に接続しました: ${loadedFrom}`);
    }

    // IPC ハンドラは main プロセスの非同期初期化のあと setupIPC() でまとめて登録される。
    // ウィンドウが出た直後はまだ間に合わず、save-photo は "No handler registered" になる。
    const ipcDeadline = Math.min(Date.now() + 60_000, deadline);
    let appConfig = null;
    while (Date.now() < ipcDeadline) {
      try {
        appConfig = await cdp.evaluate('window.electronAPI.getConfig()', 10_000);
        if (appConfig) break;
      } catch { /* まだ登録されていない */ }
      await sleep(500);
    }
    if (!appConfig) throw new Error('IPC ハンドラ（get-config）が期限内に登録されませんでした');
    log('IPC ハンドラの登録を確認しました');

    // ComfyUI のジョブ失敗を即座に拾う。これが無いと失敗と「CPU で遅いだけ」を
    // 区別できず、タイムアウトまで待って原因不明のまま終わる。
    await cdp.evaluate(`
      window.__e2eJobErrors = [];
      window.electronAPI.comfyui.onJobError((d) => window.__e2eJobErrors.push(d));
      window.electronAPI.comfyui.onError((d) => window.__e2eJobErrors.push(d));
      true;
    `);
    const jobErrors = async () => cdp.evaluate('JSON.stringify(window.__e2eJobErrors || [])');
    const throwIfJobError = async () => {
      const errs = JSON.parse(await jobErrors());
      if (errs.length) throw new Error(`ComfyUI ジョブが失敗しました: ${JSON.stringify(errs)}`);
    };

    for (let play = 1; play <= args.plays; play += 1) {
      log(`--- プレイ ${play}/${args.plays} ---`);

      // results のディレクトリ名は秒単位。同一秒に2プレイすると main.ts が
      // memorialCardGenerationFlags で早期 return し、2プレイ目が results.json に載らない。
      if (play > 1) await sleep(1500);

      // 1. 撮影（CameraPage 相当）。ここで ComfyUI へのアップロードと変換が始まる
      const saved = await cdp.evaluate(
        `window.electronAPI.savePhoto(${JSON.stringify(photoDataUrl)}, false)`
      );
      if (!saved?.success) throw new Error(`savePhoto 失敗: ${saved?.error}`);
      const dirPath = saved.dirPath;
      const dateTime = path.basename(dirPath);
      if (seenDirs.has(dateTime)) {
        throw new Error(`results ディレクトリが衝突しました（同一秒に2プレイ）: ${dateTime}`);
      }
      seenDirs.add(dateTime);
      log(`savePhoto OK: ${dirPath}`);

      const photoPath = path.join(dirPath, `photo_${dateTime}.png`);
      if (!fs.existsSync(photoPath)) throw new Error('撮影写真が保存されていません');
      await assertPng(photoPath, '撮影写真');

      // 2. image_generate.json の中身を値で検証する。
      //    「未置換の ${...} が無い」だけだと、置換結果が空文字でも通ってしまう。
      const genPath = path.join(dirPath, 'image_generate.json');
      if (!fs.existsSync(genPath)) throw new Error('image_generate.json が保存されていません');
      const generated = JSON.parse(fs.readFileSync(genPath, 'utf-8'));
      const leftover = JSON.stringify(generated).match(/\$\{[^}]+\}/g);
      if (leftover) throw new Error(`image_generate.json に未置換の変数が残っています: ${leftover}`);

      const nodes = Object.values(generated);
      const saveNodes = nodes.filter((n) => n.class_type === 'SaveImage');
      const loadNodes = nodes.filter((n) => n.class_type === 'LoadImage');
      const samplerNodes = nodes.filter((n) => n.class_type === 'KSampler');
      const expectedPrefix = `${outputPrefix}_${dateTime}`;
      if (!saveNodes.length || saveNodes.some((n) => n.inputs.filename_prefix !== expectedPrefix)) {
        throw new Error(`SaveImage.filename_prefix が ${expectedPrefix} ではありません: ` +
          JSON.stringify(saveNodes.map((n) => n.inputs.filename_prefix)));
      }
      if (!loadNodes.length || loadNodes.some((n) => n.inputs.image !== `photo_${dateTime}.png`)) {
        throw new Error(`LoadImage.image が photo_${dateTime}.png ではありません: ` +
          JSON.stringify(loadNodes.map((n) => n.inputs.image)));
      }
      for (const n of samplerNodes) {
        if (typeof n.inputs.seed !== 'number') throw new Error('KSampler.seed が数値ではありません');
        if (seenSeeds.has(n.inputs.seed)) {
          throw new Error(`seed が振り直されていません（全員同じ絵になります）: ${n.inputs.seed}`);
        }
        seenSeeds.add(n.inputs.seed);
      }
      log(`image_generate.json OK (prefix=${expectedPrefix}, seed=${samplerNodes.map((n) => n.inputs.seed).join(',')})`);

      // 3. ゲームを終えて結果保存（ResultPage 相当）
      // shared/utils/helpers.generateJSTTimestamp と同じ形式（"YYYY-MM-DD HH:mm:ss"）
      const timestampJST = new Date(Date.now() + 9 * 60 * 60 * 1000)
        .toISOString().slice(0, 19).replace('T', ' ');
      const gameResult = {
        nickname: args.nickname,
        rank,
        level,
        score: args.score,
        timestampJST,
        imagePath: `photo_${dateTime}.png`,
      };
      const jsonSaved = await cdp.evaluate(
        `window.electronAPI.saveJson(${JSON.stringify(dirPath)}, ${JSON.stringify(gameResult)})`
      );
      if (!jsonSaved?.success) throw new Error(`saveJson 失敗: ${jsonSaved?.error}`);
      log('saveJson OK');

      // 4. プレースホルダ版カード（ComfyUI が落ちていても必ず出る）
      const dummyCard = await waitForStableFile(
        dirPath,
        (f) => f === `memorial_card_${dateTime}.dummy.png`,
        Math.min(Date.now() + 120_000, deadline),
        'プレースホルダ版カード'
      );
      await assertPng(dummyCard, 'プレースホルダ版カード');
      const dummyBytes = await fsp.readFile(dummyCard);
      log(`プレースホルダ版カード OK (${(dummyBytes.length / 1024).toFixed(0)} KB)`);

      if (args.noAi) {
        const expectedDummy = `${dateTime}/memorial_card_${dateTime}.dummy.png`;
        await assertResultsEntry(resultsDir, dateTime, expectedDummy, deadline);
        log('results.json OK (--no-ai)');
        continue;
      }

      // 5. ComfyUI の生成画像。失敗イベントを拾ったら即座に落とす
      const aiDeadline = deadline;
      let animePath = null;
      while (Date.now() < aiDeadline) {
        await throwIfJobError();
        const files = await fsp.readdir(dirPath).catch(() => []);
        const hit = files.find((f) => f.startsWith(expectedPrefix) && f.endsWith('.png'));
        if (hit) { animePath = path.join(dirPath, hit); break; }
        await sleep(2000);
      }
      if (!animePath) throw new Error('ComfyUI 生成画像が期限内に現れませんでした');
      await waitForStableFile(dirPath, (f) => f === path.basename(animePath), aiDeadline, 'ComfyUI 生成画像');
      await assertPng(animePath, 'ComfyUI 生成画像');
      log(`AI画像 OK: ${path.basename(animePath)} (${((await fsp.stat(animePath)).size / 1024).toFixed(0)} KB)`);

      // 6. AI画像を前景にした本カード。dummy と同一内容なら「AI画像が使われていない」
      const cardPath = await waitForStableFile(
        dirPath,
        (f) => f === `memorial_card_${dateTime}.png`,
        Math.min(Date.now() + 180_000, deadline),
        '記念カード（AI画像）'
      );
      await assertPng(cardPath, '記念カード');
      const cardBytes = await fsp.readFile(cardPath);
      if (cardBytes.equals(dummyBytes)) {
        throw new Error('記念カードがプレースホルダ版とバイト単位で同一です（AI画像が前景に使われていません）');
      }
      log(`記念カード OK: ${path.basename(cardPath)} (${(cardBytes.length / 1024).toFixed(0)} KB, dummy と差分あり)`);

      // 7. results.json（recent と ranking_top の両方）
      const expectedCard = `${dateTime}/memorial_card_${dateTime}.png`;
      await assertResultsEntry(resultsDir, dateTime, expectedCard, Math.min(Date.now() + 60_000, deadline));
      log('results.json OK（recent / ranking_top ともに AI カードを指し、実体も存在）');
    }

    // 8. ランキング画面。当日いちばん長く映っている画面なのに、
    //    results.json とカード画像から実際に絵が出るかは通しで見ていなかった。
    log('--- ランキング画面 ---');
    await cdp.evaluate('window.electronAPI.showRankingWindow()');
    let rankingTarget = null;
    const rankDeadline = Math.min(Date.now() + 30_000, deadline);
    while (Date.now() < rankDeadline) {
      const targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`).catch(() => []);
      const page = targets.find((t) => t.type === 'page' && t.url.includes('ranking.html'));
      if (page?.webSocketDebuggerUrl) { rankingTarget = page; break; }
      await sleep(500);
    }
    if (!rankingTarget) throw new Error('ランキングウィンドウが開きませんでした');

    const rankCdp = new CDP(rankingTarget.webSocketDebuggerUrl);
    try {
      await rankCdp.ready;
      await rankCdp.send('Runtime.enable');
      // カード画像は getImageDataUrl 経由の data: URL。
      // 「img タグがある」だけでなく、実際に読み込めている（naturalWidth > 0）ことまで見る。
      let shown = 0;
      const imgDeadline = Math.min(Date.now() + 30_000, deadline);
      while (Date.now() < imgDeadline) {
        shown = await rankCdp.evaluate(
          '[...document.querySelectorAll("img")].filter((i) => i.naturalWidth > 0).length'
        );
        if (shown > 0) break;
        await sleep(1000);
      }
      const noImage = await rankCdp.evaluate(
        '[...document.querySelectorAll("span")].filter((s) => s.textContent === "No Image").length'
      );
      if (shown === 0) {
        throw new Error(`ランキング画面にカード画像が1枚も表示されていません（No Image プレースホルダ ${noImage} 件）`);
      }
      log(`ランキング画面 OK: カード画像 ${shown} 枚を表示（No Image ${noImage} 件）`);
    } finally {
      rankCdp.close();
      await cdp.evaluate('window.electronAPI.closeRankingWindow()').catch(() => undefined);
    }

    log('すべての判定を満たしました');
  } catch (e) {
    failed = e;
  } finally {
    cdp?.close();
    if (!args.keep) {
      killTree(child);
      // 終了を待つ。残ると次回の 9222 チェックに引っかかり、原因が分かりにくくなる。
      for (let i = 0; i < 20 && child.exitCode === null; i += 1) await sleep(250);
    } else {
      log('--keep 指定のため Electron は起動したままにします（次回実行前に必ず終了させること）');
    }
  }

  if (failed) {
    console.error('\n[e2e] 失敗:', failed.message);
    const tail = appLog.join('').split('\n').filter((l) => l.trim()).slice(-40).join('\n');
    if (tail) console.error('\n--- アプリ側ログ（末尾40行）---\n' + tail);
    if (cdp?.consoleLines.length) {
      console.error('\n--- renderer console（末尾20行）---\n' + cdp.consoleLines.slice(-20).join('\n'));
    }
    process.exitCode = 1;
  } else {
    console.log('\n[e2e] PASS');
  }
};

/**
 * results.json の recent / ranking_top の両方が期待するカードを指し、
 * その実体が存在することまで確認する。
 * ランキング画面が見ているのは ranking_top なので、recent だけ見ても足りない。
 */
const assertResultsEntry = async (resultsDir, dateTime, expectedCardPath, deadline) => {
  let last = null;
  while (Date.now() < deadline) {
    try {
      const results = JSON.parse(await fsp.readFile(path.join(resultsDir, 'results.json'), 'utf-8'));
      const recent = (results.recent ?? []).find((r) => (r.resultPath ?? '').startsWith(`${dateTime}/`));
      const ranked = (results.ranking_top ?? []).find((r) => (r.resultPath ?? '').startsWith(`${dateTime}/`));
      last = { recent, ranked };
      if (recent?.memorialCardPath === expectedCardPath && ranked?.memorialCardPath === expectedCardPath) {
        const abs = path.join(resultsDir, expectedCardPath);
        if (!fs.existsSync(abs)) throw new Error(`results.json が指すカードの実体がありません: ${abs}`);
        return;
      }
    } catch (e) {
      if (e.message?.includes('実体がありません')) throw e;
      // 書き込み途中は握りつぶして再試行
    }
    await sleep(1000);
  }
  throw new Error(
    `results.json が ${expectedCardPath} を指しませんでした（recent/ranking_top 両方が必要）: ${JSON.stringify(last)}`
  );
};

main().catch((e) => {
  console.error('[e2e] 想定外の失敗:', e);
  process.exitCode = 1;
});
