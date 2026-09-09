#!/usr/bin/env node
/**
 * 「その子の記録が消える」「静かに劣化する」経路の単体テスト。
 *
 *   npm run build && node --test tools/test-play-integrity.cjs
 *
 * ■ なぜ要るか（2026-09-09 の敵対的レビュー）
 * 当日いちばんまずいのは**気づけない失敗**で、実際に次の経路が見つかった。
 *   1. `result.json`（後日のカード公開の正本）を最初に作る書き込みだけが
 *      直書きで、Windows の共有違反1回でその子の記録が消えていた
 *   2. preload が読めていないと、写真も結果も「保存成功」を返していた
 *   3. プレースホルダ版カードの合成が失敗した回は、あとから届いた
 *      AI 完了が保留のまま**誰にも消化されず**、カードが1枚も作られなかった
 *   4. ステージ構成や倍率を設定画面から変えても、
 *      「クリア面数＝ランク＝カード背景」の対応の破れを誰も言わなかった
 *
 * いずれも画面には何も出ない壊れ方なので、ここで固定する。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'main', 'main', 'services');
if (!fs.existsSync(DIST)) {
  throw new Error(`dist が見つかりません。先に \`npm run build\` を実行してください: ${DIST}`);
}

// ---------------------------------------------------------------- 1. 正本の書き込み

const { writeJsonAtomic } = require(path.join(DIST, 'write-json-atomic.js'));

test('result.json の書き込みは一時ファイル＋rename を通る（直書きしない）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kidspg-atomic-'));
  const target = path.join(dir, 'result.json');
  await writeJsonAtomic(target, { nickname: 'てすと', score: 123 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf-8')), {
    nickname: 'てすと',
    score: 123,
  });
  // 一時ファイルを残さない（当日 results/ が散らかると点検が読みづらい）
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepStrictEqual(leftovers, [], '一時ファイルが残っています: ' + leftovers.join(', '));
});

test('書き込めない場所なら例外にする（成功と誤認させない）', async () => {
  const missing = path.join(os.tmpdir(), 'kidspg-nonexistent-' + Date.now(), 'result.json');
  await assert.rejects(() => writeJsonAtomic(missing, { a: 1 }));
});

test('save-json は正本の書き込みに writeJsonAtomic を使う', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.ts'), 'utf-8');
  const handler = src.slice(src.indexOf("ipcMain.handle('save-json'"));
  const body = handler.slice(0, handler.indexOf("ipcMain.handle('", 10));
  assert.match(body, /writeJsonAtomic\(filePath, jsonData\)/, '直書きに戻っています');
  assert.ok(
    !/fs\.writeFile\(filePath, JSON\.stringify\(jsonData/.test(body),
    'まだ直書きの経路が残っています'
  );
  // 失敗を黙って通さない（帯に出す）
  assert.match(body, /notifyStaff/, '失敗をスタッフへ知らせていません');
});

// ---------------------------------------------------------------- 2. 偽の成功

test('preload が無いとき、保存フックは成功を返さない', () => {
  for (const rel of ['src/renderer/hooks/useSavePhoto.ts', 'src/renderer/hooks/useSaveGameResult.ts']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    // 🔴 以前は「ブラウザ環境の都合」で success を返していた。本番でも
    //    preload の読み込みに失敗すればこの経路に入り、全員の記録が消える
    assert.ok(
      !/Simulate success for browser environment/.test(src),
      rel + ' に偽の成功が残っています'
    );
    assert.ok(
      !/return \{ success: true, dirPath: 'browser-dummy-path' \}/.test(src),
      rel + ' が偽の dirPath を返しています'
    );
    assert.match(src, /success: false/, rel + ' が失敗を返していません');
  }
});

// ---------------------------------------------------------------- 3. カードの取りこぼし

test('プレースホルダ版が無くてもAI完了から本カードを作る', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.ts'), 'utf-8');
  const fn = src.slice(src.indexOf('private async handleComfyUICompletion'));
  const body = fn.slice(0, fn.indexOf('\r\n  }'));
  // 🔴 'dummy_completed' 以外を全部保留にすると、ダミーが失敗した回は
  //    保留のまま誰も消化せず、カードが1枚も作られない
  assert.ok(
    !/currentState !== 'dummy_completed'/.test(body),
    "dummy_completed 以外を全部保留にしています（カードが1枚も作られない回が出ます）"
  );
  assert.match(body, /currentState === 'dummy_inprogress'/, '保留の条件が合成中に絞られていません');
});

test('AI変換の投入は先渡しの失敗で止めない', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.ts'), 'utf-8');
  const idx = src.indexOf('preUploadImage(base64Data, dateTime)');
  assert.ok(idx > 0, 'プリアップロードの呼び出しが見つかりません');
  // 先渡しと投入が別の try に分かれていること
  const around = src.slice(idx - 400, idx + 900);
  const tries = (around.match(/try \{/g) || []).length;
  assert.ok(tries >= 2, '先渡しと投入が同じ try に入っています（1回の失敗で投入されません）');
  assert.match(around, /transformImage/, '投入の呼び出しが見つかりません');
});

// ---------------------------------------------------------------- 4. 設定変更の警告

const { collectBalanceWarnings } = require(path.join(DIST, 'balance-warnings.js'));

const baseGame = {
  game: {
    partialScoreRate: 0.35,
    repeatLastStage: true,
    rankThresholds: [1504, 1216, 928, 640, 352, 176, 88],
    stageProgression: [
      { size: 4, difficulty: 'veasy', multiplier: 8 },
      { size: 4, difficulty: 'easy', multiplier: 8 },
    ],
  },
};

test('変更が無ければ警告を出さない（毎回出ると読み飛ばされる）', () => {
  assert.deepStrictEqual(collectBalanceWarnings(baseGame, baseGame), []);
});

test('倍率を変えたら「対応が崩れているかもしれない」と言う', () => {
  const after = JSON.parse(JSON.stringify(baseGame));
  after.game.stageProgression[1].multiplier = 10;
  const w = collectBalanceWarnings(baseGame, after);
  assert.ok(w.length >= 1, '警告が出ていません');
  assert.match(w.join('\n'), /ランク/);
  // 当日その場で何をすればよいかを言う
  assert.match(w.join('\n'), /measure-stages/);
});

test('部分点率とランク閾値の変更も拾う', () => {
  const a = JSON.parse(JSON.stringify(baseGame));
  a.game.partialScoreRate = 0.5;
  assert.ok(collectBalanceWarnings(baseGame, a).length >= 1, '部分点率を拾っていません');

  const b = JSON.parse(JSON.stringify(baseGame));
  b.game.rankThresholds = [1504, 1216, 928, 640, 352, 176, 80];
  assert.ok(collectBalanceWarnings(baseGame, b).length >= 1, 'ランク閾値を拾っていません');
});

test('ランク閾値が降順でなければその場で指摘する', () => {
  const after = JSON.parse(JSON.stringify(baseGame));
  after.game.rankThresholds = [1504, 1216, 928, 640, 352, 88, 176];
  const w = collectBalanceWarnings(baseGame, after);
  assert.match(w.join('\n'), /高い順に並んでいません/);
});

test('盤サイズが大きすぎるときは固まることを言う', () => {
  const after = JSON.parse(JSON.stringify(baseGame));
  after.game.stageProgression[0].size = 8;
  const w = collectBalanceWarnings(baseGame, after);
  assert.match(w.join('\n'), /盤サイズ 8 は大きすぎます/);
  // 制限時間が進み続けることまで書く（当日の判断に必要）
  assert.match(w.join('\n'), /制限時間/);
});

// ---------------------------------------------------------------- 5. 出口と誤操作

test('ゲームが始まる前は Esc で戻れる（出口が1つも無くならない）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pages', 'GamePage.tsx'), 'utf-8');
  // App は GAME 画面の Esc を GamePage へ委譲するが、委譲先の配線は
  // ゲームエンジンが出来てからなので、初期化に失敗すると出口が消える
  assert.match(src, /window\.addEventListener\('keydown'/, '起動前の Esc を受けていません');
  assert.match(src, /if \(!isLoading && !error\) return;/, '受ける範囲が起動前に絞られていません');
});

test('config が読めないときは「読み込み中」で止めずに理由を出す', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pages', 'GamePage.tsx'), 'utf-8');
  assert.match(src, /!configLoading && !config/, 'config が null のままの場合を分けていません');
  assert.match(src, /設定（config\.json）を読み込めませんでした/, '理由を出していません');
});

test('画面を進めるキーはリピートを無視する', () => {
  for (const rel of [
    'src/renderer/pages/CameraPage.tsx',
    'src/renderer/pages/ResultPage.tsx',
    'src/renderer/pages/TopPage.tsx',
  ]) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    assert.match(src, /event\.repeat/, rel + ' がキーリピートを無視していません');
  }
});

test('記録の保存に失敗したら自動でトップへ戻さない', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pages', 'ResultPage.tsx'), 'utf-8');
  // 🔴 以前は alert を連打しながら15秒後に TOP へ戻り、記録は残らなかった
  assert.ok(!/alert\(`結果の保存/.test(src), 'alert に戻っています');
  assert.match(src, /if \(saveFailure\) return;/, '失敗中も自動復帰しています');
  assert.match(src, /SAVE_MAX_ATTEMPTS/, '再試行の上限がありません');
});

// ---------------------------------------------------------------- 6. 稼働中の障害を見せる

test('稼働中の ComfyUI 障害はスタッフ向けの帯へ流す', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src', 'main', 'services', 'comfyui-service.ts'),
    'utf-8'
  );
  // comfyui-error / comfyui-job-error はテスト画面しか購読していなかった
  assert.match(src, /notifyStaff/, '帯へ流していません');
  assert.match(src, /startup-warning/, '帯が購読しているチャンネルへ送っていません');
  const exitHandler = src.slice(src.indexOf("this.worker.on('exit'"));
  assert.match(
    exitHandler.slice(0, 1500),
    /notifyStaff/,
    'ワーカー停止をスタッフへ知らせていません'
  );
});

test('保持件数は設定の読み直しで反映される', () => {
  const rm = fs.readFileSync(
    path.join(ROOT, 'src', 'main', 'services', 'results-manager.ts'),
    'utf-8'
  );
  assert.match(rm, /updateConfig/, '設定を差し替える入口がありません');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.ts'), 'utf-8');
  const calls = (main.match(/resultsManager\?\.updateConfig/g) || []).length;
  assert.ok(calls >= 2, 'reload-config と save-config の両方で反映していません（' + calls + ' か所）');
});
