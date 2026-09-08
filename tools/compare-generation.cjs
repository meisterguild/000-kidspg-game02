#!/usr/bin/env node
/**
 * 生成パラメータを1つだけ振って見え方を比べる（画質の判断のための道具）
 *
 *   node tools/compare-generation.cjs --photo <png> [--vary <名前>=<値,値,...>]
 *                                     [--sizes 448,384,320] [--seed <数>]
 *                                     [--out <dir>] [--timeout-min <分>]
 *
 * --vary denoise=0.6,0.8,1.0 のように、config.json の生成パラメータを1つ選んで振る。
 * --sizes は --vary inputSize=... の言い換え。
 *
 * 🔴 **シードを固定して回す。** applyWorkflowVariables は本来プレイごとに
 * seed を振り直す（全員が同じ絵にならないようにするため）。振り直したまま
 * 解像度を変えて比べると、**違いが解像度のせいか偶然のせいか分からない。**
 * ここでは randomSeed を固定値に差し替えて、同じ写真・同じシードで
 * 解像度だけを変える。
 *
 * 出力は振った値ごとの PNG と、横並びにした <out>/比較.png。
 * 比較画像はカードと同じ 650px へ、アプリと同じ拡大のしかた
 * （Lanczos + 弱シャープ）で揃えてから並べる。カードの枠は顔の質の
 * 判断に寄与しないので付けない。
 *
 * 事前に `npm run build` が必要（アプリと同じ置換関数を使うため）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const parseArgs = (argv) => {
  const args = {
    photo: null,
    varyKey: 'inputSize',
    varyValues: [448, 384, 320],
    seed: 12345678901234,
    out: path.join(ROOT, 'tmp', 'compare'),
    timeoutMs: 30 * 60 * 1000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--photo') { args.photo = value; i += 1; }
    else if (key === '--sizes') { args.varyKey = 'inputSize'; args.varyValues = value.split(',').map(Number); i += 1; }
    else if (key === '--vary') {
      const eq = String(value || '').indexOf('=');
      if (eq <= 0) throw new Error('--vary は 名前=値,値 の形で指定してください（例 --vary denoise=0.6,0.8）');
      args.varyKey = value.slice(0, eq);
      args.varyValues = value.slice(eq + 1).split(',').map((v) => (/^-?d+(.d+)?$/.test(v) ? Number(v) : v));
      i += 1;
    }
    else if (key === '--seed') { args.seed = Number(value); i += 1; }
    else if (key === '--out') { args.out = path.resolve(value); i += 1; }
    else if (key === '--timeout-min') { args.timeoutMs = Number(value) * 60 * 1000; i += 1; }
  }
  if (!args.photo) throw new Error('--photo で写真を指定してください');
  return args;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = async (url, body, headers = {}) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} が ${res.status}`);
  return res.json();
};

const uploadImage = async (baseUrl, filePath, name) => {
  const form = new FormData();
  const buf = fs.readFileSync(filePath);
  form.append('image', new Blob([buf], { type: 'image/png' }), name);
  form.append('overwrite', 'true');
  const res = await fetch(`${baseUrl}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`アップロードが ${res.status}`);
  const json = await res.json();
  return json.name;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
  const { resolveComfyUIConfig } = require(
    path.join(ROOT, 'dist', 'main', 'main', 'services', 'comfyui-config.js')
  );
  const { applyWorkflowVariables } = require(
    path.join(ROOT, 'dist', 'main', 'main', 'services', 'workflow-template.js')
  );
  const comfy = resolveComfyUIConfig(config.comfyui);
  const baseUrl = comfy.baseUrl;
  const template = JSON.parse(
    fs.readFileSync(path.join(ROOT, comfy.workflow.templatePath), 'utf-8')
  );

  fs.mkdirSync(args.out, { recursive: true });
  const photoPath = path.resolve(args.photo);
  if (!fs.existsSync(photoPath)) throw new Error(`写真がありません: ${photoPath}`);

  console.log(`[compare] 接続先 : ${baseUrl} (${comfy.profileLabel})`);
  console.log(`[compare] 写真   : ${photoPath}`);
  console.log(`[compare] seed   : ${args.seed}（固定。解像度だけの差を見るため）`);
  console.log(`[compare] 振る項目: ${args.varyKey} = ${args.varyValues.join(', ')}`);

  const stamp = Date.now();
  const uploaded = await uploadImage(baseUrl, photoPath, `compare_${stamp}.png`);
  const made = [];

  for (const value of args.varyValues) {
    const prefix = `compare_${stamp}_${args.varyKey}_${String(value).replace(/[^0-9a-zA-Z.-]/g, '_')}`;
    const workflow = applyWorkflowVariables(template, {
      outputPrefix: prefix,
      photoFileName: uploaded,
      // 🔴 ここが要点。固定シードを注入して、解像度以外の条件を揃える
      randomSeed: () => args.seed,
      generation: { ...comfy.generation, [args.varyKey]: value },
    });

    const started = Date.now();
    const { prompt_id: promptId } = await post(`${baseUrl}/prompt`, { prompt: workflow });
    let outName = null;
    while (Date.now() - started < args.timeoutMs) {
      await sleep(2000);
      const hist = await (await fetch(`${baseUrl}/history/${promptId}`)).json();
      const entry = hist[promptId];
      if (!entry) continue;
      for (const nodeId of ['9', '8']) {
        const images = entry.outputs?.[nodeId]?.images;
        if (images && images.length) { outName = images[0]; break; }
      }
      if (outName) break;
      if (entry.status?.status_str === 'error') throw new Error(`生成が失敗しました (${args.varyKey}=${value})`);
    }
    if (!outName) throw new Error(`${args.varyKey}=${value} の生成が時間内に終わりませんでした`);
    const sec = ((Date.now() - started) / 1000).toFixed(1);

    const url =
      `${baseUrl}/view?filename=${encodeURIComponent(outName.filename)}` +
      `&subfolder=${encodeURIComponent(outName.subfolder || '')}&type=${outName.type || 'output'}`;
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const dest = path.join(args.out, `${prefix}.png`);
    fs.writeFileSync(dest, buf);
    made.push({ value, dest, sec });
    console.log(`[compare] ${args.varyKey}=${value} : ${sec} 秒 → ${dest}`);
  }

  // 横並びの比較画像。カードと同じ 650px へ、アプリと同じ拡大のしかたで揃える
  const labelled = made.map(({ value, dest, sec }) => {
    const out = path.join(args.out, `_lab_${String(value).replace(/[^0-9a-zA-Z.-]/g, '_')}.png`);
    execFileSync('magick', [
      dest,
      '-filter', 'Lanczos', '-resize', '650x650',
      '-unsharp', '0x0.75+0.60+0.008',
      '-bordercolor', 'white', '-border', '6',
      '-gravity', 'South', '-pointsize', '30', '-fill', 'black',
      '-undercolor', 'white', '-annotate', '+0+0', `${args.varyKey}=${value} (${sec}s)`,
      out,
    ]);
    return out;
  });
  const sheet = path.join(args.out, '比較.png');
  execFileSync('magick', [...labelled, '+append', sheet]);
  for (const f of labelled) fs.rmSync(f, { force: true });
  console.log(`[compare] 比較画像 : ${sheet}`);

};

main().catch((error) => {
  console.error('[compare] 失敗:', error.message);
  process.exit(1);
});
