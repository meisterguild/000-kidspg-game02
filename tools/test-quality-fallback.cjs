'use strict';

/**
 * 画質を落とした退避用プロファイルを守るテスト。
 *
 * 生成が間に合わないときの逃げ道として `local_light`（inputSize を落としたもの）を
 * 用意している。プロンプトはモデルに紐づくため共通層へ置けない取り決めがあり
 * （config.json の `_comment_generation`）、`local` の内容を**複製**している。
 *
 * 🔴 **複製なので、片方だけ直すと黙って食い違う。**
 * 例えばプロンプトを local だけ調整すると、当日 local_light へ切り替えた瞬間に
 * 絵柄が変わる。画面には何も出ないので気づけない。
 * ここで「違っていてよいのは inputSize だけ」を機械的に確かめる。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
const profiles = config.comfyui.profiles;

/** 違っていてよいキー。inputSize が退避の本体で、_comment は説明文 */
const ALLOWED_DIFF = new Set(['inputSize', '_comment']);

test('画質を落とした退避用プロファイルがある', () => {
  assert.ok(profiles, 'comfyui.profiles がありません');
  assert.ok(
    profiles.local_light,
    '退避用プロファイル local_light がありません。生成が間に合わないときの逃げ道です'
  );
});

test('退避用は本番と同じ接続先・同じワークフローを使う', () => {
  const base = profiles.local;
  const light = profiles.local_light;
  assert.strictEqual(light.baseUrl, base.baseUrl, 'baseUrl が local と違います');
  assert.strictEqual(
    light.templatePath,
    base.templatePath,
    'templatePath が local と違います。同じワークフローで解像度だけ変える想定です'
  );
});

test('退避用と本番の生成パラメータは inputSize 以外すべて同じ', () => {
  const base = profiles.local.generation;
  const light = profiles.local_light.generation;
  const keys = new Set([...Object.keys(base), ...Object.keys(light)]);

  const drifted = [];
  for (const key of keys) {
    if (ALLOWED_DIFF.has(key)) continue;
    if (JSON.stringify(base[key]) !== JSON.stringify(light[key])) drifted.push(key);
  }

  assert.deepStrictEqual(
    drifted,
    [],
    '退避用プロファイルが本番と食い違っています: ' +
      drifted.join(', ') +
      '。片方だけ直すと、切り替えた瞬間に絵が変わります。' +
      'local を直したら local_light にも同じ値を入れてください'
  );
});

test('退避用は本番より軽い（inputSize が小さい）', () => {
  const base = profiles.local.generation.inputSize;
  const light = profiles.local_light.generation.inputSize;
  assert.ok(
    typeof light === 'number' && typeof base === 'number',
    'inputSize が数値ではありません'
  );
  assert.ok(
    light < base,
    `退避用の inputSize (${light}) が本番 (${base}) より軽くなっていません`
  );
});

test('steps は下げられていない（LoRA が 8 を前提にしている）', () => {
  // Hyper-SD15-8steps-CFG-lora は 8 ステップ前提。下げると絵が崩れる。
  // 時間を詰めたいときに間違って触りやすいので、ここで止める。
  for (const name of ['local', 'local_light']) {
    assert.strictEqual(
      profiles[name].generation.steps,
      8,
      `${name} の steps が 8 ではありません。Hyper-SD の LoRA は 8 ステップ前提です`
    );
  }
});

test('使用中のプロファイルが実在する', () => {
  const active = config.comfyui.activeProfile;
  assert.ok(
    profiles[active],
    `activeProfile が ${active} ですが、そのプロファイルがありません`
  );
});
