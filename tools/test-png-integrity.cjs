#!/usr/bin/env node
/**
 * PNG の完全性検査とカードの確定処理の単体テスト（node:test / 追加依存なし）
 *
 *   npm run build && node --test tools/test-png-integrity.cjs
 *
 * ■ 何の回帰を固定しているか
 * 2026-09-02、ギャラリーで**カードの上半分しか表示されない**事象が出た。
 * 原因はリフレッシュではなく、ImageMagick が書き込み中にプロセスが終了し、
 * **最終ファイル名のまま先頭だけ揃った壊れたPNG**が残っていたこと
 * （950,272 バイト = ブロック境界ぴったり。正常は 2.36〜2.87MB）。
 * 当時の判定は「先頭8バイトのシグネチャ + サイズ>0」だけで、これを正常と誤認していた。
 *
 * さらに敵対的レビューで、直し方そのものに次の危険があると分かったので併せて固定する。
 *   ・I/Oエラー（OneDrive のロック等）を「壊れている」と断定すると、
 *     **完成しているカードを消す／退避する**ことになる
 *   ・rename が共有違反で失敗したとき、検査に通った完成品を捨ててしまう
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'main', 'main', 'services');
for (const m of ['png-integrity.js', 'card-output.js']) {
  if (!fs.existsSync(path.join(DIST, m))) {
    throw new Error('dist が見つかりません。先に `npm run build` を実行してください: ' + path.join(DIST, m));
  }
}
const { verifyPngFile, verifyPngFileSync, isDefinitelyCorrupt } = require(path.join(DIST, 'png-integrity.js'));
const {
  finalizeCardOutput,
  discardFailedPartial,
  cleanupPartialCardOutputs,
  buildPartialOutputPath,
  acquireMaintenanceLock,
} = require(path.join(DIST, 'card-output.js'));

/** 実物のPNGを1枚作る（ImageMagick はカード生成に必須なので、この環境には必ずある） */
const makePng = (filePath) => {
  execFileSync('magick', ['-size', '64x64', 'xc:red', 'PNG:' + filePath], { stdio: 'pipe' });
  return fs.readFileSync(filePath);
};

/** 先頭のシグネチャは残したまま末尾を落とす = 当日踏んだ壊れ方 */
const writeTruncatedPng = (filePath, sourcePath) => {
  const buf = makePng(sourcePath);
  fs.writeFileSync(filePath, buf.subarray(0, buf.length - 20));
  fs.rmSync(sourcePath, { force: true });
  return buf;
};

const withTempDir = (fn) => async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'png-integrity-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('完全なPNGは valid', withTempDir(async (dir) => {
  const p = path.join(dir, 'ok.png');
  makePng(p);
  const r = await verifyPngFile(p);
  assert.strictEqual(r.valid, true, r.error);
  assert.strictEqual(r.status, 'valid');
  assert.ok(r.size > 0);
}));

test('途中で切れたPNGは corrupt（先頭シグネチャは揃っているのに壊れている実例）', withTempDir(async (dir) => {
  const truncated = path.join(dir, 'truncated.png');
  const buf = writeTruncatedPng(truncated, path.join(dir, 'src.png'));

  const r = await verifyPngFile(truncated);
  assert.strictEqual(r.status, 'corrupt');
  assert.ok(isDefinitelyCorrupt(r));
  assert.match(r.error, /IEND/);
  // 旧判定（先頭8バイト + サイズ>0）では正常に見えてしまうことを併せて示す
  assert.deepStrictEqual(fs.readFileSync(truncated).subarray(0, 8), buf.subarray(0, 8));
}));

test('検査できなかった場合は corrupt にしない（完成品を壊さないため）', withTempDir(async (dir) => {
  // ディレクトリを指すのは「PNG として壊れている」ことを意味しない
  const asDir = path.join(dir, 'sub');
  fs.mkdirSync(asDir);
  const r = await verifyPngFile(asDir);
  assert.strictEqual(r.status, 'unknown');
  assert.strictEqual(isDefinitelyCorrupt(r), false);

  // 存在しないものは missing（これも corrupt ではない）
  const missing = await verifyPngFile(path.join(dir, 'none.png'));
  assert.strictEqual(missing.status, 'missing');
  assert.strictEqual(isDefinitelyCorrupt(missing), false);
}));

test('同期版と非同期版は同じ判定になる', withTempDir(async (dir) => {
  const ok = path.join(dir, 'ok.png');
  const buf = makePng(ok);
  const ng = path.join(dir, 'ng.png');
  fs.writeFileSync(ng, buf.subarray(0, 100));

  for (const p of [ok, ng, path.join(dir, 'none.png')]) {
    const a = await verifyPngFile(p);
    const b = verifyPngFileSync(p);
    assert.strictEqual(a.status, b.status, `判定がずれている: ${p}`);
  }
  assert.strictEqual(verifyPngFileSync(ng).status, 'corrupt');
}));

test('小さすぎるファイルは corrupt', withTempDir(async (dir) => {
  const tiny = path.join(dir, 'tiny.png');
  fs.writeFileSync(tiny, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const r = await verifyPngFile(tiny);
  assert.strictEqual(r.status, 'corrupt');
}));

test('finalizeCardOutput: 完全な一時ファイルは最終名へ据えられる', withTempDir(async (dir) => {
  const finalPath = path.join(dir, 'memorial_card_20260912_101112.png');
  makePng(buildPartialOutputPath(finalPath));

  const error = await finalizeCardOutput(finalPath);
  assert.strictEqual(error, null);
  assert.ok(fs.existsSync(finalPath), '最終名が作られていない');
  assert.ok(!fs.existsSync(buildPartialOutputPath(finalPath)), '一時ファイルが残っている');
}));

test('finalizeCardOutput: 壊れた一時ファイルなら最終名を作らず一時ファイルも残さない', withTempDir(async (dir) => {
  const finalPath = path.join(dir, 'memorial_card_20260912_101112.png');
  writeTruncatedPng(buildPartialOutputPath(finalPath), path.join(dir, 'src.png'));

  const error = await finalizeCardOutput(finalPath);
  assert.match(error, /不完全/);
  // 🔴 ここが肝。最終名を作らないことで救済ツールが「カードが無い回」として拾える
  assert.ok(!fs.existsSync(finalPath), '壊れた出力が最終名で残っている');
  assert.ok(!fs.existsSync(buildPartialOutputPath(finalPath)), '壊れた一時ファイルが残っている');
}));

test('finalizeCardOutput: rename に負けても完成品を捨てない（後で救済できる形で残す）', withTempDir(async (dir) => {
  const finalPath = path.join(dir, 'memorial_card_20260912_101112.png');
  const partialPath = buildPartialOutputPath(finalPath);
  makePng(partialPath);

  // 🔴 rename を**決定的に**失敗させる。
  // fs.openSync(path, 'r+') は Windows でも FILE_SHARE_DELETE 付きで開くため
  // MoveFileEx は成功してしまい、共有違反の再現にならない
  // （それだと if/else の両方を assert する形になり、この不変条件を固定できない）。
  // 中身のあるディレクトリを最終名に置くと、rename は必ず失敗する。
  fs.mkdirSync(finalPath);
  fs.writeFileSync(path.join(finalPath, 'blocker.txt'), 'x');

  const error = await finalizeCardOutput(finalPath);

  assert.ok(error, 'rename は失敗するはず');
  assert.match(error, /rename|確認できませんでした/);
  // ここが肝。完成品を消すとその子のカードは戻ってこない
  assert.ok(fs.existsSync(partialPath), '完成した一時ファイルを捨ててはいけない');
}));

test('finalizeCardOutput: 検査できなかった一時ファイルは消さない（unknown 分岐）', withTempDir(async (dir) => {
  const finalPath = path.join(dir, 'memorial_card_20260912_101112.png');
  const partialPath = buildPartialOutputPath(finalPath);
  // ディレクトリにして「読めない（unknown）」を作る。corrupt ではない
  fs.mkdirSync(partialPath);

  const error = await finalizeCardOutput(finalPath);

  assert.match(error, /確認できませんでした/);
  assert.ok(fs.existsSync(partialPath), 'unknown を corrupt と同じ扱いにしてはいけない');
  assert.ok(!fs.existsSync(finalPath));
}));

test('finalizeCardOutput: 最終名に完全なカードがあれば踏み潰さない', withTempDir(async (dir) => {
  // 稼働中に救済ツールが作り直したカードを、古い一時ファイルで上書きしない
  const finalPath = path.join(dir, 'memorial_card_20260912_101112.png');
  execFileSync('magick', ['-size', '64x64', 'xc:blue', 'PNG:' + finalPath], { stdio: 'pipe' });
  const kept = fs.readFileSync(finalPath);
  makePng(buildPartialOutputPath(finalPath)); // 別内容（赤）

  const error = await finalizeCardOutput(finalPath);

  assert.strictEqual(error, null);
  assert.deepStrictEqual(fs.readFileSync(finalPath), kept, '既にある完全なカードを置き換えてはいけない');
}));

test('discardFailedPartial: 壊れたものだけ消す', withTempDir(async (dir) => {
  const brokenFinal = path.join(dir, 'memorial_card_a.png');
  writeTruncatedPng(buildPartialOutputPath(brokenFinal), path.join(dir, 'src.png'));
  await discardFailedPartial(brokenFinal);
  assert.ok(!fs.existsSync(buildPartialOutputPath(brokenFinal)), '壊れた一時ファイルは消す');

  const okFinal = path.join(dir, 'memorial_card_b.png');
  makePng(buildPartialOutputPath(okFinal));
  await discardFailedPartial(okFinal);
  assert.ok(fs.existsSync(buildPartialOutputPath(okFinal)), '完成している一時ファイルは消さない');
}));

test('cleanupPartialCardOutputs: 完成していた残骸は最終名へ救済する', withTempDir(async (dir) => {
  // rename に失敗して取り残された「完成品」を再現する
  const finalPath = path.join(dir, 'memorial_card_20260912_101112.png');
  const stale = `${finalPath}.9999-abcdef.partial`;
  makePng(stale);
  const old = (Date.now() - 10 * 60 * 1000) / 1000;
  fs.utimesSync(stale, old, old);

  const sweep = await cleanupPartialCardOutputs(dir);
  assert.deepStrictEqual(sweep.rescued, [finalPath]);
  assert.deepStrictEqual(sweep.removed, []);
  assert.ok(fs.existsSync(finalPath), '完成品を最終名へ据えていない');
  assert.ok(!fs.existsSync(stale));
}));

test('cleanupPartialCardOutputs: 壊れた残骸は消し、新しいものは触らない', withTempDir(async (dir) => {
  const freshFinal = path.join(dir, 'memorial_card_fresh.png');
  const fresh = `${freshFinal}.1234-a1b2c3.partial`;
  fs.writeFileSync(fresh, 'x'); // いま書き込み中かもしれないもの

  const staleFinal = path.join(dir, 'memorial_card_stale.png');
  const stale = `${staleFinal}.5678-d4e5f6.partial`;
  writeTruncatedPng(stale, path.join(dir, 'src.png'));
  const old = (Date.now() - 10 * 60 * 1000) / 1000;
  fs.utimesSync(stale, old, old);

  const sweep = await cleanupPartialCardOutputs(dir);
  assert.deepStrictEqual(sweep.removed.map((p) => path.basename(p)), [path.basename(stale)]);
  assert.deepStrictEqual(sweep.rescued, []);
  assert.ok(fs.existsSync(fresh), '書き込み中の可能性があるものを消してはいけない');
  assert.ok(!fs.existsSync(staleFinal), '壊れた残骸を最終名へ据えてはいけない');
}));

test('cleanupPartialCardOutputs: 最終名に完全なカードがあれば残骸は消すだけ', withTempDir(async (dir) => {
  const finalPath = path.join(dir, 'memorial_card_20260912_101112.png');
  makePng(finalPath);
  const stale = `${finalPath}.9012-a7b8c9.partial`;
  makePng(stale);
  const old = (Date.now() - 10 * 60 * 1000) / 1000;
  fs.utimesSync(stale, old, old);

  const before = fs.readFileSync(finalPath);
  const sweep = await cleanupPartialCardOutputs(dir);
  assert.deepStrictEqual(sweep.rescued, []);
  assert.strictEqual(sweep.removed.length, 1);
  assert.deepStrictEqual(fs.readFileSync(finalPath), before, '既にある完全なカードを置き換えてはいけない');
}));

test('acquireMaintenanceLock: 二重取得は防ぎ、release で解放される', withTempDir(async (dir) => {
  const first = await acquireMaintenanceLock(dir);
  assert.ok(first, '1回目は取得できるはず');
  const second = await acquireMaintenanceLock(dir);
  assert.strictEqual(second, null, '2回目は取得できてはいけない');
  await first();
  const third = await acquireMaintenanceLock(dir);
  assert.ok(third, '解放後は取得できるはず');
  await third();
}));

test('acquireMaintenanceLock: 異常終了で残った古いロックは引き継ぐ', withTempDir(async (dir) => {
  const lockPath = path.join(dir, '.maintenance.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999 }));
  const old = (Date.now() - 60 * 60 * 1000) / 1000;
  fs.utimesSync(lockPath, old, old);

  const release = await acquireMaintenanceLock(dir);
  assert.ok(release, '十分に古いロックは引き継げるべき（さもないと永久に保守できない）');
  await release();
}));

test('OneDrive の競合コピーや無関係なファイルは最終名へ昇格させない', () => {
  const { resolveFinalPathFromPartial } = require(path.join(DIST, 'card-output.js'));

  // 正しい印（<pid>-<16進6桁>）だけを受ける
  assert.strictEqual(
    resolveFinalPathFromPartial('C:/x/memorial_card_1.png.12345-a1b2c3.partial'),
    'C:/x/memorial_card_1.png'
  );
  // 印なしの旧形式も救済できる（中断で残った retry-failed のダウンロードなど）
  assert.strictEqual(
    resolveFinalPathFromPartial('C:/x/photo_anime_1.png.partial'),
    'C:/x/photo_anime_1.png'
  );

  // 🔴 OneDrive は競合時に `名前-DESKTOP-XXXX` を作る。これを最終名へ据えると
  // 他機で作られた別内容・別世代の画像がその子のカードとして確定してしまう
  assert.strictEqual(
    resolveFinalPathFromPartial('C:/x/memorial_card_1.png.12345-a1b2c3-DESKTOP-A1B2.partial'),
    null
  );
  // カード／AI画像以外は対象にしない
  assert.strictEqual(resolveFinalPathFromPartial('C:/x/notes.png.12345-a1b2c3.partial'), null);
  assert.strictEqual(resolveFinalPathFromPartial('C:/x/memorial_card_1.txt.12345-a1b2c3.partial'), null);
});

test('acquireMaintenanceLock: 解放は自分のロックだけ（横取り後に他人のを消さない）', withTempDir(async (dir) => {
  const release = await acquireMaintenanceLock(dir);
  assert.ok(release);

  // 他プロセスに取り直された状況を作る
  const lockPath = path.join(dir, '.maintenance.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 424242, token: '424242-ffffff' }));

  await release();
  assert.ok(fs.existsSync(lockPath), '他プロセスのロックを消してはいけない');
  fs.rmSync(lockPath);
}));

test('acquireMaintenanceLock: 保持中は heartbeat で横取りされない', withTempDir(async (dir) => {
  // staleMs を短くすると heartbeat 間隔も短くなる（既定は 10分/4）
  const release = await acquireMaintenanceLock(dir, 4000);
  assert.ok(release);
  try {
    // heartbeat が mtime を更新し続けるので、staleMs を過ぎても奪われない。
    // これが無いと、数十分かかる救済ツールのロックが起動時点検に横取りされる。
    await new Promise((r) => setTimeout(r, 5000));
    const stolen = await acquireMaintenanceLock(dir, 4000);
    assert.strictEqual(stolen, null, '生きているプロセスのロックを奪ってはいけない');
  } finally {
    await release();
  }
}));
