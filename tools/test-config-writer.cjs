#!/usr/bin/env node
/**
 * config-writer の単体テスト（node:test / 追加依存なし）
 *
 *   npm run build && node --test tools/test-config-writer.cjs
 *
 * ここはテスト・設定画面の「保存」が通る道。レンダラから来た値を config.json へ
 * そのまま書かないための関門なので、弾くべき入力を弾けているかを分岐で確かめる。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'dist', 'main', 'main', 'services', 'config-writer.js');
if (!fs.existsSync(MODULE_PATH)) {
  throw new Error(`dist が見つかりません。先に \`npm run build\` を実行してください: ${MODULE_PATH}`);
}
const { applyConfigPatch } = require(MODULE_PATH);

const baseConfig = () => ({
  _comment_game_settings: '注釈（保存で消えてはいけない）',
  game: {
    timeLimitSeconds: 120,
    partialScoreRate: 0,
    levelUpScoreInterval: 60,
    maxStages: 0,
    repeatLastStage: true,
    rankThresholds: [1112, 920, 728, 536, 344, 200, 88],
    stageProgression: [{ size: 4, difficulty: 'veasy', multiplier: 8 }],
  },
  camera: { width: 300, height: 300, format: 'image/png' },
  comfyui: {
    activeProfile: 'local',
    outputPrefix: 'photo_anime',
    profiles: {
      local: {
        baseUrl: 'http://127.0.0.1:8188',
        templatePath: 'assets/ComfyUI_KidsPG_2026_local.json',
        generation: { denoise: 0.6, steps: 13, cannyLowThreshold: 0.25, cannyHighThreshold: 0.6 },
      },
    },
  },
});

test('ゲーム設定を更新し、注釈キーと他のセクションを残す', () => {
  const { config, errors } = applyConfigPatch(baseConfig(), {
    game: { timeLimitSeconds: 90, maxStages: 6 },
  });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(config.game.timeLimitSeconds, 90);
  assert.strictEqual(config.game.maxStages, 6);
  // 触っていない項目と注釈は残る
  assert.strictEqual(config.game.levelUpScoreInterval, 60);
  assert.strictEqual(config._comment_game_settings, '注釈（保存で消えてはいけない）');
  assert.strictEqual(config.camera.format, 'image/png');
});

test('元のオブジェクトを書き換えない', () => {
  const current = baseConfig();
  applyConfigPatch(current, { game: { timeLimitSeconds: 90 } });
  assert.strictEqual(current.game.timeLimitSeconds, 120);
});

test('範囲外・非数値・非整数を弾き、書き込み値を作らない', () => {
  for (const value of [5, 601, 'abc', 90.5, null]) {
    const { errors } = applyConfigPatch(baseConfig(), { game: { timeLimitSeconds: value } });
    assert.ok(errors.length > 0, `弾けていない: ${value}`);
  }
});

test('ランク閾値は7個・降順でなければ弾く', () => {
  const six = applyConfigPatch(baseConfig(), { game: { rankThresholds: [6, 5, 4, 3, 2, 1] } });
  assert.ok(six.errors.some((e) => e.includes('7 個')));

  const ascending = applyConfigPatch(baseConfig(), {
    game: { rankThresholds: [1, 2, 3, 4, 5, 6, 7] },
  });
  assert.ok(ascending.errors.some((e) => e.includes('高い順')));

  const ok = applyConfigPatch(baseConfig(), {
    game: { rankThresholds: [700, 600, 500, 400, 300, 200, 100] },
  });
  assert.deepStrictEqual(ok.errors, []);
  assert.deepStrictEqual(ok.config.game.rankThresholds, [700, 600, 500, 400, 300, 200, 100]);
});

test('ステージ進行は1件でも不正なら全体を書き換えない', () => {
  const { config, errors } = applyConfigPatch(baseConfig(), {
    game: {
      stageProgression: [
        { size: 4, difficulty: 'easy', multiplier: 8 },
        { size: 4, difficulty: 'とてもむずかしい', multiplier: 8 },
      ],
    },
  });
  assert.ok(errors.some((e) => e.includes('難易度')));
  assert.deepStrictEqual(config.game.stageProgression, [
    { size: 4, difficulty: 'veasy', multiplier: 8 },
  ]);
});

test('生成パラメータを更新する', () => {
  const { config, errors } = applyConfigPatch(baseConfig(), {
    comfyuiGeneration: {
      local: { denoise: 0.55, steps: 15, positivePrompt: 'anime, smiling child' },
    },
  });
  assert.deepStrictEqual(errors, []);
  const generation = config.comfyui.profiles.local.generation;
  assert.strictEqual(generation.denoise, 0.55);
  assert.strictEqual(generation.steps, 15);
  assert.strictEqual(generation.positivePrompt, 'anime, smiling child');
  // 送っていない項目は残る
  assert.strictEqual(generation.cannyLowThreshold, 0.25);
});

test('存在しないプロファイルへの保存を拒否する', () => {
  const { errors } = applyConfigPatch(baseConfig(), {
    comfyuiGeneration: { server: { denoise: 0.5 } },
  });
  assert.ok(errors.some((e) => e.includes('server')));
});

test('プロンプトを空にはできない（安全側の指定が消えるため）', () => {
  const { errors } = applyConfigPatch(baseConfig(), {
    comfyuiGeneration: { local: { negativePrompt: '   ' } },
  });
  assert.ok(errors.some((e) => e.includes('空にはできません')));
});

test('生成パラメータの範囲外を弾く', () => {
  const { errors } = applyConfigPatch(baseConfig(), {
    comfyuiGeneration: { local: { denoise: 1.5 } },
  });
  assert.ok(errors.some((e) => e.includes('denoise')));
});

test('保存後の値の組み合わせで Canny / ControlNet の前後関係を検査する', () => {
  // 既存が low=0.25 / high=0.6 のところへ low だけ 0.8 を入れると逆転する
  const canny = applyConfigPatch(baseConfig(), {
    comfyuiGeneration: { local: { cannyLowThreshold: 0.8 } },
  });
  assert.ok(canny.errors.some((e) => e.includes('Canny')));

  const controlnet = applyConfigPatch(baseConfig(), {
    comfyuiGeneration: { local: { controlnetStartPercent: 0.9, controlnetEndPercent: 0.5 } },
  });
  assert.ok(controlnet.errors.some((e) => e.includes('ControlNet')));
});

test('未知のキーは無視して書き込まない', () => {
  const { config, errors } = applyConfigPatch(baseConfig(), {
    game: { timeLimitSeconds: 100 },
    comfyuiGeneration: { local: { denoise: 0.5, ckpt_name: 'なにか.safetensors' } },
  });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(config.comfyui.profiles.local.generation.ckpt_name, undefined);
  assert.strictEqual(config.game.timeLimitSeconds, 100);
});

test('__proto__ をプロファイル名にした汚染を拒否する', () => {
  // isRecord(profiles['__proto__']) は Object.prototype を返して true になるため、
  // own プロパティで確かめないと「存在するプロファイル」として通ってしまう。
  // 通すと Object.prototype.generation が生え、config.json は見た目上変わらないまま
  // main プロセス内の全オブジェクトがその値を持つ（追跡不能な汚染になる）
  const patch = JSON.parse('{"comfyuiGeneration": {"__proto__": {"steps": 60}}}');
  const { errors } = applyConfigPatch(baseConfig(), patch);
  assert.ok(errors.length > 0, '拒否されていません');
  assert.strictEqual({}.generation, undefined, 'Object.prototype が汚染されました');
  assert.strictEqual({}.steps, undefined, 'Object.prototype が汚染されました');
});

test('constructor / prototype も拒否する', () => {
  for (const name of ['constructor', 'prototype']) {
    const { errors } = applyConfigPatch(baseConfig(), { comfyuiGeneration: { [name]: { steps: 8 } } });
    assert.ok(errors.length > 0, name + ' が拒否されていません');
  }
});

test('パッチに無いセクションは触らない', () => {
  const { config, errors } = applyConfigPatch(baseConfig(), {});
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(config, baseConfig());
});
