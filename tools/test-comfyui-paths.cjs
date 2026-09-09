#!/usr/bin/env node
/**
 * ComfyUI の物理パス（config.json の comfyui...paths）と、起動コマンドの単体テスト
 *
 *   npm run build && node --test tools/test-comfyui-paths.cjs
 *
 * ■ 何を守っているか
 * ここは**アプリの外にあるものを名指しする**唯一の設定。間違っていても生成そのものは
 * HTTP で通ってしまうので、壊れたことに当日まで気づけない。特に次の2つ:
 *
 *   ・相対パスを黙って通すと、Electron の作業フォルダを基準に解決されて
 *     見当違いの場所を掘る（当日「起動ボタンが何も起こさない」になる）
 *   ・root だけプロファイル側で差し替えて input を共通側から拾うと、
 *     **別の版フォルダの input** を見にいく組み合わせができる
 *
 * 起動コマンドのほうは「窓が開いたままになること」を文字列として固定する。
 * -NoExit が落ちると、失敗の理由が一瞬で消えてスタッフに何も残らない。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_MODULE = path.join(ROOT, 'dist', 'main', 'main', 'services', 'comfyui-config.js');
const LAUNCHER_MODULE = path.join(ROOT, 'dist', 'main', 'main', 'services', 'comfyui-launcher.js');
for (const modulePath of [CONFIG_MODULE, LAUNCHER_MODULE]) {
  if (!fs.existsSync(modulePath)) {
    throw new Error(`dist が見つかりません。先に \`npm run build\` を実行してください: ${modulePath}`);
  }
}
const { resolveComfyUIPaths, resolveComfyUIConfig } = require(CONFIG_MODULE);
const { buildLaunchCommand } = require(LAUNCHER_MODULE);

const ABS = 'C:\\WORK\\AI\\ComfyUI_20260902_0.34.0\\ComfyUI';

test('paths が無ければ undefined を返し、警告も出さない（サーバー側プロファイルの正常な姿）', () => {
  const result = resolveComfyUIPaths(undefined, 'comfyui');
  assert.strictEqual(result.paths, undefined);
  assert.deepStrictEqual(result.warnings, []);
});

test('input / output / startBat を省略すると root の下から埋まる', () => {
  const { paths, warnings } = resolveComfyUIPaths({ root: ABS }, 'comfyui');
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(paths.root, path.normalize(ABS));
  assert.strictEqual(paths.input, path.resolve(ABS, 'input'));
  assert.strictEqual(paths.output, path.resolve(ABS, 'output'));
  // startBat は既定を作らない。存在しないバッチを指すより「起動できない」が分かるほうがよい
  assert.strictEqual(paths.startBat, undefined);
});

test('startBat は root からの相対で書ける（版フォルダの差し替えを root の1行で済ませるため）', () => {
  const { paths } = resolveComfyUIPaths({ root: ABS, startBat: 'start-comfyui.bat' }, 'comfyui');
  assert.strictEqual(paths.startBat, path.resolve(ABS, 'start-comfyui.bat'));
});

test('input / output を絶対パスで書いた場合はそのまま使う', () => {
  const { paths } = resolveComfyUIPaths(
    { root: ABS, input: 'D:\\comfy-input', output: 'D:\\comfy-output' },
    'comfyui'
  );
  assert.strictEqual(paths.input, path.normalize('D:\\comfy-input'));
  assert.strictEqual(paths.output, path.normalize('D:\\comfy-output'));
});

test('root が相対パスなら使わず、理由を警告する', () => {
  const { paths, warnings } = resolveComfyUIPaths({ root: '..\\ComfyUI' }, 'comfyui');
  assert.strictEqual(paths, undefined);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /絶対パス/);
});

test('root が無いまま他の項目だけ書いてあれば、使わず警告する', () => {
  const { paths, warnings } = resolveComfyUIPaths({ startBat: 'start-comfyui.bat' }, 'comfyui');
  assert.strictEqual(paths, undefined);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /root/);
});

test('文字列でない値・空文字は無視して警告する', () => {
  const { paths, warnings } = resolveComfyUIPaths({ root: ABS, input: '   ' }, 'comfyui');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /paths\.input/);
  // 無視した項目は既定（root の下）で埋まる。黙って空文字を渡さない
  assert.strictEqual(paths.input, path.resolve(ABS, 'input'));
});

const baseProfileConfig = (profilePaths, commonPaths) => ({
  activeProfile: 'local',
  outputPrefix: 'photo_anime',
  paths: commonPaths,
  profiles: {
    local: {
      baseUrl: 'http://127.0.0.1:8188',
      templatePath: 'assets/ComfyUI_KidsPG_2026_local.json',
      paths: profilePaths,
    },
    server: {
      baseUrl: 'http://192.168.1.10:8188',
      templatePath: 'assets/ComfyUI_KidsPG_2026_01.json',
    },
  },
});

test('プロファイル側に paths があれば、共通側と混ぜず丸ごとそちらを使う', () => {
  const resolved = resolveComfyUIConfig(
    baseProfileConfig({ root: 'C:\\WORK\\AI\\ComfyUI_NEW\\ComfyUI' }, { root: ABS, input: 'D:\\old-input' })
  );
  assert.strictEqual(resolved.paths.root, path.normalize('C:\\WORK\\AI\\ComfyUI_NEW\\ComfyUI'));
  // 共通側の input（別の版フォルダ）を引き継がないこと。ここが混ざると
  // 「新しい版で動かしているのに古い版の input を見る」が起きる
  assert.strictEqual(resolved.paths.input, path.resolve('C:\\WORK\\AI\\ComfyUI_NEW\\ComfyUI', 'input'));
});

test('プロファイル側に paths が無ければ共通側を使う', () => {
  const resolved = resolveComfyUIConfig(baseProfileConfig(undefined, { root: ABS }));
  assert.strictEqual(resolved.paths.root, path.normalize(ABS));
});

test('どこにも paths が無ければ undefined（生成は HTTP だけで通るのでエラーにしない）', () => {
  const resolved = resolveComfyUIConfig(baseProfileConfig(undefined, undefined));
  assert.strictEqual(resolved.paths, undefined);
  assert.deepStrictEqual(resolved.warnings, []);
});

test('現行の config.json は local / local_light に絶対パスを持ち、server には持たない', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  for (const name of ['local', 'local_light']) {
    const resolved = resolveComfyUIConfig({ ...config.comfyui, activeProfile: name });
    assert.ok(resolved.paths, `${name} に paths がありません`);
    assert.ok(path.win32.isAbsolute(resolved.paths.root), `${name}.paths.root が絶対パスではありません`);
    assert.ok(resolved.paths.startBat, `${name}.paths.startBat がありません`);
    // 物理パスの書き間違いは警告として出る。ここが空でないと当日気づけない形で通る
    assert.deepStrictEqual(
      resolved.warnings.filter((w) => w.includes('paths')),
      [],
      `${name} の paths に警告が出ています`
    );
  }
  const server = resolveComfyUIConfig({ ...config.comfyui, activeProfile: 'server' });
  assert.strictEqual(server.paths, undefined, 'server は別の機体なので paths を持たない');
});

test('起動コマンドは powershell を直に起動し、終わっても窓を閉じない（-NoExit）', () => {
  const bat = path.join(ABS, 'start-comfyui.bat');
  const { command, args, cwd } = buildLaunchCommand(bat, ABS);
  // cmd.exe /c start を挟む形は Node の引数クォートでは通らなかった（2026-09-08 実測）
  assert.strictEqual(command, 'powershell.exe');
  assert.strictEqual(cwd, ABS);
  assert.strictEqual(args[0], '-NoExit', '-NoExit が無いと失敗の理由が一瞬で消える');
  assert.ok(args.includes('-Command'));
  assert.strictEqual(args[args.length - 1], `& '${bat}'`);
});

test('パスに単一引用符が入っていても PowerShell のリテラルとして壊れない', () => {
  const bat = "C:\\WORK\\it's here\\start-comfyui.bat";
  const { args } = buildLaunchCommand(bat, 'C:\\WORK');
  assert.strictEqual(args[args.length - 1], "& 'C:\\WORK\\it''s here\\start-comfyui.bat'");
});
