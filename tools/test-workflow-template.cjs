#!/usr/bin/env node
/**
 * workflow-template の単体テスト（node:test / 追加依存なし）
 *
 *   npm run build && node --test tools/test-workflow-template.cjs
 *
 * ここは `assets/ComfyUI_KidsPG_2026_01.README.md` の「アプリ側との約束」を
 * コードで守っている場所なので、E2E（実機が要る・1回に十数分かかる）とは別に
 * 分岐だけを短時間で確かめられるようにしておく。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'dist', 'main', 'main', 'services', 'workflow-template.js');
if (!fs.existsSync(MODULE_PATH)) {
  throw new Error(`dist が見つかりません。先に \`npm run build\` を実行してください: ${MODULE_PATH}`);
}
const {
  applyWorkflowVariables,
  checkGenerationApplied,
  checkGenerationWiring,
  validateWorkflowTemplate,
} = require(MODULE_PATH);

const OPTIONS = { outputPrefix: 'photo_anime_20260912_101112', photoFileName: 'photo_20260912_101112.png' };

const baseTemplate = () => ({
  3: { class_type: 'KSampler', inputs: { seed: 1, steps: 8, model: ['18', 0] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: '${filename_prefix}', images: ['8', 0] } },
  11: { class_type: 'LoadImage', inputs: { image: '${photo_png}' } },
});

test('プレースホルダを置換する', () => {
  const out = applyWorkflowVariables(baseTemplate(), OPTIONS);
  assert.strictEqual(out['9'].inputs.filename_prefix, OPTIONS.outputPrefix);
  assert.strictEqual(out['11'].inputs.image, OPTIONS.photoFileName);
});

test('テンプレートを破壊しない（同じオブジェクトを使い回しても汚れない）', () => {
  const t = baseTemplate();
  applyWorkflowVariables(t, OPTIONS);
  assert.strictEqual(t['9'].inputs.filename_prefix, '${filename_prefix}');
  assert.strictEqual(t['11'].inputs.image, '${photo_png}');
});

test('filename_prefix にプレースホルダが無くても値ごと差し替える', () => {
  const t = baseTemplate();
  t['9'].inputs.filename_prefix = 'ComfyUI';
  const out = applyWorkflowVariables(t, OPTIONS);
  assert.strictEqual(out['9'].inputs.filename_prefix, OPTIONS.outputPrefix);
});

test('seed はプレイごとに振り直される', () => {
  const a = applyWorkflowVariables(baseTemplate(), OPTIONS);
  const b = applyWorkflowVariables(baseTemplate(), OPTIONS);
  assert.strictEqual(typeof a['3'].inputs.seed, 'number');
  assert.notStrictEqual(a['3'].inputs.seed, 1);
  assert.notStrictEqual(a['3'].inputs.seed, b['3'].inputs.seed);
});

test('配線された seed（リンク配列）は潰さない', () => {
  const t = baseTemplate();
  t['3'].inputs.seed = ['25', 0];
  const out = applyWorkflowVariables(t, OPTIONS);
  assert.deepStrictEqual(out['3'].inputs.seed, ['25', 0]);
});

test('config.json の全プロファイルのテンプレートが約束を満たしている', () => {
  // local / server どちらを選んでも壊れないこと。片方だけ直して片方を忘れる事故を防ぐ。
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
  const { resolveComfyUIConfig } = require(
    path.join(ROOT, 'dist', 'main', 'main', 'services', 'comfyui-config.js')
  );
  const names = Object.keys(config.comfyui.profiles ?? {});
  assert.ok(names.length > 0, 'profiles が空です');

  for (const name of names) {
    const resolved = resolveComfyUIConfig({ ...config.comfyui, activeProfile: name });
    const template = JSON.parse(
      fs.readFileSync(path.join(ROOT, resolved.workflow.templatePath), 'utf-8')
    );
    assert.deepStrictEqual(validateWorkflowTemplate(template), [], `プロファイル ${name}`);

    // 置換後に ${...} が残らないこと
    const out = applyWorkflowVariables(template, OPTIONS);
    assert.strictEqual(JSON.stringify(out).match(/\$\{[^}]+\}/g), null, `プロファイル ${name}`);

    // outputPrefix はプロファイル間で同一でなければならない
    assert.strictEqual(resolved.workflow.outputPrefix, 'photo_anime', `プロファイル ${name}`);
  }
});

test('activeProfile が存在しない名前なら例外', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
  const { resolveComfyUIConfig } = require(
    path.join(ROOT, 'dist', 'main', 'main', 'services', 'comfyui-config.js')
  );
  assert.throws(() => resolveComfyUIConfig({ ...config.comfyui, activeProfile: 'nope' }), /nope/);
});

test('検証: LoadImage のプレースホルダが無い', () => {
  const t = baseTemplate();
  t['11'].inputs.image = 'fixed.png';
  assert.ok(validateWorkflowTemplate(t).some((e) => e.includes('${photo_png}')));
});

test('検証: SaveImage のノードIDが 9 でも 8 でもない', () => {
  const t = baseTemplate();
  t['77'] = t['9'];
  delete t['9'];
  assert.ok(validateWorkflowTemplate(t).some((e) => e.includes('ノードID')));
});

test('検証: SaveImage が複数ある', () => {
  const t = baseTemplate();
  t['8'] = { class_type: 'SaveImage', inputs: { filename_prefix: '${filename_prefix}' } };
  assert.ok(validateWorkflowTemplate(t).some((e) => e.includes('2 個')));
});

test('検証: 数値 seed を持つ KSampler が無い', () => {
  const t = baseTemplate();
  t['3'].inputs.seed = ['25', 0];
  assert.ok(validateWorkflowTemplate(t).some((e) => e.includes('数値の seed')));
});

test('検証: ComfyUI の UI エクスポート形式を渡された', () => {
  // トップレベルが {nodes:[], links:[]} の形式。置換が1件も起きないまま
  // 生成へ進むのを防げているか
  const uiExport = { nodes: [], links: [], version: 0.4 };
  assert.ok(validateWorkflowTemplate(uiExport).length > 0);
});

// --- ここから: config.json の生成パラメータによる上書き ---

/**
 * 2026年版と同じ配線の最小テンプレート。
 * LoadImage → ImageScale → (Canny → ControlNetApplyAdvanced) / VAEEncode → KSampler
 */
const generationTemplate = () => ({
  3: {
    class_type: 'KSampler',
    inputs: {
      seed: 1,
      steps: 8,
      cfg: 5,
      denoise: 1,
      model: ['18', 0],
      positive: ['10', 0],
      negative: ['10', 1],
      latent_image: ['14', 0],
    },
  },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'ポジ元の文', clip: ['18', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'ネガ元の文', clip: ['18', 1] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: '${filename_prefix}', images: ['8', 0] } },
  10: {
    class_type: 'ControlNetApplyAdvanced',
    inputs: {
      strength: 0.85,
      start_percent: 0,
      end_percent: 0.4,
      positive: ['6', 0],
      negative: ['7', 0],
      image: ['12', 0],
    },
  },
  11: { class_type: 'LoadImage', inputs: { image: '${photo_png}' } },
  12: { class_type: 'Canny', inputs: { low_threshold: 0.25, high_threshold: 0.6, image: ['20', 0] } },
  14: { class_type: 'VAEEncode', inputs: { pixels: ['20', 0], vae: ['13', 0] } },
  20: {
    class_type: 'ImageScale',
    inputs: { upscale_method: 'lanczos', width: 448, height: 448, crop: 'center', image: ['11', 0] },
  },
});

const GENERATION = {
  denoise: 0.6,
  steps: 13,
  cfg: 4.5,
  controlnetStrength: 0.8,
  controlnetStartPercent: 0.1,
  controlnetEndPercent: 0.7,
  cannyLowThreshold: 0.2,
  cannyHighThreshold: 0.55,
  inputSize: 512,
  positivePrompt: 'ポジ新しい文',
  negativePrompt: 'ネガ新しい文',
};

test('生成パラメータがワークフローの値を上書きする', () => {
  const out = applyWorkflowVariables(generationTemplate(), { ...OPTIONS, generation: GENERATION });
  assert.strictEqual(out['3'].inputs.denoise, 0.6);
  assert.strictEqual(out['3'].inputs.steps, 13);
  assert.strictEqual(out['3'].inputs.cfg, 4.5);
  assert.strictEqual(out['10'].inputs.strength, 0.8);
  assert.strictEqual(out['10'].inputs.start_percent, 0.1);
  assert.strictEqual(out['10'].inputs.end_percent, 0.7);
  assert.strictEqual(out['12'].inputs.low_threshold, 0.2);
  assert.strictEqual(out['12'].inputs.high_threshold, 0.55);
  assert.strictEqual(out['20'].inputs.width, 512);
  assert.strictEqual(out['20'].inputs.height, 512);
});

test('プロンプトは配線を辿って正負を取り違えずに書き換える', () => {
  const out = applyWorkflowVariables(generationTemplate(), { ...OPTIONS, generation: GENERATION });
  assert.strictEqual(out['6'].inputs.text, 'ポジ新しい文');
  assert.strictEqual(out['7'].inputs.text, 'ネガ新しい文');
});

test('generation を渡さなければテンプレートの値がそのまま残る', () => {
  const out = applyWorkflowVariables(generationTemplate(), OPTIONS);
  assert.strictEqual(out['3'].inputs.denoise, 1);
  assert.strictEqual(out['6'].inputs.text, 'ポジ元の文');
});

test('配線された入力は数値で潰さない', () => {
  const t = generationTemplate();
  t['3'].inputs.denoise = ['30', 0];
  const out = applyWorkflowVariables(t, { ...OPTIONS, generation: GENERATION });
  assert.deepStrictEqual(out['3'].inputs.denoise, ['30', 0]);
});

test('正負が同じ CLIPTextEncode に行き着く場合はプロンプトを書き換えない', () => {
  // 取り違えるとネガティブが正方向に入り、出せない絵が出る危険がある
  const t = generationTemplate();
  t['10'].inputs.negative = ['6', 0];
  const out = applyWorkflowVariables(t, { ...OPTIONS, generation: GENERATION });
  assert.strictEqual(out['6'].inputs.text, 'ポジ元の文');
});

test('配線チェック: denoise=1 は「写真が輪郭しか使われない」と警告する', () => {
  const out = applyWorkflowVariables(generationTemplate(), OPTIONS);
  assert.ok(checkGenerationWiring(out).some((w) => w.includes('ControlNet の輪郭以外')));
});

test('配線チェック: 正しい img2img 配線なら警告なし', () => {
  const out = applyWorkflowVariables(generationTemplate(), { ...OPTIONS, generation: GENERATION });
  assert.deepStrictEqual(checkGenerationWiring(out), []);
});

test('配線チェック: latent が VAEEncode 由来でなければ警告する', () => {
  const t = generationTemplate();
  t['14'] = { class_type: 'EmptyLatentImage', inputs: { width: 448, height: 448, batch_size: 1 } };
  const out = applyWorkflowVariables(t, { ...OPTIONS, generation: GENERATION });
  assert.ok(checkGenerationWiring(out).some((w) => w.includes('VAEEncode')));
});

test('denoise を下げても steps は据え置かれる（ComfyUI のサンプリング回数は steps のまま）', () => {
  // comfy/samplers.py の set_steps は new_steps=int(steps/denoise) でスケジュールを
  // 引き伸ばし末尾 steps+1 本を使う。つまり回数は steps。
  // ここを「steps × denoise」と誤解して steps を増やすと、CPU 実行の本番PCで
  // 1枚あたりの時間がそのぶん伸びる
  const out = applyWorkflowVariables(generationTemplate(), {
    ...OPTIONS,
    generation: { ...GENERATION, steps: 8, denoise: 0.6 },
  });
  assert.strictEqual(out['3'].inputs.steps, 8);
  assert.deepStrictEqual(checkGenerationWiring(out), []);
});

test('反映照合: 適用できた場合は警告なし', () => {
  const out = applyWorkflowVariables(generationTemplate(), { ...OPTIONS, generation: GENERATION });
  assert.deepStrictEqual(checkGenerationApplied(out, GENERATION), []);
});

test('反映照合: 配線されていて上書きできなかった項目を挙げる', () => {
  const t = generationTemplate();
  t['3'].inputs.denoise = ['30', 0];
  const out = applyWorkflowVariables(t, { ...OPTIONS, generation: GENERATION });
  const warnings = checkGenerationApplied(out, GENERATION);
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].includes('denoise'));
});

test('反映照合: プロンプトを辿れなかった場合も挙げる', () => {
  const t = generationTemplate();
  // ConditioningCombine のような別名の入力を挟むと辿れない
  t['10'].inputs.positive = ['30', 0];
  t['30'] = { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['6', 0] } };
  const out = applyWorkflowVariables(t, { ...OPTIONS, generation: GENERATION });
  assert.ok(checkGenerationApplied(out, GENERATION).some((w) => w.includes('positivePrompt')));
});

test('config.json の各プロファイルは img2img として成立している', () => {
  // 「アニメ調に変換しているつもりで、実際は輪郭以外まったく反映されていない」
  // という状態（denoise=1）へ戻ってしまったら、ここで落とす
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
  const { resolveComfyUIConfig } = require(
    path.join(ROOT, 'dist', 'main', 'main', 'services', 'comfyui-config.js')
  );
  for (const name of Object.keys(config.comfyui.profiles ?? {})) {
    const resolved = resolveComfyUIConfig({ ...config.comfyui, activeProfile: name });
    assert.deepStrictEqual(resolved.warnings, [], `プロファイル ${name} の設定に警告があります`);
    const template = JSON.parse(
      fs.readFileSync(path.join(ROOT, resolved.workflow.templatePath), 'utf-8')
    );
    const out = applyWorkflowVariables(template, { ...OPTIONS, generation: resolved.generation });
    assert.deepStrictEqual(checkGenerationWiring(out), [], `プロファイル ${name}`);
    // config.json に書いた値が1つも取りこぼされていないこと
    assert.deepStrictEqual(checkGenerationApplied(out, resolved.generation), [], `プロファイル ${name}`);

    // config.json の値が実際に焼き込まれているか（テンプレ側の値が残っていないか）
    const ksampler = Object.values(out).find((n) => n.class_type === 'KSampler');
    assert.strictEqual(ksampler.inputs.denoise, resolved.generation.denoise, `プロファイル ${name}`);
    assert.strictEqual(ksampler.inputs.steps, resolved.generation.steps, `プロファイル ${name}`);
  }
});
