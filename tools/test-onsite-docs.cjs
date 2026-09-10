#!/usr/bin/env node
/**
 * 当日手順書（docs/setup-onsite.md）が、実機の画面・実装と食い違っていないかを見る。
 *
 *   node --test tools/test-onsite-docs.cjs
 *
 * ■ なぜ要るか（2026-09-10 の敵対的レビュー）
 * 当日スタッフは CLI を叩けず、判断材料はこの手順書だけになる。実際に次が見つかった。
 *   1. 「生成が間に合わない → アプリを再起動」と書いてあったが、キューはメモリ上に
 *      しかなく、再起動すると**待っていた人数ぶんが全員プレースホルダで確定**する
 *      （再投入する経路はアプリに無い）
 *   2. 追記した閉場コマンドが、バックスラッシュを食われて
 *      `node` + 改行 + `ode.exe` に化けていた。打った瞬間に必ず失敗する
 *   3. 閉場の待ち条件を「内部キュー 0」と書いたが、内部キューは *まだ生成に入って
 *      いない* 待ちだけを数える。同時実行1件のこの構成では、いま作っている1枚が
 *      0 と表示され、**最後の1人のカードが必ず巻き添えで消える**
 *   4. 「`inputSize` を 320 に」と書いたが、画面に出るラベルは `入力解像度（正方形）`
 *
 * いずれも当日その場で気づけない（3 に至っては「正しく待ったつもり」になる）ので、
 * ここで固定する。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const readDoc = () => fs.readFileSync(path.join(ROOT, 'docs', 'setup-onsite.md'), 'utf-8');
const readSrc = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf-8');

test('手順書のコマンドが壊れていない（バックスラッシュを食われていない）', () => {
  const doc = readDoc();

  // 行の途中に裸の CR があってはいけない（CRLF の CR は行末にしか出ない）
  doc.split('\n').forEach((line, i) => {
    assert.ok(
      !line.replace(/\r$/, '').includes('\r'),
      `${i + 1} 行目の途中に CR があります（バックスラッシュを食われた跡）`
    );
  });

  // ops から叩かせるコマンドは node\node.exe tools\<名前>.cjs の形で揃っていること。
  // 化けると `node` の直後が改行になるので、この形に一致しなくなる。
  const calls = doc.match(/node[\\/]node\.exe[^`]*/g) || [];
  assert.ok(calls.length >= 3, 'ops のコマンドが見当たりません（壊れて検出できていない可能性）');
  for (const c of calls) {
    assert.match(
      c,
      /^node\\node\.exe (?:ops\\)?tools\\[a-z-]+\.cjs/,
      '壊れたコマンドがあります: ' + JSON.stringify(c)
    );
  }
});

test('閉場の待ち条件は「アプリ内アクティブ」（内部キューは生成中の1枚を数えない）', () => {
  const worker = readSrc('src', 'main', 'workers', 'comfyui-worker.ts');
  // 前提: 内部キュー = jobQueue.length で、生成に入った時点で shift() で抜ける
  assert.match(worker, /internalQueueLength: this\.jobQueue\.length/, '前提が変わっています');
  assert.match(worker, /this\.jobQueue\.shift\(\)/, 'jobQueue から抜く実装が変わっています');

  const page = readSrc('src', 'renderer', 'test', 'TestPage.tsx');
  assert.match(page, /アプリ内アクティブ:/, '画面のラベルが変わっています');
  assert.match(page, /activeJobs\?\.length/, 'アプリ内アクティブの中身が変わっています');

  const doc = readDoc();
  const at = doc.indexOf('### 閉場のしかた');
  assert.ok(at > 0, '「閉場のしかた」の節がありません');
  const sec = doc.slice(at, at + 1600);
  assert.match(sec, /\*\*アプリ内アクティブ\*\*が \*\*0\*\*/, '待ち条件が「アプリ内アクティブ」ではありません');
  assert.match(sec, /「内部キュー」ではありません/, '内部キューとの取り違えを戒めていません');
});

test('「生成が間に合わない」でアプリの再起動を案内していない', () => {
  // 🔴 キューはメモリ上だけ。transformImage の呼び出しは save-photo の1箇所しかなく、
  //    起動時点検は AI 画像の再生成をしないと明記されている。
  const startup = readSrc('src', 'main', 'services', 'startup-consistency.ts');
  assert.match(startup, /AI画像の再生成とカードの再合成は.*やらない/s, '前提が変わっています');

  const doc = readDoc();
  const row = doc.split('\n').find((l) => l.startsWith('| 生成が間に合わない |'));
  assert.ok(row, '「生成が間に合わない」の行がありません');
  assert.match(row, /アプリを再起動しないこと/, '再起動を止めていません');
  assert.ok(!/local_light/.test(row), 'プロファイル切り替え（要再起動）をまだ案内しています');
  // いま並んでいるぶんには効かない、と書いてあること（書かないと二次パニックになる）
  assert.match(row, /いま並んでいるぶんは/, '効き始めのタイミングを書いていません');
});

test('手順書が案内する設定画面のラベルが実在する', () => {
  const doc = readDoc();
  // 画面に inputSize という文字列は出ない。それだけを指していると探せない
  assert.match(doc, /入力解像度（正方形）/, '手順書が実際のラベルを書いていません');
  assert.match(
    readSrc('src', 'renderer', 'test', 'TestPage.tsx'),
    /label: '入力解像度（正方形）'/,
    '画面のラベルが変わりました'
  );
});

test('手順書の ComfyUI 待ち時間が起動バッチと一致している', () => {
  const bat = readSrc('start-kidspg.bat');
  const m = bat.match(/set "COMFY_WAIT=(\d+)"/);
  assert.ok(m, 'COMFY_WAIT が見つかりません');
  assert.match(
    readDoc(),
    new RegExp('ComfyUI の待受を最大' + m[1] + '秒'),
    `手順書の待ち時間が ${m[1]} 秒と食い違っています`
  );
});
