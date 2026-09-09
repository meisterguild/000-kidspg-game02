#!/usr/bin/env node
/**
 * ComfyUI スモークテスト（ローカルPC用）
 *
 *   node tools/comfyui-smoke.cjs [--photo <png>] [--out <dir>] [--workflow <json>]
 *                                [--timeout-min <分>] [--runs <回数>]
 *                                [--gen <名前>=<値> ...]
 *
 * やること:
 *   1. /system_stats で疎通と実行デバイス（cuda / cpu）を確認する
 *   2. /object_info と突き合わせ、**置換後の**ワークフローを検証する。
 *      ノード定義・必須入力・未知入力に加えて、**すべての combo 入力の値**
 *      （モデルのファイル名、sampler_name、scheduler、ControlNet の type など）が
 *      ComfyUI 側の選択肢に存在するかを見る
 *   3. 写真を1枚アップロードし、実際に生成を回して秒数を実測する
 *   4. 出力が SaveImage ノード（ID 9 → 8 の優先順。comfyui-worker.ts と同じ）から
 *      期待した prefix で出ていることを確認し、PNG を保存する
 *
 * これは Electron を起動せずに ComfyUI 側だけを切り分けるための道具。
 * アプリまで含めた通しは tools/e2e-local-play.cjs のほう。
 *
 * 注意:
 *   - 事前に `npm run build` が必要（アプリ本体と同じ置換関数 dist/.../workflow-template.js を使う）
 *   - **CPU 実行では1回の生成に約3分かかる**（inputSize 384・実測170秒）。
 *     固まったように見えても待つこと
 *   - `--runs 2` 以上にすると2回目以降はモデルロード済みの「温まった」時間が測れる。
 *     当日の人数計算に使うべきなのは2回目以降の値
 *   - `--gen inputSize=384` のように書くと、config.json の生成パラメータを
 *     **その回だけ**上書きして測れる（config.json は書き換えない）。
 *     画質を落として時間を詰めるときの実測に使う。複数指定できる:
 *       node tools/comfyui-smoke.cjs --gen inputSize=384 --gen steps=6
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// comfyui-worker.ts の completeJob と同じ優先順。ここを揃えておかないと
// 「smoke は通るのにアプリは出力を見つけられない」が起きる。
const SAVE_NODE_PRIORITY = ['9', '8'];

const parseArgs = (argv) => {
  const args = { photo: null, out: null, workflow: null, timeoutMs: 60 * 60 * 1000, runs: 1, gen: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--photo') { args.photo = value; i += 1; }
    else if (key === '--out') { args.out = value; i += 1; }
    else if (key === '--workflow') { args.workflow = value; i += 1; }
    else if (key === '--timeout-min') { args.timeoutMs = Number(value) * 60 * 1000; i += 1; }
    else if (key === '--runs') { args.runs = Number(value); i += 1; }
    else if (key === '--gen') {
      // 生成パラメータをこの回だけ上書きする。config.json は書き換えない。
      const eq = String(value || '').indexOf('=');
      if (eq <= 0) throw new Error('--gen は 名前=値 の形で指定してください（例 --gen inputSize=384）');
      const name = value.slice(0, eq);
      const rawValue = value.slice(eq + 1);
      // 数値に見えるものは数値にする（inputSize などは数値でないとテンプレに焼けない）
      args.gen[name] = /^-?\d+(\.\d+)?$/.test(rawValue) ? Number(rawValue) : rawValue;
      i += 1;
    }
  }
  return args;
};

/**
 * 置換後のワークフローを /object_info と突き合わせる。
 * combo 入力（spec[0] が配列のもの）は値が選択肢に含まれるかまで見る。
 * モデルのファイル名も combo なので、これだけで「モデルが置かれていない」を検出できる。
 */
const validateAgainstObjectInfo = (workflow, objectInfo) => {
  const errors = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    const def = objectInfo[node.class_type];
    if (!def) {
      errors.push(`node ${nodeId}: 未定義のノード ${node.class_type}`);
      continue;
    }
    const required = def.input?.required ?? {};
    const optional = def.input?.optional ?? {};
    const known = new Set([...Object.keys(required), ...Object.keys(optional)]);

    for (const name of Object.keys(required)) {
      if (!(name in (node.inputs ?? {}))) {
        errors.push(`node ${nodeId} (${node.class_type}): 必須入力 ${name} がありません`);
      }
    }

    for (const [name, value] of Object.entries(node.inputs ?? {})) {
      if (!known.has(name)) {
        errors.push(`node ${nodeId} (${node.class_type}): 未知の入力 ${name}`);
        continue;
      }
      // 配列は他ノードからの配線（["18", 0]）。値の検証対象ではない
      if (Array.isArray(value)) continue;

      // LoadImage.image の選択肢は ComfyUI 起動時に input ディレクトリを走査して作られる
      // スナップショット。いま /upload/image したファイルは載っていないので、
      // ここを検証すると必ず落ちる（アップロード済みなら ComfyUI は問題なく読める）。
      if (node.class_type === 'LoadImage' && name === 'image') continue;

      const spec = required[name] ?? optional[name];
      const choices = Array.isArray(spec?.[0]) ? spec[0] : null;
      if (choices && !choices.includes(value)) {
        const shown = choices.length > 12 ? `${choices.slice(0, 12).join(', ')} …他${choices.length - 12}件` : choices.join(', ');
        errors.push(
          `node ${nodeId} (${node.class_type}): ${name}="${value}" が ComfyUI の選択肢にありません。` +
          ` 選択肢: [${shown || '(なし)'}]`
        );
      }
    }
  }
  return errors;
};

const getJson = async (url, { retries = 3, timeoutMs = 15000 } = {}) => {
  let lastError;
  for (let i = 0; i <= retries; i += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) {
      // 生成中の ComfyUI は一瞬詰まることがある。1回の失敗でテストを落とさない。
      lastError = e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastError;
};

const uploadImage = async (baseUrl, filePath, asName) => {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('image', new Blob([buf], { type: 'image/png' }), asName);
  form.append('overwrite', 'true');
  const res = await fetch(`${baseUrl}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`upload -> ${res.status} ${await res.text()}`);
  return (await res.json()).name;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * dist が src より古くないかを見る。
 * 検証ツールは dist を require するので、ビルドし忘れると
 * **直したはずの実装が反映されないまま「成功」してしまう**。
 *
 * ⚠️ **src/ が無い置き方でも動かないといけない。**
 * 当日PC へ配る ops/ には tools と dist/main と config.json だけを入れ、
 * ソースは配らない（配布パッケージの設計は docs/distribution-plan.md）。
 * 以前はここで src/main を無条件に読んでいたため、当日PC でこのツールを
 * 走らせると ENOENT で落ちていた——**当日手順書に書いた検証手順そのものが
 * 通らない**状態だった（2026-09-09 に実測で発覚）。
 * ソースが無いのは「開発機ではない」ということなので、点検を飛ばす。
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
  const srcDir = pathx.join(root, 'src', 'main');
  if (!fsx.existsSync(srcDir)) {
    console.log('[smoke] src が無いので dist の新しさは確かめません（配布された ops での実行）');
    return;
  }
  const src = newest(srcDir);
  const dist = newest(pathx.join(root, 'dist', 'main'));
  if (src > dist) {
    throw new Error(
      'dist が src より古いままです。先に `npm run build` を実行してください' +
      `（src の最終更新 ${new Date(src).toISOString()} > dist ${new Date(dist).toISOString()}）`
    );
  }
};


const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
  // アプリ本体と同じ関数で activeProfile を解決する。
  // ここで別実装を持つと「ツールは local を見ているのにアプリは server を見ている」が起きる。
  const { resolveComfyUIConfig } = require(
    path.join(ROOT, 'dist', 'main', 'main', 'services', 'comfyui-config.js')
  );
  const comfy = resolveComfyUIConfig(config.comfyui);
  const baseUrl = comfy.baseUrl;
  console.log(`[smoke] profile   : ${comfy.profileName} (${comfy.profileLabel})`);

  const workflowPath = args.workflow
    ? path.resolve(args.workflow)
    : path.join(ROOT, comfy.workflow.templatePath);
  const outDir = args.out ? path.resolve(args.out) : path.join(ROOT, 'tmp', 'smoke');
  // 既定の写真は**複数の置き場所を試す**。
  // ⚠️ 当日PC へ配る ops/ には src/ が無い（dist と tools と assets だけ）。
  // 以前は src 配下だけを見ていたため、当日PC でこのツールを走らせると
  // 「写真がありません」で止まっていた——**当日手順書に書いた検証手順が
  // 通らない**状態だった（2026-09-09 に実測で発覚）。
  const photoCandidates = args.photo
    ? [path.resolve(args.photo)]
    : [
        path.join(ROOT, 'src', 'renderer', 'assets', 'images', 'dummy_photo.png'), // 開発機
        path.join(ROOT, 'assets', 'dummy_photo.png'),                              // 配布された ops
      ];
  const photoPath = photoCandidates.find((p) => fs.existsSync(p)) || photoCandidates[0];

  const templateModulePath = path.join(ROOT, 'dist', 'main', 'main', 'services', 'workflow-template.js');
  if (!fs.existsSync(templateModulePath)) {
    throw new Error(`dist が見つかりません。先に \`npm run build\` を実行してください: ${templateModulePath}`);
  }
  assertDistFresh(ROOT);
  if (!fs.existsSync(photoPath)) {
    throw new Error(
      '写真がありません。探した場所:\n  ' +
        photoCandidates.join('\n  ') +
        '\n--photo <png> で明示することもできます'
    );
  }
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[smoke] baseUrl   : ${baseUrl}`);
  console.log(`[smoke] workflow  : ${workflowPath}`);
  console.log(`[smoke] photo     : ${photoPath}`);
  const genKeys = Object.keys(args.gen);
  if (genKeys.length) {
    console.log(
      '[smoke] 上書き    : ' +
        genKeys.map((k) => `${k}=${comfy.generation[k]} → ${args.gen[k]}`).join(', ')
    );
  }
  console.log(`[smoke] out       : ${outDir}`);

  // 1. 疎通とデバイス
  const stats = await getJson(`${baseUrl}/system_stats`);
  const device = stats.devices?.[0];
  console.log(`[smoke] ComfyUI    : ${stats.system?.comfyui_version ?? '?'} / python ${stats.system?.python_version?.split(' ')[0] ?? '?'} / torch ${stats.system?.pytorch_version ?? '?'}`);
  console.log(`[smoke] device     : type=${device?.type ?? '?'} name=${device?.name ?? '?'} vram=${device?.vram_total ?? '?'}`);
  if (device?.type === 'cpu') {
    console.log('[smoke] ※ CPU 実行です。1枚あたり約3分かかります（inputSize 384・実測170秒）。途中で止めないでください');
  }

  // キューが空でないと計測値が意味を持たない
  const queue = await getJson(`${baseUrl}/queue`);
  const busy = (queue.queue_running?.length ?? 0) + (queue.queue_pending?.length ?? 0);
  if (busy > 0) {
    console.warn(`[smoke] 警告: ComfyUI のキューに既に ${busy} 件あります。計測値は当てになりません`);
  }

  // 2. テンプレート → 置換 → 検証（検証するのは実際に投げるものと同一の JSON）
  const template = JSON.parse(fs.readFileSync(workflowPath, 'utf-8'));
  const { applyWorkflowVariables, checkGenerationWiring, validateWorkflowTemplate } =
    require(templateModulePath);

  const templateErrors = validateWorkflowTemplate(template);
  if (templateErrors.length) {
    console.error('[smoke] テンプレートの約束違反:');
    templateErrors.forEach((e) => console.error(`  - ${e}`));
    process.exitCode = 1;
    return;
  }

  const objectInfo = await getJson(`${baseUrl}/object_info`, { timeoutMs: 60000 });
  console.log(`[smoke] object_info: ${Object.keys(objectInfo).length} nodes`);

  const durations = [];
  for (let run = 1; run <= args.runs; run += 1) {
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}_r${run}`;
    // アプリと同じ形のファイル名でアップロードする（アプリは photo_<日時>.png）
    const uploaded = await uploadImage(baseUrl, photoPath, `smoke_${stamp}.png`);
    const expectedPrefix = `smoke_${stamp}`;
    // 生成パラメータ（config.json の generation）もアプリと同じように焼き込む。
    // ここを省くとテンプレート側のフォールバック値で計測してしまい、
    // 「ツールでは速いのに本番は遅い（または絵が違う）」になる。
    const workflow = applyWorkflowVariables(template, {
      outputPrefix: expectedPrefix,
      photoFileName: uploaded,
      generation: { ...comfy.generation, ...args.gen },
    });

    if (run === 1) {
      checkGenerationWiring(workflow).forEach((w) => console.warn('[smoke] 警告: ' + w));
    }

    if (run === 1) {
      const errors = validateAgainstObjectInfo(workflow, objectInfo);
      if (errors.length) {
        console.error('[smoke] ワークフロー検証 NG:');
        errors.forEach((e) => console.error(`  - ${e}`));
        process.exitCode = 1;
        return;
      }
      console.log('[smoke] ワークフロー検証 OK（ノード・必須入力・combo値・モデル実在）');
      fs.writeFileSync(path.join(outDir, 'image_generate.json'), JSON.stringify(workflow, null, 2));
    }

    console.log(`[smoke] --- run ${run}/${args.runs} (uploaded=${uploaded}) ---`);
    const started = Date.now();
    const promptRes = await fetch(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: `smoke-${Date.now()}` }),
    });
    if (!promptRes.ok) {
      console.error(`[smoke] /prompt NG: ${promptRes.status}\n${await promptRes.text()}`);
      process.exitCode = 1;
      return;
    }
    const { prompt_id: promptId } = await promptRes.json();
    console.log(`[smoke] prompt_id  : ${promptId}`);

    // 3. 完了待ち。CPU 実行だと分単位なので進捗を出し続ける。
    //    「キューにも history にも居ない」＝取り違え/中断なので、待ち続けずに落とす。
    let history = null;
    let lastLog = 0;
    let missingStreak = 0;
    const deadline = started + args.timeoutMs;
    while (Date.now() < deadline) {
      const h = await getJson(`${baseUrl}/history/${promptId}`);
      const entry = h[promptId];
      if (entry?.status?.completed) { history = entry; break; }
      if (entry?.status?.status_str === 'error') {
        console.error('[smoke] 実行エラー:', JSON.stringify(entry.status, null, 2));
        process.exitCode = 1;
        return;
      }
      if (!entry) {
        const q = await getJson(`${baseUrl}/queue`);
        const inQueue = [...(q.queue_running ?? []), ...(q.queue_pending ?? [])]
          .some(([, id]) => id === promptId);
        missingStreak = inQueue ? 0 : missingStreak + 1;
        if (missingStreak >= 3) {
          console.error('[smoke] prompt がキューにも history にも見当たりません（中断／サーバ再起動の疑い）');
          process.exitCode = 1;
          return;
        }
      }
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (elapsed - lastLog >= 30) { lastLog = elapsed; console.log(`[smoke] ... ${elapsed}s 経過`); }
      await sleep(2000);
    }
    if (!history) {
      console.error(`[smoke] タイムアウト（${Math.round(args.timeoutMs / 60000)}分）`);
      process.exitCode = 1;
      return;
    }

    const elapsedSec = (Date.now() - started) / 1000;
    durations.push(elapsedSec);

    // 4. 出力ノードと prefix を確認する。
    //    どのノードの画像でもよいことにすると、SaveImage が動いていなくても OK になる。
    const outputs = history.outputs ?? {};
    const nodeId = SAVE_NODE_PRIORITY.find((id) => (outputs[id]?.images ?? []).length > 0);
    if (!nodeId) {
      console.error(`[smoke] SaveImage ノード（${SAVE_NODE_PRIORITY.join(' / ')}）に出力がありません。` +
        ` 出力のあったノード: [${Object.keys(outputs).join(', ')}]`);
      process.exitCode = 1;
      return;
    }
    const images = outputs[nodeId].images.filter((i) => i.type === 'output');
    if (!images.length) {
      console.error(`[smoke] node ${nodeId} の出力が type=output ではありません（PreviewImage の一時出力の可能性）`);
      process.exitCode = 1;
      return;
    }
    for (const img of images) {
      if (!img.filename.startsWith(expectedPrefix)) {
        console.error(`[smoke] 出力ファイル名が期待した prefix で始まっていません。` +
          ` 期待=${expectedPrefix}* 実際=${img.filename}。filename_prefix の置換が効いていません`);
        process.exitCode = 1;
        return;
      }
      const url = `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder)}&type=${img.type}`;
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      if (!buf.subarray(0, 8).equals(PNG_MAGIC)) {
        console.error(`[smoke] 出力が PNG ではありません: ${img.filename}`);
        process.exitCode = 1;
        return;
      }
      const dest = path.join(outDir, img.filename);
      fs.writeFileSync(dest, buf);
      console.log(`[smoke] saved      : ${dest} (${(buf.length / 1024).toFixed(0)} KB, node ${nodeId})`);
    }
    console.log(`[smoke] run ${run} 生成時間: ${elapsedSec.toFixed(1)} 秒`);
  }

  console.log('');
  durations.forEach((d, i) => {
    const note = i === 0 ? '（モデルロードを含む初回）' : '（ロード済み。人数計算にはこちらを使う）';
    console.log(`[smoke] run ${i + 1}: ${d.toFixed(1)} 秒 ${note}`);
  });
  console.log('[smoke] OK');
  console.log('[smoke] ※ 生成された画像は必ず目視で確認すること（子ども向けとしての安全性は自動判定できない）');
};

main().catch((e) => {
  console.error('[smoke] 失敗:', e);
  process.exitCode = 1;
});
