#!/usr/bin/env node
/**
 * 救済ツール（tools/retry-failed.cjs）の単体テスト
 *
 *   npm run build && node --test tools/test-retry-failed.cjs
 *
 * ■ なぜ要るか
 * このツールは**唯一、完成したカードの実体を動かす（rename する）**運用ツールで、
 * 当日スタッフが閉場後に叩く。にもかかわらずテストが1本も無く、
 * 敵対的レビューで次の事故経路が見つかった。
 *   1. 読めなかっただけ（I/Oエラー）の完成品を `.broken-<時刻>` へ退避してしまう
 *   2. 実体を先に退避し、作り直しに失敗・中断すると
 *      「参照は正規カードなのに実体が無い」状態が残る（半分表示より悪い）
 *   3. 壊れた results.json で当日のランキングが消えたとき、作り直す手段が無い
 *
 * `KIDSPG_RESULTS_DIR` で results/ を差し替えられるようにしてあるので、
 * 本物の results/ を触らずに検証する。ComfyUI も magick も呼ばない経路だけを見る。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'retry-failed.cjs');

const makePng = (filePath) => {
  execFileSync('magick', ['-size', '32x32', 'xc:green', 'PNG:' + filePath], { stdio: 'pipe' });
  return fs.readFileSync(filePath);
};

const writeTruncatedPng = (filePath, workDir) => {
  const src = path.join(workDir, 'src.tmp');
  const buf = makePng(src);
  fs.rmSync(src);
  fs.writeFileSync(filePath, buf.subarray(0, buf.length - 20));
};

/** ツールを実行する。ComfyUI へ行かない構成のみを対象にする */
const runTool = (resultsDir, args = []) => {
  try {
    const out = execFileSync('node', [TOOL, ...args], {
      cwd: ROOT,
      env: { ...process.env, KIDSPG_RESULTS_DIR: resultsDir },
      encoding: 'utf-8',
      timeout: 120_000,
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

const makePlay = (resultsDir, dt, options = {}) => {
  const { card = 'valid', dummy = true, anime = true, photo = true, cardPathInJson = null, score = 480 } = options;
  const dir = path.join(resultsDir, dt);
  fs.mkdirSync(dir, { recursive: true });
  if (dummy) makePng(path.join(dir, `memorial_card_${dt}.dummy.png`));
  if (anime) makePng(path.join(dir, `photo_anime_${dt}_00001_.png`));
  if (photo) makePng(path.join(dir, `photo_${dt}.png`));
  fs.writeFileSync(path.join(dir, 'image_generate.json'), '{}', 'utf-8');

  if (card === 'valid') makePng(path.join(dir, `memorial_card_${dt}.png`));
  else if (card === 'broken') writeTruncatedPng(path.join(dir, `memorial_card_${dt}.png`), dir);
  else if (card === 'unreadable') fs.mkdirSync(path.join(dir, `memorial_card_${dt}.png`));

  fs.writeFileSync(
    path.join(dir, 'result.json'),
    JSON.stringify({
      nickname: 'グミマスター',
      score,
      timestampJST: '2026-09-12 10:11:12',
      memorialCardPath: cardPathInJson ?? `${dt}/memorial_card_${dt}.dummy.png`,
    }, null, 2),
    'utf-8'
  );
  return dir;
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));

const withResultsDir = (fn) => async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-failed-'));
  const resultsDir = path.join(base, 'results');
  fs.mkdirSync(resultsDir);
  try {
    return await fn(resultsDir);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
};

test('ドライランでは何も書き換えない（壊れたカードにも触らない）', withResultsDir(async (resultsDir) => {
  const dt = '20260912_101112';
  const dir = makePlay(resultsDir, dt, { card: 'valid' });
  const brokenDt = '20260912_101113';
  const brokenDir = makePlay(resultsDir, brokenDt, { card: 'broken', cardPathInJson: brokenDt + '/memorial_card_' + brokenDt + '.png' });
  const before = fs.readFileSync(path.join(dir, 'result.json'), 'utf-8');
  const brokenBefore = fs.readFileSync(path.join(brokenDir, 'result.json'), 'utf-8');

  const { out } = runTool(resultsDir);

  assert.match(out, /ドライラン/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'result.json'), 'utf-8'), before);
  // 壊れた回でも、退避も参照の書き換えもしないこと
  assert.strictEqual(fs.readFileSync(path.join(brokenDir, 'result.json'), 'utf-8'), brokenBefore);
  assert.ok(fs.existsSync(path.join(brokenDir, 'memorial_card_' + brokenDt + '.png')), '退避してはいけない');
  assert.ok(!fs.readdirSync(brokenDir).some((f) => f.includes('.broken-')));
}));

test('検査できなかったカードは退避しない（完成品を失わないため）', withResultsDir(async (resultsDir) => {
  // 🔴 OneDrive のロックやウイルス対策で読めなかっただけの完成品を
  // `.broken-<時刻>` へ改名すると、その子のカードは戻ってこない
  const dt = '20260912_101112';
  const dir = makePlay(resultsDir, dt, { card: 'unreadable', cardPathInJson: `${dt}/memorial_card_${dt}.png` });

  const { out } = runTool(resultsDir, ['--apply']);

  assert.match(out, /検査できなかったので触りません/);
  assert.ok(fs.existsSync(path.join(dir, `memorial_card_${dt}.png`)), '退避してはいけない');
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.broken-')));
}));

test('壊れたカードは、参照をプレースホルダへ戻してから退避する', withResultsDir(async (resultsDir) => {
  // 🔴 逆順だと、この後の作り直しが失敗・中断したときに
  // 「参照は正規カードなのに実体が無い」状態が残る（表示は割れた枠、公開物からも欠ける）
  const dt = '20260912_101112';
  const dir = makePlay(resultsDir, dt, { card: 'broken', cardPathInJson: `${dt}/memorial_card_${dt}.png` });
  fs.writeFileSync(
    path.join(resultsDir, 'results.json'),
    JSON.stringify({
      recent: [{ resultPath: `${dt}/result.json`, memorialCardPath: `${dt}/memorial_card_${dt}.png`, score: 480, playedAt: 'x' }],
      ranking_top: [{ resultPath: `${dt}/result.json`, memorialCardPath: `${dt}/memorial_card_${dt}.png`, score: 480, rank: 1 }],
    }, null, 2),
    'utf-8'
  );

  const { out } = runTool(resultsDir, ['--apply']);

  // 壊れた実体は消さずに退避されている
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.png.broken-')), '壊れた実体を退避していない');

  // 作り直しまで通ったなら参照は正規カードへ戻り、失敗したならプレースホルダのまま。
  // どちらにしても「実体の無い正規カードを指したまま」にはならないこと
  const regularRef = dt + '/memorial_card_' + dt + '.png';
  const dummyRef = dt + '/memorial_card_' + dt + '.dummy.png';
  const rebuilt = fs.existsSync(path.join(dir, 'memorial_card_' + dt + '.png'));
  const expected = rebuilt ? regularRef : dummyRef;
  assert.strictEqual(readJson(path.join(dir, 'result.json')).memorialCardPath, expected,
    rebuilt ? '作り直したのに参照が戻っていない' : '実体を動かす前に参照をプレースホルダへ戻していない');
  const results = readJson(path.join(resultsDir, 'results.json'));
  assert.strictEqual(results.recent[0].memorialCardPath, expected);
  assert.strictEqual(results.ranking_top[0].memorialCardPath, expected);
  // 参照先の実体が必ずあること（ここが崩れると表示が割れた枠になる）
  assert.ok(fs.existsSync(path.join(resultsDir, expected)), '参照先の実体が無い: ' + expected);
  assert.match(out, /カードを合成/);
}));

test('プレースホルダが無い回では、壊れたカードでも退避しない', withResultsDir(async (resultsDir) => {
  const dt = '20260912_101112';
  const dir = makePlay(resultsDir, dt, { card: 'broken', dummy: false, cardPathInJson: `${dt}/memorial_card_${dt}.png` });

  runTool(resultsDir, ['--apply']);

  assert.ok(fs.existsSync(path.join(dir, `memorial_card_${dt}.png`)),
    'プレースホルダが無いのに退避すると、表示が「画像なし」になる');
}));

test('カードが揃っている回は参照を正規カードへ張り直す', withResultsDir(async (resultsDir) => {
  const dt = '20260912_101112';
  const dir = makePlay(resultsDir, dt, { card: 'valid' });
  fs.writeFileSync(
    path.join(resultsDir, 'results.json'),
    JSON.stringify({
      recent: [{ resultPath: `${dt}/result.json`, memorialCardPath: `${dt}/memorial_card_${dt}.dummy.png`, score: 480, playedAt: 'x' }],
      ranking_top: [],
    }, null, 2),
    'utf-8'
  );

  const { out } = runTool(resultsDir, ['--apply']);

  assert.match(out, /result.json への記録/);
  assert.strictEqual(readJson(path.join(dir, 'result.json')).memorialCardPath, `${dt}/memorial_card_${dt}.png`);
  assert.strictEqual(
    readJson(path.join(resultsDir, 'results.json')).recent[0].memorialCardPath,
    `${dt}/memorial_card_${dt}.png`
  );
}));

test('--rebuild-index で results.json を各 result.json から作り直せる', withResultsDir(async (resultsDir) => {
  // 電源断で壊れた索引は退避され、当日のトップ10が消える。正本から組み直せること
  makePlay(resultsDir, '20260912_100000', { card: 'valid', score: 200 });
  makePlay(resultsDir, '20260912_110000', { card: 'valid', score: 1112 });
  makePlay(resultsDir, '20260912_120000', { card: 'valid', score: 536 });

  const { out } = runTool(resultsDir, ['--apply', '--rebuild-index']);

  assert.match(out, /results.json を 3 件の result.json から作り直します/);
  const results = readJson(path.join(resultsDir, 'results.json'));
  // ランキングはスコア順
  assert.deepStrictEqual(results.ranking_top.map((e) => e.score), [1112, 536, 200]);
  assert.deepStrictEqual(results.ranking_top.map((e) => e.rank), [1, 2, 3]);
  // 履歴は新しい順
  assert.strictEqual(results.recent[0].resultPath, '20260912_120000/result.json');
  // 参照先の実体があること（無いパスを書かない）
  for (const e of [...results.recent, ...results.ranking_top]) {
    assert.ok(fs.existsSync(path.join(resultsDir, e.memorialCardPath)), `実体が無い: ${e.memorialCardPath}`);
  }
}));

test('保守中のロックがあれば --apply は拒否する（点検との衝突を避ける）', withResultsDir(async (resultsDir) => {
  makePlay(resultsDir, '20260912_101112', { card: 'valid' });
  // 生きているプロセスのロックを模す（heartbeat が無いので mtime は現在時刻）
  fs.writeFileSync(path.join(resultsDir, '.maintenance.lock'), JSON.stringify({ pid: 424242, token: '424242-ffffff' }));

  const { code, out } = runTool(resultsDir, ['--apply']);

  assert.match(out, /別のプロセスが results\/ を保守中/);
  assert.strictEqual(code, 1, '衝突は exit code で分かるようにする');
}));

test('日時名のファイルが混ざっていても全体が止まらない', withResultsDir(async (resultsDir) => {
  makePlay(resultsDir, '20260912_101112', { card: 'valid' });
  // zip の展開ミスなどで実在する
  fs.writeFileSync(path.join(resultsDir, '20260912_999999'), 'not a directory', 'utf-8');

  const { out } = runTool(resultsDir, ['--apply']);

  assert.match(out, /フォルダを読めません/);
  assert.match(out, /result.json への記録/);
}));

test('--rebuild-index と --only の併用は拒否する（索引が1件に潰れる）', withResultsDir(async (resultsDir) => {
  makePlay(resultsDir, '20260912_100000', { card: 'valid', score: 200 });
  makePlay(resultsDir, '20260912_110000', { card: 'valid', score: 1112 });
  const before = JSON.stringify({ recent: [], ranking_top: [] });
  fs.writeFileSync(path.join(resultsDir, 'results.json'), before, 'utf-8');

  const { code, out } = runTool(resultsDir, ['--apply', '--rebuild-index', '--only', '20260912_110000']);

  assert.match(out, /同時に使えません/);
  assert.strictEqual(code, 2);
  assert.strictEqual(fs.readFileSync(path.join(resultsDir, 'results.json'), 'utf-8'), before, '索引を触ってはいけない');
}));

test('引数の指定ミスは黙って進めない（値なし・不正な数値・未知の引数）', withResultsDir(async (resultsDir) => {
  makePlay(resultsDir, '20260912_100000', { card: 'valid' });

  // --only の値が無いと、以前は全件対象や rebuildIndex 無効化になっていた
  const noValue = runTool(resultsDir, ['--apply', '--only']);
  assert.strictEqual(noValue.code, 2);
  assert.match(noValue.out, /--only には日時フォルダ名/);

  const badNumber = runTool(resultsDir, ['--apply', '--timeout-min', 'abc']);
  assert.strictEqual(badNumber.code, 2);
  assert.match(badNumber.out, /--timeout-min には正の数/);

  const unknown = runTool(resultsDir, ['--apply', '--wat']);
  assert.strictEqual(unknown.code, 2);
  assert.match(unknown.out, /知らない引数/);
}));

test('検査できなかった回があれば exit code で知らせる（完了と読ませない）', withResultsDir(async (resultsDir) => {
  const dt = '20260912_101112';
  makePlay(resultsDir, dt, { card: 'unreadable', cardPathInJson: `${dt}/memorial_card_${dt}.png` });

  const { code, out } = runTool(resultsDir, ['--apply']);

  assert.match(out, /未解決のものがあります/);
  assert.strictEqual(code, 1, '「その子のカードが出るか未確定」を exit 0 で流してはいけない');
}));

test('--rebuild-index は検査できなかったカードの参照を格下げしない', withResultsDir(async (resultsDir) => {
  // 🔴 unknown を「カードが無い」と同一視すると、完成カードが一斉に
  // プレースホルダ参照へ格下げされ、プレースホルダも無い回は索引から消える
  const dt = '20260912_101112';
  makePlay(resultsDir, dt, { card: 'unreadable', cardPathInJson: `${dt}/memorial_card_${dt}.png` });
  fs.writeFileSync(
    path.join(resultsDir, 'results.json'),
    JSON.stringify({
      recent: [{ resultPath: `${dt}/result.json`, memorialCardPath: `${dt}/memorial_card_${dt}.png`, score: 480, playedAt: 'x' }],
      ranking_top: [],
    }, null, 2),
    'utf-8'
  );

  runTool(resultsDir, ['--apply', '--rebuild-index']);

  const results = readJson(path.join(resultsDir, 'results.json'));
  assert.strictEqual(
    results.recent[0].memorialCardPath,
    `${dt}/memorial_card_${dt}.png`,
    '以前の参照を引き継がず、プレースホルダへ格下げしている'
  );
}));

test('--rebuild-index は旧 results.json を退避してから置き換える', withResultsDir(async (resultsDir) => {
  makePlay(resultsDir, '20260912_100000', { card: 'valid', score: 200 });
  fs.writeFileSync(path.join(resultsDir, 'results.json'), JSON.stringify({ recent: [], ranking_top: [] }), 'utf-8');

  const { out } = runTool(resultsDir, ['--apply', '--rebuild-index']);

  assert.match(out, /作り直しました/);
  assert.ok(
    fs.readdirSync(resultsDir).some((f) => f.startsWith('results.json.before-rebuild-')),
    '旧ファイルを退避していない'
  );
}));

test('--force-unlock で残ったロックを外せる（当日の詰みを回避する）', withResultsDir(async (resultsDir) => {
  makePlay(resultsDir, '20260912_101112', { card: 'valid' });
  fs.writeFileSync(path.join(resultsDir, '.maintenance.lock'), JSON.stringify({ pid: 424242, token: '424242-ffffff' }));

  const { out } = runTool(resultsDir, ['--apply', '--force-unlock']);

  assert.match(out, /残っていた保守ロックを外しました/);
  assert.match(out, /result.json への記録|まとめ/);
}));

/**
 * 救済スクリプト（npm run recovery / src/test/memorial-card-recovery.ts）を実行する。
 * このツールと違って tsx 経由なので起動が遅いが、**保守ロックの取り合い**は
 * 実際にプロセスを立てないと確かめられない。
 */
const runRecovery = (resultsDir, extraEnv = {}) => {
  try {
    // 🔴 パスを引数に渡さない。ROOT には空白と日本語が入る（OneDrive 配下）ため、
    // shell 経由では引数が分断される。retry-failed 本体と同じ `npm run recovery` を使う。
    const out = execFileSync('npm', ['run', 'recovery'], {
      cwd: ROOT,
      env: { ...process.env, KIDSPG_RESULTS_DIR: resultsDir, ...extraEnv },
      encoding: 'utf-8',
      timeout: 180_000,
      shell: true,
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

test('救済スクリプトは保守ロックを取り、終了時に解放する', withResultsDir(async (resultsDir) => {
  // 🔴 ロックを取らないと、アプリの起動時点検が「壊れている」と判断した直後に
  // こちらが正常なカードを完成させ、点検側がその新しいカードを退避する——という
  // 取り返しのつかない競合になる（アプリを起動したまま走らせる運用がある）。
  makePlay(resultsDir, '20260912_101112', { card: 'valid' });

  const { out } = runRecovery(resultsDir);

  assert.match(out, /Memorial Card Recovery Script/);
  assert.ok(
    !fs.existsSync(path.join(resultsDir, '.maintenance.lock')),
    '保守ロックが残っている（以後10分、起動時点検と救済ツールが止まる）'
  );
}));

test('保守ロックを他プロセスが持っているとき、救済スクリプトは何もせず終わる', withResultsDir(async (resultsDir) => {
  makePlay(resultsDir, '20260912_101112', { card: 'valid' });
  // 生きている別プロセスのロックを模す（新しい mtime のまま）
  fs.writeFileSync(
    path.join(resultsDir, '.maintenance.lock'),
    JSON.stringify({ pid: 999999, token: '999999-abcdef', at: new Date().toISOString() }),
    'utf-8'
  );

  const { out } = runRecovery(resultsDir);

  assert.match(out, /別のプロセスが results\/ を保守中です/);
  // 他人のロックを消していないこと
  assert.ok(fs.existsSync(path.join(resultsDir, '.maintenance.lock')), '他プロセスのロックを消してしまった');
}));

test('親（retry-failed）がロックを持っている場合は取り直さない', withResultsDir(async (resultsDir) => {
  // 🔴 retry-failed --apply はロックを取ってから recovery を呼ぶ。
  // 子が自分で取りに行くと、親のロックで弾かれて**1件も直せなくなる**。
  makePlay(resultsDir, '20260912_101112', { card: 'valid' });
  fs.writeFileSync(
    path.join(resultsDir, '.maintenance.lock'),
    JSON.stringify({ pid: process.pid, token: 'parent-token', at: new Date().toISOString() }),
    'utf-8'
  );

  const { out } = runRecovery(resultsDir, { KIDSPG_MAINTENANCE_LOCK_HELD: '1' });

  assert.doesNotMatch(out, /別のプロセスが results\/ を保守中です/);
  assert.match(out, /Recovery Analysis/, '点検まで進んでいない');
  // 親のロックは残したままにする（解放は親の責任）
  assert.ok(fs.existsSync(path.join(resultsDir, '.maintenance.lock')), '親のロックを解放してしまった');
}));
// ------------------------------------------------------------------
// カード合成のルート解決（2026-09-09 の敵対的レビュー指摘）
//
// 🔴 ここが1段ずれていたため、retry-failed が委譲するカード合成が
//    **全環境で 100% 失敗**していた（config.json を <root>/dist/ に探していた）。
//    tsx 実行だけが正しく、コンパイル済み経路だけが壊れる形だったので、
//    「コンパイル済みを実際に実行して確かめる」テストにする。
// ------------------------------------------------------------------

const RECOVERY_JS = path.join(ROOT, 'dist', 'main', 'test', 'memorial-card-recovery.js');

test('コンパイル済みの救済スクリプトは config.json と素材を見つけられる', () => {
  const out = execFileSync(process.execPath, [RECOVERY_JS, '--check-compose'], {
    cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
  });
  // dist/ を指していた頃はここが <root>\dist\config.json になっていた
  assert.ok(
    out.includes(path.join(ROOT, 'config.json')),
    '設定の場所がリポジトリ直下でない:\n' + out
  );
  assert.ok(/OK : 土台画像 \d+ 枚/.test(out), '土台画像を見つけられていない:\n' + out);
  assert.ok(!out.includes(path.join(ROOT, 'dist', 'config.json')), 'dist を見ている:\n' + out);
});

test('--check-compose は magick の起動まで確かめる（--dry-run では代用できない）', () => {
  // magick が無い状態を作る。PATH を空にすると spawn('magick') は ENOENT になる
  let failed = null;
  try {
    execFileSync(process.execPath, [RECOVERY_JS, '--check-compose'], {
      cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
      env: { ...process.env, PATH: path.join(ROOT, 'tools'), Path: path.join(ROOT, 'tools') },
    });
  } catch (e) {
    failed = e;
  }
  assert.ok(failed, 'magick が無いのに成功した（--dry-run と同じ穴が残っている）');
  const shown = String(failed.stdout || '') + String(failed.stderr || '');
  assert.match(shown, /magick を起動できません/, '理由が示されていない:\n' + shown);
});

test('--check-compose は合成に使うのと同じ magick を見る', () => {
  // 🔴 素の 'magick' を別に叩くと、当日PC（PATH に無い携帯版）では
  //    **合成は通るのに点検だけが落ちて救済が止まる**。
  //    以前ここには「--dry-run は何も確かめない」という
  //    **欠陥を仕様として固定する**テストが置いてあった（それを消した）。
  const out = execFileSync(process.execPath, [RECOVERY_JS, '--check-compose'], {
    cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
  });
  assert.match(out, /OK : magick の場所 :/, '使う magick の場所を出していない:' + out);
  const src = fs.readFileSync(path.join(ROOT, 'src', 'test', 'memorial-card-recovery.ts'), 'utf-8');
  assert.ok(
    !/spawnSync\('magick'/.test(src),
    "素の 'magick' を叩いている（携帯版の当日PCで点検だけが落ちる）"
  );
  assert.match(src, /service\.getMagickCommand\(\)/, '合成に使う場所を聞いていない');
});

test('事前確認は --check-compose を使っている（--dry-run へ戻していない）', () => {
  const src = fs.readFileSync(TOOL, 'utf-8');
  assert.match(src, /'--check-compose'/, '事前確認が --check-compose を呼んでいない');
  // 🔴 **切り出しが空になっていないことを確かめる。** 以前は
  //    indexOf('壊れたカードの退避') が indexOf('let canRebuild') より
  //    **前**にあり（実測 18996 < 21008）slice が '' になっていたため、
  //    !''.includes('--dry-run') が**無条件で成立**していた。
  //    --dry-run に戻しても、事前確認ブロックを丸ごと消しても緑だった
  //    （敵対的レビュー 2026-09-09 の指摘）。
  const start = src.indexOf('let canRebuild');
  assert.ok(start > 0, '事前確認ブロックの先頭が見つからない');
  const end = src.indexOf('} catch (e) {', start);
  assert.ok(end > start, '事前確認ブロックの終端が見つからない（切り出しが空になる）');
  const preflight = src.slice(start, end);
  assert.ok(preflight.length > 100, '切り出しが短すぎる（' + preflight.length + '文字）');
  assert.ok(
    preflight.includes("'--check-compose'"),
    '事前確認ブロックの中で --check-compose を呼んでいない'
  );
  assert.ok(
    !preflight.includes("'--dry-run'"),
    '事前確認が --dry-run に戻っている（何も確かめられない）'
  );
});
