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
  // 🔴 '\r\n  }' で切ると、LF でチェックアウトされた環境では indexOf が -1 を返し、
  //    slice(0, -1) ＝ ファイルほぼ全体になって「本体の検査」が黙って
  //    「ファイル全体検索」へ退化する。改行コードに依存しない形で切る。
  const bodyEnd = fn.search(/\r?\n {2}\}/);
  assert.ok(bodyEnd > 0, 'handleComfyUICompletion の本体を切り出せません');
  const body = fn.slice(0, bodyEnd);
  // 🔴 'dummy_completed' 以外を全部保留にすると、ダミーが失敗した回は
  //    保留のまま誰も消化せず、カードが1枚も作られない
  assert.ok(
    !/currentState !== 'dummy_completed'/.test(body),
    "dummy_completed 以外を全部保留にしています（カードが1枚も作られない回が出ます）"
  );
  // 🔴 「dummy_inprogress を含む」だけでは足りない。元のバグは
  //    `currentState === undefined || currentState === 'dummy_inprogress'`
  //    と書いても成立してしまう（実測: 変異を入れても26件すべて緑だった）。
  //    保留の条件式そのものを取り出して、**それが合成中ちょうど1つ**であることを見る。
  // 🔴 保留する枝は**全部**見る。最初の1つだけを見ていたので、
  //    同じバグを「あとの行」に足すと素通りしていた（実測で確認）。
  const sets = [...body.matchAll(/this\.pendingAICompletions\.set/g)].map((m) => m.index);
  assert.ok(sets.length > 0, '保留する枝（pendingAICompletions.set）が見つかりません');
  for (const at of sets) {
    const ifs = [...body.slice(0, at).matchAll(/if \((.*?)\)\s*\{/gs)];
    assert.ok(ifs.length > 0, '保留の分岐が見つかりません');
    const cond = ifs[ifs.length - 1][1].trim().replace(/["']/g, "'");
    assert.strictEqual(
      cond,
      "currentState === 'dummy_inprogress'",
      '保留の条件が「合成中ちょうど1つ」ではありません: ' + cond
    );
    // undefined（プレースホルダ版すら作れなかった回）は**保留にせず進める**
    assert.ok(
      !/undefined/.test(cond) && !/!currentState/.test(cond),
      'プレースホルダ版が無い回を保留にしています（誰も消化せずカードが1枚も作られません）'
    );
  }
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
  // 🔴 文字列が「どこかにある」だけでは、条件を反転しても・受けて何もしなくても通る
  //    （実測: どちらの変異でも26件すべて緑だった）。**語順ごと**縛る。
  //    ここは初期化に失敗した画面から抜ける唯一の出口なので、消えると詰む。
  //    語順の決め打ちは、引数名を変えただけ・等価な書き方に直しただけで落ちる。
  //    「keydown を受ける本体に handleEscapeKey が出る」＋「その中身が TOP へ戻す」を見る。
  const listenAt = src.indexOf("window.addEventListener('keydown'");
  assert.ok(listenAt > 0, '起動前の Esc を受けていません');
  const handler = src.slice(Math.max(0, listenAt - 900), listenAt + 200);
  assert.match(handler, /Escape/, 'Esc を見ていません');
  assert.match(handler, /handleEscapeKey\(\)/, 'Esc を受けても戻る処理を呼んでいません');
  // 🔴 呼んでいても中身が空なら出口は消える（実測: 中身を潰しても通っていた）。
  const hkAt = src.indexOf('const handleEscapeKey');
  assert.ok(hkAt > 0, 'handleEscapeKey の定義がありません');
  const hkBody = src.slice(hkAt, src.indexOf('}, [', hkAt));
  // 🔴 文としてそのまま呼んでいることまで見る。`false && setCurrentScreen('TOP')`
  //    のように潰しても、文字列があるだけの検査では通っていた（実測）。
  assert.match(
    hkBody,
    /(^|[\r\n;{]\s*)setCurrentScreen\('TOP'\);/,
    'Esc で TOP へ戻していません（条件で潰されていませんか）'
  );
  assert.ok(!/if \(false/.test(hkBody), 'handleEscapeKey の本体が無効化されています');
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
    // 🔴 `event.repeat` があるかだけだと、`if (!event.repeat) return;`（意味が真逆）
    //    でも通る（実測: 3ファイルとも反転して26件すべて緑だった）。
    assert.match(
      src,
      /if \(event\.repeat\)\s*(\{\s*)?return;/,
      rel + ' がキーリピートを無視していません（条件が反転している可能性）'
    );
    assert.ok(
      !/if \(!event\.repeat\)\s*(\{\s*)?return;/.test(src),
      rel + ' がリピートのときだけ進めています（条件が反転しています）'
    );
  }
});

test('記録の保存に失敗したら自動でトップへ戻さない', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pages', 'ResultPage.tsx'), 'utf-8');
  // 🔴 以前は alert を連打しながら15秒後に TOP へ戻り、記録は残らなかった
  assert.ok(!/alert\(`結果の保存/.test(src), 'alert に戻っています');
  assert.match(src, /SAVE_MAX_ATTEMPTS/, '再試行の上限がありません');
  // 🔴 ファイル全体に対する検索だと、**呼ばれない別の関数**に1行置くだけで通る
  //    （実測で確認）。自動復帰の effect を切り出して、その**中に**あることを見る。
  const at = src.indexOf('// 🔴 保存に失敗しているあいだは自動で TOP へ戻さない');
  assert.ok(at > 0, '自動復帰の effect が見つかりません');
  const eff = src.slice(at, src.indexOf('}, [', at));
  assert.match(eff, /if \(saveFailure\) return;/, '失敗中も自動復帰しています');
  assert.match(eff, /setTimeout|handleRestart/, '自動復帰の effect ではない箇所を見ています');
});

// ---------------------------------------------------------------- 6. 稼働中の障害を見せる

test('稼働中の ComfyUI 障害はスタッフ向けの帯へ流す', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src', 'main', 'services', 'comfyui-service.ts'),
    'utf-8'
  );
  // comfyui-error / comfyui-job-error はテスト画面しか購読していなかった
  assert.match(src, /notifyStaff/, '帯へ流していません');
  // 🔴 名前とチャンネル名が「ファイルのどこかにある」だけだと、本体を
  //    `if (false && ...)` で潰しても通る（実測で確認）。本体を切り出して見る。
  const nsAt = src.indexOf('private notifyStaff(');
  assert.ok(nsAt > 0, 'notifyStaff の定義が見つかりません');
  const nsEnd = src.slice(nsAt).search(/\r?\n {2}\}/);
  assert.ok(nsEnd > 0, 'notifyStaff の本体を切り出せません');
  const nsBody = src.slice(nsAt, nsAt + nsEnd);
  assert.match(
    nsBody,
    /webContents\.send\(\s*'startup-warning'/,
    'notifyStaff が帯（startup-warning）へ送っていません'
  );
  assert.ok(!/if \(false/.test(nsBody), 'notifyStaff の本体が無効化されています');
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
  // 🔴 メソッド名があるかだけだと、本体の先頭に return; を置いても通る（実測）。
  const uc = rm.slice(rm.search(/\bupdateConfig\s*\(/));
  const ucBody = uc.slice(uc.indexOf('{'), uc.indexOf('\n  }'));
  assert.ok(ucBody.length > 0, '設定を差し替える入口がありません');
  assert.match(ucBody, /this\.config\s*=/, 'updateConfig が設定を差し替えていません');
  assert.ok(!/^\s*\{\s*return;/.test(ucBody), 'updateConfig の本体が潰されています');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.ts'), 'utf-8');
  const calls = (main.match(/resultsManager\?\.updateConfig/g) || []).length;
  assert.ok(calls >= 2, 'reload-config と save-config の両方で反映していません（' + calls + ' か所）');
});
// ----------------------------------------------------------------
// 7. 携帯版 ImageMagick が自分の部品を見つけられるか
//
// 🔴 当日PCで実測（2026-09-10）: インストールしていない機体では
//    コーダー DLL の置き場をレジストリから引けず、
//      RegistryKeyLookupFailed `CoderModulesPath'
//      no decode delegate for this image format `...bg-card-rank-05-veteran.png'
//    となって**記念カードが1枚も作られなかった**。画像生成は成功していたのに
//    ランキングは「じゅんび中」のままだった。
//    さらに点検が `magick -version` だったため**この状態でも通り**、
//    起動バッチは「★★★ 準備完了 ★★★」と表示していた。
// ----------------------------------------------------------------

const { resolveMagick, applyMagickEnvironment, MAGICK_PROBE_ARGS } = require(
  path.join(DIST, 'magick-path.js')
);

test('点検の引数は -version ではない（コーダーを読まないので壊れていても通る）', () => {
  assert.ok(
    !MAGICK_PROBE_ARGS.includes('-version'),
    '-version で確かめています（PNG を1枚も扱えない状態を見逃します）'
  );
  // 実際に PNG を書かせること
  assert.ok(
    MAGICK_PROBE_ARGS.some((a) => String(a).includes('PNG:')),
    'PNG を書かせていません'
  );
});

test('携帯版なら コーダー／フィルタ／設定の置き場を環境変数へ入れる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kidspg-magick-'));
  const home = path.join(dir, 'bin', 'ImageMagick');
  fs.mkdirSync(path.join(home, 'modules', 'coders'), { recursive: true });
  fs.mkdirSync(path.join(home, 'modules', 'filters'), { recursive: true });
  fs.writeFileSync(path.join(home, 'colors.xml'), '<x/>');
  fs.writeFileSync(path.join(home, 'magick.exe'), 'x');

  const saved = { ...process.env };
  for (const k of [
    'KIDSPG_MAGICK',
    'MAGICK_CODER_MODULE_PATH',
    'MAGICK_FILTER_MODULE_PATH',
    'MAGICK_CONFIGURE_PATH',
    'MAGICK_HOME',
  ]) {
    delete process.env[k];
  }
  try {
    const resolution = resolveMagick([dir]);
    assert.strictEqual(resolution.from, 'portable', '携帯版として解決していません');
    assert.strictEqual(resolution.home, home, 'home がずれています');

    applyMagickEnvironment(resolution);
    assert.strictEqual(process.env.MAGICK_CODER_MODULE_PATH, path.join(home, 'modules', 'coders'));
    assert.strictEqual(process.env.MAGICK_FILTER_MODULE_PATH, path.join(home, 'modules', 'filters'));
    assert.strictEqual(process.env.MAGICK_CONFIGURE_PATH, home);
    assert.strictEqual(process.env.MAGICK_HOME, home);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PATH 任せのときは環境変数を触らない（開発機の設定を壊さない）', () => {
  const saved = process.env.MAGICK_CODER_MODULE_PATH;
  delete process.env.MAGICK_CODER_MODULE_PATH;
  const savedEnv = process.env.KIDSPG_MAGICK;
  delete process.env.KIDSPG_MAGICK;
  try {
    const resolution = resolveMagick([path.join(os.tmpdir(), 'kidspg-nowhere-' + Date.now())]);
    assert.strictEqual(resolution.from, 'PATH');
    assert.strictEqual(resolution.home, null);
    assert.deepStrictEqual(applyMagickEnvironment(resolution), []);
    assert.strictEqual(process.env.MAGICK_CODER_MODULE_PATH, undefined);
  } finally {
    if (saved !== undefined) process.env.MAGICK_CODER_MODULE_PATH = saved;
    if (savedEnv !== undefined) process.env.KIDSPG_MAGICK = savedEnv;
  }
});

test('起動時の点検は実際に PNG を書かせる', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.ts'), 'utf-8');
  const fn = src.slice(src.indexOf('private async checkImageMagick'));
  // 🔴 '\r\n  }' で切ると、LF でチェックアウトされた環境では indexOf が -1 を返し、
  //    slice(0, -1) ＝ ファイルほぼ全体になって「本体の検査」が黙って
  //    「ファイル全体検索」へ退化する。改行コードに依存しない形で切る。
  const bodyEnd = fn.search(/\r?\n {2}\}/);
  assert.ok(bodyEnd > 0, 'handleComfyUICompletion の本体を切り出せません');
  const body = fn.slice(0, bodyEnd);
  assert.match(body, /MAGICK_PROBE_ARGS/, '点検が PNG を書かせていません');
  assert.ok(!/\['-version'\]/.test(body), '-version で確かめています');
  // 点検の前に環境を整えること（順番が逆だと最初の1回が落ちる）
  const envAt = body.indexOf('applyMagickEnvironment');
  const probeAt = body.indexOf('MAGICK_PROBE_ARGS');
  assert.ok(envAt > 0 && envAt < probeAt, '環境を整える前に点検しています');
});

test('起動バッチと 0_セットアップ.bat も PNG を書かせ、その結果を見る', () => {
  for (const rel of ['start-kidspg.bat', 'tools/onsite/0_setup.bat']) {
    const bat = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    assert.match(bat, /-size 4x4 xc:white PNG:-/, rel + ' が PNG を書かせていません');
    assert.match(bat, /MAGICK_CODER_MODULE_PATH/, rel + ' がコーダーの置き場を教えていません');
    // 🔴 探査を書いているかだけでは足りない。**結果を見ているか**まで見る。
    //    実測: errorlevel の閾値を 1 → 99 にしても（＝失敗しても警告を出さない）
    //    すべて緑だった。それは実機で1度踏んだ「カードが作れないのに準備完了」そのもの。
    const lines = bat.split('\r\n');
    const i = lines.findIndex((l) => l.includes('-size 4x4 xc:white PNG:-'));
    assert.ok(i >= 0, rel + ' の探査行が見つかりません');
    const after = lines.slice(i + 1, i + 4).join('\n');
    assert.match(
      after,
      /if errorlevel 1\b|if not errorlevel 1\b/,
      rel + ' が PNG 探査の結果を見ていません（探査行の直後）'
    );
  }
});

test('救済ツールの事前確認も PNG を書かせる', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'test', 'memorial-card-recovery.ts'), 'utf-8');
  assert.match(src, /MAGICK_PROBE_ARGS/, '-version のままです');
  assert.match(src, /applyMagickEnvironment/, 'コーダーの置き場を教えていません');
});

test('生成にかかった秒数をログに残す（当日の人数計算に要る）', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src', 'main', 'workers', 'comfyui-worker.ts'),
    'utf-8'
  );
  assert.match(src, /生成完了 \$\{datetime\}: \$\{elapsedSec\} 秒/, '秒数を出していません');
});

test('記録に盤の種類（cube / plane）を残す', () => {
  // 🔴 後から復元できない。平面はランクの閾値が別（48/112/216/320/424）なので、
  //    記録に無いと「どちらの物差しのランクか」が永久に分からなくなる。
  const types = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'types', 'index.ts'), 'utf-8');
  const gr = types.slice(types.indexOf('export interface GameResult'));
  const body = gr.slice(0, gr.indexOf('\n}'));
  assert.match(body, /boardMode\?: BoardMode;/, 'GameResult に boardMode がありません');

  const page = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'pages', 'ResultPage.tsx'),
    'utf-8'
  );
  const lit = page.slice(page.indexOf('const gameResult: GameResult = {'));
  assert.match(
    lit.slice(0, lit.indexOf('};')),
    /^\s*boardMode,\s*$/m,
    'ResultPage が boardMode を書き込んでいません'
  );
});

test('ランキングの自動送りは、運営が押した1回目を握り潰さない', () => {
  // 🔴 F8 は setPaused(true) と step() を続けて呼ぶ。paused が変わると
  //    自動送り effect が張り直されるので、その cleanup で待機中のタイマーを
  //    消すと、step() が今しかけたページ送り（唯一の setCurrentPage）が死ぬ。
  //    自動送り中の最初の1回が必ず空振りしていた。
  const src = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'components', 'ranking', 'PaginatedScrollList.tsx'),
    'utf-8'
  );
  const at = src.indexOf('const interval = setInterval(() => step(1)');
  assert.ok(at > 0, '自動送りの setInterval が見つかりません');
  const eff = src.slice(at, src.indexOf('}, [pages.length, intervalSeconds, paused, step]);', at));
  assert.ok(
    !/clearTimeout/.test(eff),
    '自動送り effect の cleanup がまだタイマーを消しています'
  );
  assert.match(eff, /clearInterval\(interval\)/, 'interval を止めていません');

  // 片付け自体は残っていること（終日運転で待機中のタイマーを残さない）。
  // 🔴 整形（prettier）で改行位置が変わっただけで落ちないようにする。
  //    「依存配列が空の useEffect が返す関数の中で timersRef を片付ける」ことだけを見る。
  const unmountAt = src.search(/useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>/);
  assert.ok(unmountAt > 0, '画面を閉じるときの片付け（アンマウント専用 effect）がありません');
  const unmount = src.slice(unmountAt, unmountAt + 400);
  assert.match(unmount, /timersRef\.current/, '片付けが timersRef を見ていません');
  assert.match(unmount, /clearTimeout/, '片付けがタイマーを止めていません');
  assert.match(unmount, /\},\s*\[\]\s*,?\s*\)/, 'アンマウント時だけの片付けになっていません');
});
