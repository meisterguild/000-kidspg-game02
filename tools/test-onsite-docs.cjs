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

test('前日、ネットを切る前に「診断と修復」を通す工程が全部の導線にある', () => {
  // 🔴 ここは一度書き間違えた。「ウォームアップは ImageMagick を1回も読まない」は
  //    **誤り**で、warmup.bat は start-kidspg.bat を呼び、そこで 4x4 の PNG 探査が
  //    走る。診断と修復にしかないのは「本物のカード土台を読む」「合成の経路を通す」
  //    「コーダーの隣へ足りない DLL を複製して直す（-Fix）」の3つ。
  //    実機（2026-09-10）でカードを作れるようにしたのはこの複製だった。
  const warmup = readSrc('tools', 'onsite', 'warmup.bat');
  assert.match(warmup, /call "%~dp0app\\start-kidspg\.bat"/, 'ウォームアップの中身が変わっています');
  assert.match(
    readSrc('start-kidspg.bat'),
    /magick -size 4x4 xc:white PNG:-/,
    '起動バッチの PNG 探査が無くなっています'
  );

  // 🔴 いちばん確実にスキップされる導線は、暖機の**画面**が出す「次にやること」。
  //    紙より画面が勝つので、ここに無いと踏まれない。
  // ラベル行（行頭の :sac_clean）で切る。goto :sac_clean / goto :sac_unknown が
  // 手前に出てくるので、単純な indexOf だと範囲が逆転して空になる（実際になった）。
  const labelAt = (name) => warmup.search(new RegExp('^' + name + '\\s*$', 'm'));
  const cleanFrom = labelAt(':sac_clean');
  assert.ok(cleanFrom > 0, ':sac_clean のラベルがありません');
  const nextLabel = warmup.slice(cleanFrom + 1).search(/^:[a-z_]+\s*$/m);
  assert.ok(nextLabel > 0, ':sac_clean の次のラベルが見つかりません');
  const clean = warmup.slice(cleanFrom, cleanFrom + 1 + nextLabel);
  assert.match(clean, /診断と修復\.bat/, '暖機の画面が診断と修復へ誘導していません');
  const dAt = clean.indexOf('診断と修復.bat');
  const netAt = clean.indexOf('インターネットを切る');
  assert.ok(netAt > 0, '暖機の画面に「インターネットを切る」がありません');
  assert.ok(dAt < netAt, '暖機の画面で、ネットを切ったあとに診断を案内しています');

  // 手順書: ネットに繋いだまま診断を通す工程が、再起動より前にあること
  const doc = readDoc();
  // 🔴 見出しで切ること。'Smart App Control の暖機' だけだと冒頭の要約に当たり、
  //    §4.7（診断と修復の説明）まで含む広すぎる範囲になって空振りする
  //    ——実際にこのテストは最初そうなっていて、手順を消しても通っていた。
  const at = doc.indexOf('### 🔴 Smart App Control の暖機');
  assert.ok(at > 0, '暖機の節（見出し）がありません');
  const end = doc.indexOf('### VC++', at);
  assert.ok(end > at, '暖機の節の終わりが見つかりません');
  const sec = doc.slice(at, end);
  const diagAt = sec.indexOf('診断と修復.bat');
  const rebootAt = sec.indexOf('ネットを切って、PCを再起動');
  assert.ok(diagAt > 0, '暖機手順に「診断と修復」がありません');
  assert.ok(rebootAt > 0, '暖機手順に再起動がありません');
  assert.ok(diagAt < rebootAt, '「診断と修復」がネットを切ったあとに置かれています');
  // 🔴 「余裕があれば（任意）」へ格下げされたら落とす。取り返しがつかない工程なので、
  //    確認すべき文言（★★★ 問題は見つかりませんでした ★★★）まで書かせる。
  assert.match(sec, /★★★ 問題は見つかりませんでした ★★★/, '確認する文言を書いていません');
  assert.ok(!/任意|余裕があれば/.test(sec), '診断と修復が任意扱いになっています');
  assert.match(
    readSrc('tools', 'onsite', 'diagnose.bat'),
    /★★★ 問題は見つかりませんでした ★★★/,
    'diagnose.bat が実際に出す文言と食い違っています'
  );

  // セットアップバッチの「このあとやること」にも入っていること
  assert.match(
    readSrc('tools', 'onsite', '0_setup.bat'),
    /診断と修復\.bat を実行し、/,
    '0_setup.bat の次にやることに入っていません'
  );
});

test('「カードが1枚もできない」の切り分け先が -version ではない', () => {
  // 🔴 コーダーの DLL が読めないだけのとき、magick -version は通る（実測）。
  //    magick.exe の有無を見ろという案内は、この故障では必ず「ある」と答える。
  const doc = readDoc();
  const row = doc.split('\n').find((l) => l.startsWith('| カードが1枚もできない |'));
  assert.ok(row, '「カードが1枚もできない」の行がありません');
  // 🔴 行内のどこかに出てくるだけの照合にしない（逆の意味に書き換えても通っていた）。
  //    「診断と修復を実行する」が先で、「-version では分からない」が理由として続くこと。
  const diagAt = row.indexOf('診断と修復.bat');
  const verAt = row.indexOf('-version');
  assert.ok(diagAt > 0, '診断と修復へ誘導していません');
  assert.ok(verAt > diagAt, '-version の話が誘導より前に来ています');
  assert.match(
    row.slice(verAt),
    /-version[^|]{0,40}(では\*\*分かりません\*\*|では分かりません)/,
    '-version では分からないと書いていません'
  );
  assert.ok(!/magick\.exe.*があるか/.test(row), '旧来の「magick.exe があるか」が残っています');
});

test('「再生成.bat は最初から入っていない」と書いてある', () => {
  // 🔴 place-regen-bat.cjs を呼ぶバッチもアプリ経路も存在しない（grep 0 件）。
  //    当日の結果フォルダは撮影のたびにできるので、必ず空振りする。
  const callers = ['tools/onsite/0_setup.bat', 'tools/onsite/diagnose.bat', 'start-kidspg.bat'];
  for (const rel of callers) {
    assert.ok(
      !fs.readFileSync(path.join(ROOT, rel), 'utf-8').includes('place-regen-bat'),
      rel + ' が place-regen-bat を呼ぶようになりました。この前提が変わっています'
    );
  }
  const row = readDoc().split('\n').find((l) => l.startsWith('| この子の絵を作り直したい |'));
  assert.ok(row, '「この子の絵を作り直したい」の行がありません');
  assert.match(row, /最初から入っていません/, '空振りする前提を書いていません');
  const placeAt = row.indexOf('place-regen-bat.cjs');
  const useAt = row.lastIndexOf('再生成.bat');
  assert.ok(placeAt > 0 && placeAt < useAt, '「先に置く」が「使う」より後になっています');
});

test('stop-kidspg.bat が画面に出すコマンドは当日PCで通る形になっている', () => {
  // 🔴 当日PCの node は ops\node\node.exe だけで PATH に無く、app\ に tools は無い。
  //    `node tools\retry-failed.cjs` は 9009 で必ず失敗する。
  const bat = readSrc('stop-kidspg.bat');
  const lines = bat.split('\r\n').filter((l) => l.includes('retry-failed'));
  assert.ok(lines.length > 0, 'retry-failed の案内がありません');
  for (const l of lines) {
    assert.ok(
      !/[^\\]node tools\\/.test(l),
      '当日PCで通らないコマンドを出しています: ' + l.trim()
    );
  }
  assert.ok(
    lines.some((l) => l.includes('node\\node.exe tools\\retry-failed.cjs')),
    'ops\\node\\node.exe を使う形になっていません'
  );
});

test('config.json のコメントが「当日はアプリを再起動」と言っていない', () => {
  // 🔴 手順書では禁止しているのに、config.json を開いた人はこちらを読む。
  // 構造は変わり得るので、_comment を含む行を生テキストで見る
  const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8');
  let checked = 0;
  for (const line of raw.split('\n')) {
    if (!line.includes('_comment')) continue;
    if (!/再起動/.test(line)) continue;
    checked += 1;
    // 🔴 許可リストの OR にしない。同じ行に「前日までの調整」が残っているだけで
    //    「当日は再起動して切り替える」を素通りさせていた（実測で確認）。
    //    ここは**禁止の検出**にする: 「当日」と「再起動」が同居していて、
    //    それが否定されていない行を落とす。
    if (!/当日/.test(line)) continue;
    const around = line.match(/当日[^。]{0,60}再起動[^。]{0,20}/g) || [];
    for (const frag of around) {
      assert.ok(
        /再起動しない|再起動不要|再起動が要る|再起動は要る/.test(frag) ||
          /当日は使わない/.test(line),
        '当日の再起動を誘っているコメントがあります: ' + frag
      );
    }
  }
  // 何も見ていないのに通る（＝空振り）テストにしない
  assert.ok(checked >= 2, '再起動に触れた _comment が見つかりません（前提が変わっています）');
});

test('診断ログは USB に載らない', () => {
  // 🔴 gitignore してあるので追跡はされないが、パッケージは作業ツリーを
  //    そのままコピーするので、開発機に残っていると USB に載る（実際に載っていた）。
  //    ソースに文字列があることではなく、**filter を実際に呼んで**確かめる。
  const src = readSrc('tools', 'make-onsite-package.cjs');
  const m = src.match(/copyTree\(path\.join\(ROOT, 'tools'\)[\s\S]*?\n\}\);/);
  assert.ok(m, 'tools の copyTree が見つかりません');
  const fnSrc = m[0]
    .slice(m[0].indexOf('filter:') + 'filter:'.length, m[0].lastIndexOf('}'))
    .trim()
    .replace(/,$/, '');
  // eslint-disable-next-line no-new-func
  const filter = new Function('path', 'return (' + fnSrc + ');')(require('node:path'));
  assert.strictEqual(filter('C:/x/tools/onsite/診断ログ_20260910_221148.txt'), false, '診断ログを通しています');
  assert.strictEqual(filter('C:/x/tools/test-readiness.cjs'), false, '単体テストを通しています');
  assert.strictEqual(filter('C:/x/tools/retry-failed.cjs'), true, '要るものを落としています');
  assert.strictEqual(filter('C:/x/tools/onsite/diagnose.bat'), true, '要るものを落としています');
});
