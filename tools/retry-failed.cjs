#!/usr/bin/env node
/**
 * 生成に失敗したプレイを後から救済する（リトライ）。
 *
 *   node tools/retry-failed.cjs            # 何が直るかを表示するだけ（既定は安全側）
 *   node tools/retry-failed.cjs --apply    # 実際に直す
 *   node tools/retry-failed.cjs --apply --only 20260902_184254   # 1件だけ
 *   node tools/retry-failed.cjs --apply --timeout-min 30
 *   node tools/retry-failed.cjs --apply --rebuild-index   # results.json を各 result.json から作り直す
 *
 * ■ なぜ要るか
 * 当日はアプリの再起動・ComfyUI の落ち・タイムアウトで、プレイの成果物が
 * 途中まででとまることがある。実際に検証中、**アプリを再起動したタイミングで
 * 「AI画像とカードは出来ているのに results.json がダミーを指したまま」**が発生した。
 * ランキングにはプレースホルダが並ぶので、見た目には「生成できていない」ように映る。
 *
 * ■ 直せる3パターン
 *   A. photo_anime_* が無い          → 保存済み image_generate.json を ComfyUI へ再投入して生成
 *   B. photo_anime_* はあるがカードが無い → ImageMagick でカードを合成
 *   C. カードはあるが results.json / result.json が指していない → パスを張り直すだけ
 *
 * 既存の `npm run recovery` は **B しか対象にせず、results.json を更新しない**。
 * このツールは3つとも扱う。
 *
 * ■ 壊さないための約束
 *   ・既定はドライラン。`--apply` を付けたときだけ書き込む
 *   ・**既にあるファイルは上書きしない**（AI画像・カードが揃っている回は触らない）
 *   ・results.json は ResultsManager と同じ「一時ファイル→rename」で書く
 *   ・撮影写真（photo_*.png）には一切触らない
 *
 * ■ 壊れたカードの扱い（2026-09-02 追加）
 * 以前は先頭8バイトのシグネチャとサイズ>0 だけを見ていたため、
 * **書き込み途中で切れたPNGを「正常」と誤判定**していた（ギャラリーで上半分だけ表示）。
 * いまは IEND チャンクまで検査し（`src/main/services/png-integrity.ts`）、
 * 不完全なカードは「無い」ものとして B で作り直す。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// results の場所の判断は1箇所に集めてある（配布された ops から実物を指すため）
const { resolveResultsDir, describeMissing } = require('./lib/resolve-results-dir.cjs');
const DIST = path.join(ROOT, 'dist', 'main', 'main', 'services');

const parseArgs = (argv) => {
  const a = { apply: false, only: null, timeoutMs: 30 * 60 * 1000, rebuildIndex: false, forceUnlock: false };
  const errors = [];
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === '--apply') a.apply = true;
    else if (v === '--rebuild-index') a.rebuildIndex = true;
    else if (v === '--force-unlock') a.forceUnlock = true;
    else if (v === '--only') {
      const next = argv[i + 1];
      // 値なし（`--only` の後ろが別のフラグ or 何も無い）を黙って通すと、
      // 全3000件が対象になったり rebuildIndex が無効になったりする
      if (!next || next.startsWith('--')) errors.push('--only には日時フォルダ名を指定してください（例: --only 20260912_101112）');
      else if (!/^\d{8}_\d{6}$/.test(next)) errors.push(`--only の指定が日時フォルダ名の形ではありません: ${next}`);
      else a.only = next;
      i += 1;
    } else if (v === '--timeout-min') {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) errors.push(`--timeout-min には正の数を指定してください: ${argv[i + 1]}`);
      else a.timeoutMs = n * 60 * 1000;
      i += 1;
    } else {
      errors.push(`知らない引数です: ${v}`);
    }
  }
  // 🔴 --rebuild-index は「壊れた索引を正本から作り直す」最後の手段。
  // --only と併用すると**その1件だけの索引に潰れる**（他の子が全員消える）
  if (a.rebuildIndex && a.only) errors.push('--rebuild-index と --only は同時に使えません（索引が1件に潰れます）');
  a.errors = errors;
  return a;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(...m);

/**
 * ComfyUI への問い合わせは**必ず時間上限を付ける**。
 *
 * 🔴 付けないと、ComfyUI が TCP レベルで無応答（メモリ不足でスワップ中など）に
 * なったときに fetch が返らず、`while (Date.now() < deadline)` の判定にすら
 * 到達しない。--timeout-min を指定してもツールがぶら下がったままになり、
 * 保守ロックを握り続けるので**アプリの起動時点検まで止まる**。
 * comfyui-worker.ts が同じ理由でポーリングに上限を付けている。
 */
const COMFY_FETCH_TIMEOUT_MS = 120_000;
const fetchComfy = (url, options = {}, timeoutMs = COMFY_FETCH_TIMEOUT_MS) =>
  fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });

/**
 * ResultsManager.writeJsonAtomic と同じ考え方。Windows では rename が一時的に弾かれる。
 * rename の粘りは dist の renameWithRetry（アプリ本体と同一実装）に委ねる
 * ——待ち時間の表をここにも持つと、片方だけ直したときに挙動がずれる。
 */
const writeJsonAtomic = async (filePath, data) => {
  const tmp = `${filePath}.${process.pid}-${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  try {
    await renameWithRetry(tmp, filePath);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => undefined);
    throw e;
  }
};

/**
 * PNG の完全性検査。判定はアプリ本体と同じ実装（dist の png-integrity）を使う。
 * ここに独自実装を置くと、本体と判定がずれて「アプリは壊れていると言うのに
 * 救済ツールは対象外と言う」状態になる。
 */
let verifyPngFileSync = null;
let buildPartialOutputPath = null;
/** dist（アプリ本体と同一実装）の rename リトライ。main() の中で差し込む */
let renameWithRetry = null;
const inspectPng = (p) => verifyPngFileSync(p);

/**
 * 🔴 **`!valid` で「壊れている」と判断してはいけない。**
 * OneDrive のロック・クラウド専用ファイル・ウイルス対策の干渉で読めなかっただけの
 * 完成品を、このツールは `.broken-<時刻>` へ改名する（＝その子のカードが公開物から消える）。
 * 破壊的な操作は「PNG として明確に不正」のときだけに限る。
 */
const isCorrupt = (check) => check.status === 'corrupt';

/**
 * inspect の結果のキャッシュ。
 * 3000件だと1回の実行で1ディレクトリあたり3〜5回 inspect が走り、
 * そのたびに readdir と PNG の末尾読み（OneDrive では実体化）が発生する。
 * 状態を変えたら invalidateInspect で捨てる。
 */
const inspectCache = new Map();
const invalidateInspect = (dt) => inspectCache.delete(dt);

/** 1プレイぶんの状態を見て、何が欠けているかを判定する（キャッシュあり） */
const inspect = (resultsDir, dt) => {
  const cached = inspectCache.get(dt);
  if (cached) return cached;
  const fresh = inspectUncached(resultsDir, dt);
  inspectCache.set(dt, fresh);
  return fresh;
};

const inspectUncached = (resultsDir, dt) => {
  const dir = path.join(resultsDir, dt);
  // results/ 直下に日時名の**ファイル**が混ざっていても止まらない
  // （zip の展開ミスなどで実在する。ここで落ちると全件が救済されない）
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) { return { dt, dir, files: [], unreadable: e.code || String(e) }; }

  // AI画像は「新しい順に、完全なものを1つ」選ぶ。
  // 最初の1件だけを見ると、切れた _00001_ が残っている回で
  // 「検査した画像」と「合成に使う画像」がずれ、
  // IEND 付きの上半分グレーのカード（以後検出不能）が出来上がる。
  const animeCandidates = files
    .filter((f) => f.startsWith('photo_anime_') && f.endsWith('.png'))
    .sort()
    .reverse();
  let anime = null;
  let animeUnverified = null;
  for (const f of animeCandidates) {
    const check = inspectPng(path.join(dir, f));
    if (check.valid) { anime = f; break; }
    if (!isCorrupt(check)) animeUnverified = `${f}: ${check.error}`;
  }

  const card = `memorial_card_${dt}.png`;
  const dummy = `memorial_card_${dt}.dummy.png`;
  const cardCheck = files.includes(card) ? inspectPng(path.join(dir, card)) : null;
  const dummyCheck = files.includes(dummy) ? inspectPng(path.join(dir, dummy)) : null;

  return {
    dt, dir, files,
    // 明確に壊れているものだけ「退避して作り直す」対象にする
    brokenCard: cardCheck && isCorrupt(cardCheck) ? `${card}: ${cardCheck.error}` : null,
    // 読めなかっただけの可能性がある。**触らずに報告する**
    unverifiedCard: cardCheck && !cardCheck.valid && !isCorrupt(cardCheck) ? `${card}: ${cardCheck.error}` : null,
    unverifiedAnime: animeUnverified,
    photo: files.find((f) => f === `photo_${dt}.png`) || null,
    gen: files.includes('image_generate.json'),
    result: files.includes('result.json'),
    anime,
    card: cardCheck && cardCheck.valid ? card : null,
    // 参照をプレースホルダへ戻せるのは、その実体が完全なときだけ
    dummy: dummyCheck && dummyCheck.valid ? dummy : null,
  };
};

/**
 * 参照（result.json と results.json）をプレースホルダへ戻す。
 *
 * 🔴 **カードを退避する前に必ずこれを通すこと。**
 * 先に実体を退避して作り直しに失敗・中断すると、
 * 「参照は正規カードを指しているのに実体が無い」状態が残り、
 * ランキングは画像の割れた枠になり、後日の公開でもその子が欠ける
 * （「上半分だけ表示」からの純粋な劣化）。
 */
const revertReferencesToDummy = async (st, resultsJson, apply) => {
  if (!st.dummy) return false; // プレースホルダが無い／壊れている回は触らない
  const regular = `${st.dt}/memorial_card_${st.dt}.png`;
  const dummyRef = `${st.dt}/${st.dummy}`;

  const rp = path.join(st.dir, 'result.json');
  try {
    const rj = JSON.parse(await fsp.readFile(rp, 'utf-8'));
    if (rj.memorialCardPath === regular) {
      if (apply) { rj.memorialCardPath = dummyRef; await writeJsonAtomic(rp, rj); }
    }
  } catch (e) {
    log(`    !! ${st.dt}: result.json をプレースホルダへ戻せません (${e.message})`);
    return false;
  }

  if (fs.existsSync(resultsJson)) {
    try {
      const data = JSON.parse(await fsp.readFile(resultsJson, 'utf-8'));
      let changed = false;
      for (const arr of [data.recent, data.ranking_top]) {
        for (const e of arr || []) {
          if (e && e.memorialCardPath === regular) { e.memorialCardPath = dummyRef; changed = true; }
        }
      }
      if (changed && apply) await writeJsonAtomic(resultsJson, data);
    } catch (e) {
      log(`    !! ${st.dt}: results.json をプレースホルダへ戻せません (${e.message})`);
      return false;
    }
  }
  return true;
};

/** ComfyUI へ再投入して photo_anime_* を作る（パターン A） */
const regenerateAnime = async (st, comfy, outputPrefix, deadline) => {
  const workflow = JSON.parse(await fsp.readFile(path.join(st.dir, 'image_generate.json'), 'utf-8'));

  // 写真を上げ直す。ComfyUI の input は再起動で消えることがあるため毎回上げる。
  const buf = await fsp.readFile(path.join(st.dir, st.photo));
  const form = new FormData();
  form.append('image', new Blob([buf], { type: 'image/png' }), st.photo);
  form.append('overwrite', 'true');
  const up = await fetchComfy(`${comfy.baseUrl}/upload/image`, { method: 'POST', body: form });
  if (!up.ok) throw new Error(`アップロード失敗 ${up.status}`);
  const uploaded = (await up.json()).name || st.photo;

  // LoadImage を実際のアップロード名へ差し替える（worker と同じ扱い）
  for (const node of Object.values(workflow)) {
    if (node && node.class_type === 'LoadImage' && node.inputs) node.inputs.image = uploaded;
  }

  const res = await fetchComfy(`${comfy.baseUrl}/prompt`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: `retry-${Date.now()}` }),
  });
  if (!res.ok) throw new Error(`/prompt 失敗 ${res.status} ${await res.text()}`);
  const { prompt_id: promptId } = await res.json();

  let lastLog = 0;
  const started = Date.now();
  while (Date.now() < deadline) {
    // 生成中は ComfyUI が推論で詰まって応答が数十秒止まることがあるため、
    // 上限は長めに取る（が、無制限にはしない）。失敗しても while が回るので
    // deadline による打ち切りへ必ず到達する
    let entry;
    try {
      const h = await (await fetchComfy(`${comfy.baseUrl}/history/${promptId}`)).json();
      entry = h[promptId];
    } catch (e) {
      log(`      ... 進捗の確認に失敗（続行します）: ${e.message}`);
      await sleep(2000);
      continue;
    }
    if (entry?.status?.status_str === 'error') throw new Error(`実行エラー: ${JSON.stringify(entry.status)}`);
    if (entry?.status?.completed) {
      // comfyui-worker と同じ優先順（9 → 8）で出力を探す
      const outputs = entry.outputs ?? {};
      const nodeId = ['9', '8'].find((id) => (outputs[id]?.images ?? []).length > 0);
      const img = nodeId && outputs[nodeId].images.find((i) => i.type === 'output');
      if (!img) throw new Error('SaveImage の出力が見つかりません');
      if (!img.filename.startsWith(`${outputPrefix}_${st.dt}`)) {
        throw new Error(`出力名が想定と違います: ${img.filename}`);
      }
      const url = `${comfy.baseUrl}/view?filename=${encodeURIComponent(img.filename)}`
        + `&subfolder=${encodeURIComponent(img.subfolder)}&type=${img.type}`;
      const bin = Buffer.from(await (await fetchComfy(url)).arrayBuffer());
      const dest = path.join(st.dir, img.filename);
      // 一時名で書いてから rename（途中のファイルをアプリに拾わせない）
      // 接尾辞は `.partial` に合わせる。共有の掃除・救済（card-output）が
      // 中断で残った残骸を拾えるようにするため。
      // 印はプロセス固有にする（固定名だと2プロセスが同じ一時ファイルへ書く）
      const tmp = buildPartialOutputPath(dest);
      await fsp.writeFile(tmp, bin);
      // 🔴 rename は必ずリトライを通す。results/ は OneDrive 同期下で、
      // 書いた直後は同期のアップロードとウイルス対策のスキャンが走るため
      // EPERM / EBUSY が普通に起きる。1回で諦めると、1枚3分かけて作り直した
      // AI画像を一時名のまま置き去りにしてしまう（次回の掃除まで救われない）。
      await renameWithRetry(tmp, dest);
      return img.filename;
    }
    const el = Math.round((Date.now() - started) / 1000);
    if (el - lastLog >= 30) { lastLog = el; log(`      ... ${el}s 経過`); }
    await sleep(2000);
  }
  throw new Error('生成がタイムアウトしました');
};

/**
 * dist から実装を借りる。**アプリ本体と判定・確定処理を1つにするため**、
 * ここに独自実装は置かない。
 * dist が無い／古いまま黙って動くと「アプリは壊れていると言うのに
 * ツールは対象外と言う」状態になるので、鮮度まで見る。
 */
const requireDist = (fileName) => {
  const full = path.join(DIST, fileName);
  if (!fs.existsSync(full)) {
    throw new Error(`dist に ${fileName} がありません。先に \`npm run build\` を実行してください`);
  }
  return require(full);
};

/**
 * dist が src より古いかを見る。**止めない。**
 * 当日 PC では git pull / clone だけで .ts の mtime が現在時刻になり、
 * 「dist が古い」と判定され得る。ここで throw すると、ビルド不要な
 * C（result.json / results.json のパス張り直し）まで実行できなくなる。
 * スタッフに tsc を要求するのは現実的でないため、警告に留める。
 */
const warnIfDistIsStale = () => {
  try {
    const srcDir = path.join(ROOT, 'src', 'main', 'services');
    const newestSrc = fs.readdirSync(srcDir)
      .filter((f) => f.endsWith('.ts'))
      .reduce((max, f) => Math.max(max, fs.statSync(path.join(srcDir, f)).mtimeMs), 0);
    const oldestDist = ['png-integrity.js', 'card-output.js', 'comfyui-config.js']
      .reduce((min, f) => Math.min(min, fs.statSync(path.join(DIST, f)).mtimeMs), Infinity);
    if (oldestDist < newestSrc) {
      log('!! dist が src より古いようです。判定がアプリ本体とずれる可能性があります（`npm run build` 推奨）');
    }
  } catch {
    // 判定できないだけなので続行する
  }
};

/**
 * カード合成の実装（ビルド済み）の場所。
 *
 * 🔴 **npm に頼ってはいけない。** 以前は `npm run recovery`（= tsx で
 * TypeScript のソースを直接実行）を呼んでいたが、**当日PCには npm も
 * node_modules も src/ も無い**ため、カードの作り直しは構造的に不可能だった
 * （敵対的レビュー 2026-09-09 の指摘）。しかもパターンA（AI画像の作り直し）が
 * 成功しても B で必ず落ちるので、「成功したのに [失敗] と出る」形になっていた。
 * tsconfig.main.json に node 側の合成実装を含めてビルドし、ここから
 * **同じ node で**直接呼ぶ。
 */
const RECOVERY_JS = path.join(ROOT, 'dist', 'main', 'test', 'memorial-card-recovery.js');

/**
 * ImageMagick を PATH に載せる。
 * 当日PCの ImageMagick は binImageMagick にフォルダ複製で置いてあり、
 * **PATH には入っていない**（start-kidspg.bat がアプリ起動の間だけ足している）。
 * 別ウィンドウで動く救済ツールからは見えないので、ここでも足す。
 */
const withMagickPath = (env) => {
  for (const dir of [
    path.join(ROOT, '..', 'bin', 'ImageMagick'), // 配布された ops から見た場所
    path.join(ROOT, 'bin', 'ImageMagick'),
  ]) {
    if (fs.existsSync(path.join(dir, 'magick.exe'))) {
      return { ...env, PATH: dir + path.delimiter + (env.PATH || '') };
    }
  }
  return env;
};

/**
 * 合成を非同期で走らせる。
 * 同期実行にすると保守ロックの heartbeat と SIGINT ハンドラが止まるため、
 * 必ず spawn + タイムアウトで待つ。
 */
const runRecovery = (datetime, timeoutMs, resultsDir) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [RECOVERY_JS, '--only', datetime], {
    cwd: ROOT,
    stdio: 'inherit',
    env: withMagickPath({
      ...process.env,
      KIDSPG_RESULTS_DIR: resultsDir,
      // 🔴 保守ロックは**このプロセスが既に持っている**。子（recovery）が
      // 自分で取りに行くと、親の握っているロックで弾かれて1件も直せない。
      // 直接 `npm run recovery` を叩いたときだけ、あちら側が自分で取る。
      KIDSPG_MAINTENANCE_LOCK_HELD: '1',
    }),
  });
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`時間上限(${Math.round(timeoutMs / 1000)}秒)に達しました。ImageMagick が固まっている可能性があります`));
  }, timeoutMs);
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve();
    else reject(new Error(`カードの合成が exit code ${code} で終了しました`));
  });
});

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.errors.length) {
    for (const e of args.errors) log(`!! ${e}`);
    log('');
    log('使い方: node tools/retry-failed.cjs [--apply] [--only <日時>] [--timeout-min <分>] [--rebuild-index] [--force-unlock]');
    process.exitCode = 2;
    return;
  }
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
  // テストや退避先の検証で results/ を差し替えられるようにする
  // results の場所は tools/lib/resolve-results-dir.cjs に集めてある
  // （配布された ops から実行すると ops/results を見てしまい、当日動かなかった）
  const resolvedResults = resolveResultsDir(ROOT);
  const resultsDir = resolvedResults.dir;
  const resultsJson = path.join(resultsDir, 'results.json');

  const { resolveComfyUIConfig } = requireDist('comfyui-config.js');
  ({ verifyPngFileSync } = requireDist('png-integrity.js'));
  const cardOutput = requireDist('card-output.js');
  const { cleanupPartialCardOutputs, acquireMaintenanceLock } = cardOutput;
  buildPartialOutputPath = cardOutput.buildPartialOutputPath;
  renameWithRetry = cardOutput.renameWithRetry;
  warnIfDistIsStale();

  const comfy = resolveComfyUIConfig(config.comfyui);
  const outputPrefix = comfy.workflow.outputPrefix;

  if (!fs.existsSync(resultsDir)) {
    // 🔴 探した場所を必ず見せる。以前はパスを出さず、しかも終了コード 0 で
    // 終わっていたため「エラーが出ていない＝直った」と読めた
    log(describeMissing(resolvedResults));
    process.exitCode = 1;
    return;
  }

  // 🔴 アプリの起動時点検と同時に走ると、相手が作り直した正常なカードを
  // 退避してしまう。プロセスを越えた排他を取る（--apply のときだけ）。
  let release = null;
  if (args.apply) {
    if (args.forceUnlock) {
      // アプリの強制終了などでロックが残ると、点検も救済も止まる。
      // 「他に誰も動いていない」ことを人が確認したうえで外すための逃げ道
      const lockPath = path.join(resultsDir, '.maintenance.lock');
      if (fs.existsSync(lockPath)) {
        await fsp.unlink(lockPath).catch(() => undefined);
        log('!! --force-unlock: 残っていた保守ロックを外しました（アプリと救済ツールを同時に動かしていないことを確認してください）');
      }
    }
    release = await acquireMaintenanceLock(resultsDir);
    if (!release) {
      log('!! 別のプロセスが results/ を保守中です（アプリの起動時点検など）。少し待ってから再実行してください');
      process.exitCode = 1;
      return;
    }
    // Ctrl-C で finally を通らずに終わると、ロックが残って
    // 「アプリの起動時点検が毎回スキップされる」「再実行も拒否される」状態になる
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.once(sig, async () => {
        log('');
        log('中断されました。ロックを解放します');
        try { await release(); } catch { /* 解放できなくても終了する */ }
        process.exit(130);
      });
    }
  }

  try {
    let dirs = fs.readdirSync(resultsDir).filter((d) => /^\d{8}_\d{6}$/.test(d)).sort();
    if (args.only) dirs = dirs.filter((d) => d === args.only);

    log(`対象: ${dirs.length} 件 / プロファイル ${comfy.profileName} (${comfy.baseUrl})`);
    log(args.apply ? '★ --apply 指定あり: 実際に修復します\n' : '（ドライラン。実行するには --apply を付けてください）\n');

    const todo = { A: [], B: [], C: [], skip: [], broken: [], unreadable: [], unverified: [] };
    for (const dt of dirs) {
      const st = inspect(resultsDir, dt);
      if (st.unreadable) { todo.unreadable.push([dt, st.unreadable]); continue; }
      if (!st.result) { todo.skip.push([dt, 'result.json が無い（ゲーム未完了。対象外）']); continue; }
      if (!st.photo) { todo.skip.push([dt, '撮影写真が無い（復旧不能）']); continue; }
      if (!st.anime) {
        if (st.unverifiedAnime) {
          // AI画像を検査できなかった回で再投入すると、既にある完全な画像を
          // 上書きしてしまう（「既にあるファイルは上書きしない」約束に反する）
          todo.unverified.push([dt, st.unverifiedAnime]);
          continue;
        }
        if (!st.gen) { todo.skip.push([dt, 'image_generate.json が無い（再投入できない）']); continue; }
        todo.A.push(st); continue;
      }
      if (!st.card) {
        if (st.unverifiedCard) {
          // 読めなかっただけの可能性がある。**触らない**（完成品を退避しない）
          todo.unverified.push([dt, st.unverifiedCard]);
          continue;
        }
        // 🔴 壊れたカードの退避は「作り直せる回」だけにする。
        // 復旧不能な回まで退避すると、「上半分だけでも映っていた」状態から
        // 「何も無い」状態への純粋な劣化になる（誰も作り直さない）。
        if (st.brokenCard) todo.broken.push([dt, st.brokenCard]);
        todo.B.push(st);
        continue;
      }
      todo.C.push(st); // パスの張り直しが必要かは後で判定
    }

    // --- 一覧表示 ---
    const label = {
      A: 'A: AI画像が無い → ComfyUI へ再投入',
      B: 'B: カードが無い → 合成し直す',
      C: 'C: 成果物は揃っている → パスを点検',
    };
    for (const k of ['A', 'B', 'C']) {
      if (todo[k].length) log(`${label[k]}  (${todo[k].length}件)\n  ${todo[k].map((s) => s.dt).join(', ')}\n`);
    }
    for (const [dt, why] of todo.broken) log(`  !! ${dt}: カードが壊れています → ${why}（退避して作り直します）`);
    for (const [dt, why] of todo.unverified) log(`  ?? ${dt}: 検査できなかったので触りません → ${why}`);
    for (const [dt, why] of todo.unreadable) log(`  !! ${dt}: フォルダを読めません (${why})`);
    for (const [dt, why] of todo.skip) log(`  skip ${dt}: ${why}`);

    // --- 合成中の残骸の始末（アプリ本体と同じ実装に委ねる） ---
    // 完成しているものは最終名へ据え直す（＝カードの救済）。
    // 5分ガードがあるので、いま合成中の子のファイルは消さない。
    let rescued = 0, removedPartials = 0;
    if (args.apply) {
      for (const dt of dirs) {
        const sweep = await cleanupPartialCardOutputs(path.join(resultsDir, dt));
        for (const f of sweep.rescued) log(`  合成中だったカードを救済: ${path.relative(ROOT, f)}`);
        for (const f of sweep.removed) log(`  壊れた残骸を削除: ${path.relative(ROOT, f)}`);
        rescued += sweep.rescued.length;
        removedPartials += sweep.removed.length;
      }
      // 救済で最終名ができた回は B から外す（作り直す必要が無い）
      if (rescued > 0) {
        for (const dt of dirs) invalidateInspect(dt);
        todo.B = todo.B.filter((st) => !inspect(resultsDir, st.dt).card);
        todo.broken = todo.broken.filter(([dt]) => !inspect(resultsDir, dt).card);
      }
    } else {
      log('  （合成中の残骸の始末・救済は --apply 時のみ）');
    }

    // --- B（合成）が使えるかを先に確かめる ---
    // 🔴 当日PCに node_modules が無い／magick が無い環境で退避だけ進むと、
    // 「半分表示のカードを片付けたのに作り直せない」＝純粋な劣化で終わる。
    let canRebuild = true;
    if (args.apply && (todo.B.length || todo.broken.length)) {
      try {
        if (!fs.existsSync(RECOVERY_JS)) {
          throw new Error(
            'カード合成の実装が見つかりません: ' + RECOVERY_JS +
            '\n（開発機なら npm run build、配布版ならパッケージの作り直しが必要です）'
          );
        }
        execFileSync(process.execPath, [RECOVERY_JS, '--only', '00000000_000000', '--dry-run'], {
          cwd: ROOT, stdio: 'pipe', timeout: 120_000,
          env: withMagickPath({ ...process.env, KIDSPG_RESULTS_DIR: resultsDir }),
        });
      } catch (e) {
        canRebuild = false;
        log('');
        log(`!! カードの合成（npm run recovery）が使えません: ${e.message}`);
        log('   node_modules や ImageMagick を確認してください。作り直せないので、壊れたカードの退避は行いません');
      }
    }

    // --- 壊れたカードの退避（作り直せる回だけ） ---
    // 🔴 **参照を先にプレースホルダへ倒してから実体を動かす。**
    // 逆順だと、この後の作り直しが失敗・中断（Ctrl-C）したときに
    // 「参照は正規カードなのに実体が無い」状態が残り、ランキングは割れた枠、
    // 後日の公開でもその子が欠ける（半分表示より悪い）。
    let quarantined = 0, quarantineSkipped = 0, quarantineFailed = 0;
    for (const [dt] of todo.broken) {
      if (!canRebuild) { quarantineSkipped += 1; continue; }
      const st = inspect(resultsDir, dt);
      const broken = path.join(resultsDir, dt, `memorial_card_${dt}.png`);
      if (!st.dummy) {
        // プレースホルダが無い／壊れている回は、退避すると表示が空になる。触らない
        quarantineSkipped += 1;
        log(`  ?? ${dt}: プレースホルダが使えないため退避しません（作り直しだけ試みます）`);
        continue;
      }
      log(`  参照をプレースホルダへ戻す: ${dt}`);
      const reverted = await revertReferencesToDummy(st, resultsJson, args.apply);
      if (!reverted) { quarantineSkipped += 1; continue; }
      log(`  壊れたカードを退避: ${path.relative(ROOT, broken)} → .broken`);
      if (args.apply) {
        try {
          // 退避も rename なので、同期・AV との共有違反に対して粘る
          await renameWithRetry(broken, `${broken}.broken-${Date.now()}`);
          invalidateInspect(dt);
          quarantined += 1;
        } catch (e) {
          quarantineFailed += 1;
          log(`    !! 退避に失敗: ${e.message}`);
        }
      }
    }

    // --- A: AI画像の再生成 ---
    if (todo.A.length && args.apply) {
      try {
        const stats = await (await fetchComfy(`${comfy.baseUrl}/system_stats`, {}, 10_000)).json();
        log(`\nComfyUI OK (device=${stats.devices?.[0]?.type})`);
      } catch {
        log(`\n!! ComfyUI (${comfy.baseUrl}) に繋がりません。A の ${todo.A.length} 件は飛ばします`);
        todo.A.length = 0;
      }
    }
    let failedA = 0;
    for (const st of todo.A) {
      if (!args.apply) continue;
      log(`\n[A] ${st.dt} を再生成します（CPU 実行では1枚3分ほどかかります）`);
      try {
        const name = await regenerateAnime(st, comfy, outputPrefix, Date.now() + args.timeoutMs);
        log(`    AI画像を作成: ${name}`);
        invalidateInspect(st.dt);
        todo.B.push(inspect(resultsDir, st.dt)); // 続けてカードを作る
      } catch (e) {
        failedA += 1;
        log(`    !! 失敗: ${e.message}`);
      }
    }

    // --- B: カードの合成。既存の実績あるスクリプトへ委譲する ---
    // 🔴 **対象を1件ずつ渡す。** 引数なしで呼ぶと recovery は results/ 全体を走査し、
    // 未生成のすべてを直列で合成する（数十分〜数時間）。当日それは
    // 稼働中のアプリと CPU / ディスクを奪い合い、新たなタイムアウト＝
    // 新たな取りこぼしを生む。
    let builtB = 0, failedB = 0;
    if (todo.B.length) {
      if (args.apply) {
        log(`\n[B] カードを合成します（${todo.B.length}件）`);
        for (const st of todo.B) {
          try {
            // 🔴 **同期実行（execFileSync）にしない。** イベントループを塞ぐと
            // 保守ロックの heartbeat が止まり（＝生きているのに横取りされる）、
            // Ctrl-C のハンドラも動かない。時間上限も必ず付ける。
            await runRecovery(st.dt, Math.min(args.timeoutMs, 10 * 60 * 1000), resultsDir);
          } catch (e) {
            log(`    !! recovery が失敗しました (${st.dt}): ${e.message}`);
          }
          // 委譲先の成否を鵜呑みにせず、実体で確かめる
          invalidateInspect(st.dt);
          if (inspect(resultsDir, st.dt).card) {
            builtB += 1;
          } else {
            failedB += 1;
            log(`    !! ${st.dt} のカードは作られませんでした`);
          }
        }
      } else {
        log(`\n[B] ${todo.B.length}件は \`npm run recovery -- --only <日時>\` で合成されます`);
      }
    }

    // --- C: results.json / result.json のパスを張り直す ---
    let fixedIndex = 0, fixedResult = 0, failedC = 0;
    const needCacheRelink = [];

    for (const dt of dirs) {
      const st = inspect(resultsDir, dt);
      if (st.unreadable || !st.card) continue; // 本カードが無いなら張り替えない
      const regular = `${dt}/memorial_card_${dt}.png`;

      // result.json は1件ずつ独立して直す。1件の破損で全体を止めない
      // （止めると「カードはあるのにランキングはダミー」のまま終わる）
      try {
        const rp = path.join(st.dir, 'result.json');
        const rj = JSON.parse(await fsp.readFile(rp, 'utf-8'));
        if (rj.memorialCardPath !== regular) {
          log(`[C] ${dt}: result.json に memorialCardPath を記録`);
          if (args.apply) { rj.memorialCardPath = regular; await writeJsonAtomic(rp, rj); }
          fixedResult += 1;
        }
      } catch (e) {
        failedC += 1;
        log(`  !! ${dt}: result.json を直せません (${e.message})`);
      }

      needCacheRelink.push(dt);
    }

    // 表示キャッシュ（results.json）は**書く直前に読み直す**。
    // 開始時のスナップショットを書き戻すと、その間にアプリが確定した
    // 新しいプレイのエントリを丸ごと巻き戻してしまう（受付中は致命的）。
    if (needCacheRelink.length) {
      let data = { recent: [], ranking_top: [] };
      try {
        if (fs.existsSync(resultsJson)) data = JSON.parse(await fsp.readFile(resultsJson, 'utf-8'));
      } catch (e) {
        // 壊れていても**退避しない**（アプリ側の loadResults が退避するので二重に消さない）。
        // ここでは張り替えを諦めるだけにする（正本の result.json は上で直している）
        failedC += 1;
        log(`  !! results.json を読めないため表示キャッシュの張り替えを飛ばします (${e.message})`);
        data = null;
      }
      if (data) {
      for (const dt of needCacheRelink) {
        const regular = `${dt}/memorial_card_${dt}.png`;
        const dummy = `${dt}/memorial_card_${dt}.dummy.png`;
        for (const arr of [data.recent, data.ranking_top]) {
          for (const e of arr || []) {
            if (e.memorialCardPath === dummy) {
              log(`[C] ${dt}: results.json をプレースホルダ → 本カードへ`);
              e.memorialCardPath = regular;
              fixedIndex += 1;
            }
          }
        }
      }
      if (args.apply && fixedIndex > 0) {
        try {
          await writeJsonAtomic(resultsJson, data);
        } catch (e) {
          failedC += 1;
          log(`  !! results.json を書けませんでした (${e.message})`);
        }
      }
      }
    }

    // --- 表示キャッシュ（results.json）の作り直し ---
    // 電源断や途中書きで results.json が壊れると、アプリ側の loadResults が
    // それを退避して**空**にする。当日のトップ10はそれで消えるが、
    // 記録の正本は各プレイの result.json にあるので、そこから組み直せる。
    let rebuilt = 0;
    if (args.rebuildIndex) {
      const maxRecent = (config.results && config.results.maxRecent) || 30;
      const maxRanking = (config.results && config.results.maxRanking) || 10;
      // 🔴 検査できなかった（unknown）回を「カードが無い」と同一視しない。
      // OneDrive がオフライン気味の時間帯に1回叩くと、完成カードが一斉に
      // プレースホルダ参照へ格下げされ、プレースホルダも無い回は索引から消える。
      // 以前の参照（退避前の results.json）を読んでおき、判断できない回はそれを引き継ぐ。
      const previous = new Map();
      try {
        if (fs.existsSync(resultsJson)) {
          const old = JSON.parse(await fsp.readFile(resultsJson, 'utf-8'));
          for (const e of [...(old.recent || []), ...(old.ranking_top || [])]) {
            if (e && typeof e.memorialCardPath === 'string') {
              previous.set(e.memorialCardPath.split('/')[0], e.memorialCardPath);
            }
          }
        }
      } catch {
        // 壊れていて読めないなら引き継ぎ無し（それがこのコマンドを叩く理由）
      }

      const entries = [];
      let degraded = 0;
      for (const dt of dirs) {
        const st = inspect(resultsDir, dt);
        if (st.unreadable || !st.result) continue;
        try {
          const rj = JSON.parse(await fsp.readFile(path.join(st.dir, 'result.json'), 'utf-8'));
          if (typeof rj.score !== 'number') continue;
          // 参照は「実体があり、明確に壊れていないもの」を選ぶ。
          // 判断できないときは以前の参照 → result.json の記録 を引き継ぐ
          const cardRef = st.card
            ? dt + '/' + st.card
            : (st.unverifiedCard
              ? (previous.get(dt) || rj.memorialCardPath || null)
              : (st.dummy ? dt + '/' + st.dummy : (previous.get(dt) || rj.memorialCardPath || null)));
          if (!cardRef) continue;
          if (!st.card) degraded += 1;
          entries.push({
            resultPath: dt + '/result.json',
            memorialCardPath: cardRef,
            score: rj.score,
            playedAt: rj.timestampJST || dt,
          });
        } catch (e) {
          log('  !! ' + dt + ': result.json を読めないため再構築から除外 (' + e.message + ')');
        }
      }

      const recent = [...entries]
        .sort((a, b) => b.resultPath.localeCompare(a.resultPath))
        .slice(0, maxRecent);
      const ranking = [...entries]
        .sort((a, b) => b.score - a.score)
        .slice(0, maxRanking)
        .map((e, i) => ({
          resultPath: e.resultPath,
          memorialCardPath: e.memorialCardPath,
          score: e.score,
          rank: i + 1,
        }));
      rebuilt = entries.length;

      log('');
      log('[R] results.json を ' + entries.length + ' 件の result.json から作り直します'
        + ' (recent ' + recent.length + ' / ranking ' + ranking.length + ')');
      if (degraded) log('    ' + degraded + ' 件は正規カードを確認できなかったため、以前の参照を引き継ぎました');
      if (args.apply) {
        // 🔴 先に新しい索引を書き、**成功してから**旧いものを退避する。
        // 逆順（退避 → 書き込み）だと、書き込みに失敗した時点で
        // results.json が存在しない＝ランキングが全消えの状態で終わる。
        const backup = resultsJson + '.before-rebuild-' + Date.now();
        let backedUp = false;
        if (fs.existsSync(resultsJson)) {
          try {
            await fsp.copyFile(resultsJson, backup);
            backedUp = true;
          } catch (e) {
            // バックアップを取れないなら上書きしない（黙って壊さない）
            log('    !! 既存の results.json を退避できないため作り直しを中止します: ' + e.message);
            rebuilt = 0;
          }
        }
        if (rebuilt !== 0) {
          try {
            await writeJsonAtomic(resultsJson, { recent, ranking_top: ranking });
            log('    作り直しました' + (backedUp ? '（旧ファイルは ' + path.basename(backup) + ' に退避）' : ''));
            // 目印が残ったままだと「常時点灯」で信号として死ぬ
            await fsp.unlink(path.join(resultsDir, '.index-rebuild-needed')).catch(() => undefined);
          } catch (e) {
            log('    !! results.json を書けませんでした: ' + e.message);
            if (backedUp) {
              await fsp.copyFile(backup, resultsJson).catch(() => undefined);
              log('    退避したファイルから元に戻しました');
            }
            rebuilt = 0;
          }
        }
      }
    }

    log('\n--- まとめ ---');
    log(`  合成中だったカードの救済 : ${rescued} 件`);
    log(`  壊れた残骸の削除         : ${removedPartials} 件`);
    log(`  壊れたカードの退避       : ${quarantined} 件`);
    if (quarantineSkipped) log(`  退避を見送った回         : ${quarantineSkipped} 件`);
    if (todo.unverified.length) log(`  検査できず触らない回     : ${todo.unverified.length} 件`);
    log(`  AI画像の再生成の失敗     : ${failedA} 件`);
    log(`  カードを合成できた       : ${builtB} 件`);
    log(`  カードを合成できなかった : ${failedB} 件`);
    log(`  results.json の張り替え  : ${fixedIndex} 箇所`);
    log(`  result.json への記録     : ${fixedResult} 件`);
    if (args.rebuildIndex) log(`  results.json の作り直し  : ${rebuilt} 件から`);
    if (failedC) log(`  result.json を直せない   : ${failedC} 件`);
    if (todo.unreadable.length) log(`  読めないフォルダ         : ${todo.unreadable.length} 件`);

    if (!args.apply) {
      log('\n実行するには: node tools/retry-failed.cjs --apply');
    } else {
      log('\n完了しました。ランキング画面は results.json の更新を検知して自動で読み直します。');
      // 🔴 「検査できなかった」は**その子のカードが公開物に出るか未確定**という
      // 最重要の未解決事項。完了メッセージと exit 0 で流すと異常なしと読まれる。
      if (failedA || failedB || failedC || todo.unverified.length || todo.unreadable.length || quarantineFailed) {
        log('!! 未解決のものがあります。上のログを確認してください');
        process.exitCode = 1;
      }
    }
  } finally {
    if (release) await release();
  }
};

main().catch((e) => { console.error('失敗:', e); process.exitCode = 1; });
