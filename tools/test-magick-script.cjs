#!/usr/bin/env node
/**
 * magick-script-generator の単体テスト（node:test / 追加依存なし）
 *
 *   npm run build && node --test tools/test-magick-script.cjs
 *
 * ここはカード生成の中核で、**壊れると1枚もカードが出ない**。
 * 実際に踏んだ「空白入りパスが引用されずカードが全滅」と、
 * MVG のシングルクォート内でエスケープが効かず生成が失敗する件を回帰として固定する。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'dist', 'main', 'main', 'services', 'magick-script-generator.js');
if (!fs.existsSync(MODULE_PATH)) {
  throw new Error(`dist が見つかりません。先に \`npm run build\` を実行してください: ${MODULE_PATH}`);
}
const { MagickScriptGenerator } = require(MODULE_PATH);
const {
  buildPartialOutputPath,
  isPartialOutput,
  resolveFinalPathFromPartial,
  getProcessToken,
} = require(path.join(path.dirname(MODULE_PATH), 'card-output.js'));

const baseConfig = (over = {}) => ({
  backgroundImagePath: 'C:/some dir/bg card.png',
  foregroundPosition: { x: 180, y: 190, width: 650, height: 650 },
  textElements: [{ text: '疾風の忍者', x: 140, y: 190, fontSize: 50, color: '#d3593a', gravity: 'Center' }],
  outputFileName: 'memorial_card_20260912_101112.png',
  fontPath: 'C:/Windows/Fonts/meiryo.ttc',
  ...over,
});

/** buildScriptContent は private なので、生成されたスクリプトファイルを読んで確かめる */
const buildScript = async (config, foreground = 'C:/some dir/photo anime.png') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magick-test-'));
  try {
    const gen = new MagickScriptGenerator();
    const scriptPath = await gen.generateScript(config, foreground, dir);
    return fs.readFileSync(scriptPath, 'utf-8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('空白を含むパスは引用符で囲まれる（囲まないとカードが1枚も出ない）', async () => {
  const script = await buildScript(baseConfig());
  assert.match(script, /^"C:\/some dir\/bg card\.png"$/m, '背景');
  assert.match(script, /^"C:\/some dir\/photo anime\.png"$/m, '前景');
  assert.match(script, /^-font "C:\/Windows\/Fonts\/meiryo\.ttc"$/m, 'フォント');
  assert.match(script, new RegExp(`^-write "PNG:.*memorial_card_20260912_101112\.png\.${getProcessToken()}\.partial"$`, 'm'), '出力');
});

test('フォントは config.fontPath から取る（別ソースを持たない）', async () => {
  const script = await buildScript(baseConfig({ fontPath: 'C:/Windows/Fonts/YuGothM.ttc' }));
  assert.match(script, /-font "C:\/Windows\/Fonts\/YuGothM\.ttc"/);
  assert.doesNotMatch(script, /meiryo/);
});

test("MVG を壊す文字は全角へ置き換える（' を残すとスクリプト全体が失敗する）", async () => {
  const script = await buildScript(baseConfig({
    // バックスラッシュはテンプレートリテラルだと消えるので String.raw で確実に1個入れる
    textElements: [{ text: String.raw`Kids'PG "x" \y 50%`, x: 1, y: 2, fontSize: 40, color: '#000' }],
  }));
  const draw = script.split('\n').find((l) => l.startsWith('-draw'));
  assert.ok(draw, '-draw 行が無い');
  // MVG の文字列を終端させる生の ' や、展開される % / \ が残っていないこと
  const inner = draw.slice(draw.indexOf("'") + 1, draw.lastIndexOf("'"));
  assert.doesNotMatch(inner, /['"\\%]/, `危険文字が残っている: ${inner}`);
  assert.strictEqual(inner, 'Kids’PG ”x” ＼y 50％');
});

test('日本語の固定文言は素通しされる（現行のニックネームに影響しない）', async () => {
  const script = await buildScript(baseConfig());
  assert.match(script, /'疾風の忍者'/);
});

test('出力パスにシーン番号展開が混ざったら例外で止める', async () => {
  await assert.rejects(
    () => buildScript(baseConfig({ outputFileName: 'card_%d.png' })),
    /シーン番号展開/
  );
});

test('入力パスの % は誤検知しない（「50% off」のようなフォルダ名を弾かない）', async () => {
  const script = await buildScript(baseConfig({ backgroundImagePath: 'C:/50% off/bg.png' }));
  assert.match(script, /"C:\/50% off\/bg\.png"/);
});

test('末尾がフレーム指定 [...] のパスは例外で止める', async () => {
  await assert.rejects(
    () => buildScript(baseConfig(), 'C:/dir/photo[1]'),
    /フレーム指定/
  );
});

test('出力は一時名（*.partial）へ書く（最終名へ直書きすると壊れたカードが最終名で残る）', async () => {
  const script = await buildScript(baseConfig());
  const write = script.split('\n').find((l) => l.startsWith('-write'));
  assert.ok(write, '-write 行が無い');
  // 最終名で終わっていない = 途中で落ちても最終名の壊れたPNGが残らない
  assert.doesNotMatch(write, /memorial_card_20260912_101112\.png"$/);
  assert.ok(write.endsWith('.partial"'), `一時名になっていない: ${write}`);
  // プロセス固有の印が入っていること（固定名だと救済ツールと同じ一時ファイルへ
  // 2プロセスが書き、末尾だけ揃った「検査を通る壊れ方」が成立する）
  assert.ok(write.includes(`.${getProcessToken()}.partial`), `プロセス固有の印が無い: ${write}`);
  // 拡張子が .png でなくなるため、形式の明示が無いと PNG 以外で書かれてしまう
  assert.ok(write.includes('"PNG:'), '形式指定 PNG: が無い');
  // 取りこぼし検出（recovery / retry-failed）の正規表現に引っかからないこと。
  // 引っかかると「カードは出来ている」と誤認され、救済対象から外れる。
  const partialName = path.basename(write.slice(write.indexOf('PNG:') + 4, -1));
  assert.doesNotMatch(partialName, /^memorial_card_.*\.png$/);
});

test('一時名はプロセスごとに変わり、最終名へ戻せる', () => {
  const partial = buildPartialOutputPath('C:/x/memorial_card_1.png');
  assert.ok(partial.startsWith('C:/x/memorial_card_1.png.'));
  assert.ok(partial.endsWith('.partial'));
  assert.ok(isPartialOutput(partial));
  assert.ok(!isPartialOutput('C:/x/memorial_card_1.png'));
  // 掃除・救済は名前から最終名を復元する。ここがずれると救済できない
  assert.strictEqual(resolveFinalPathFromPartial(partial), 'C:/x/memorial_card_1.png');
  // 印が無い旧い形（他プロセスが残したもの）も戻せる
  assert.strictEqual(resolveFinalPathFromPartial('C:/x/memorial_card_1.png.partial'), 'C:/x/memorial_card_1.png');
  // 想定外の名前は触らせない（無関係なファイルを最終名へ据えないため）
  assert.strictEqual(resolveFinalPathFromPartial('C:/x/notes.txt.partial'), null);
  assert.strictEqual(resolveFinalPathFromPartial('C:/x/memorial_card_1.png'), null);
});

test('前景の拡大はフィルタを明示する（暗黙の既定は Mitchell で線が甘くなる）', async () => {
  const script = await buildScript(baseConfig());
  assert.match(
    script,
    /^-filter Lanczos$/m,
    '-filter が無いと ImageMagick が暗黙に拡大し、拡大時の既定 Mitchell で線とまつげがぼやけます'
  );
  assert.match(script, /^-resize 650x650$/m, '前景を 650x650 へ明示的にリサイズしていません');
  assert.match(script, /^-unsharp /m, '拡大後の弱いシャープが入っていません');
  // サイズを geometry 側に書くと暗黙リサイズに戻ってしまう
  assert.match(
    script,
    /^-geometry \+180\+190$/m,
    'geometry は位置だけを渡すこと（サイズを書くと暗黙リサイズに戻ります）'
  );
});

test('前景の加工は括弧で囲む（囲まないと背景まで縮んでカードが壊れる）', async () => {
  const script = await buildScript(baseConfig());
  const lines = script.split('\n').map((l) => l.trim());
  const open = lines.filter((l) => l === '(').length;
  const close = lines.filter((l) => l === ')').length;
  assert.strictEqual(open, 1, `'(' が ${open} 個あります（1個であるべき）`);
  assert.strictEqual(close, 1, `')' が ${close} 個あります（1個であるべき）`);

  const openAt = lines.indexOf('(');
  const closeAt = lines.indexOf(')');
  assert.ok(openAt < closeAt, '括弧の順序が逆です');

  // -filter / -resize / -unsharp は必ず括弧の中に入っていること。
  // 外に出ると背景にも効いて、背景が 650px に縮む＝カードが壊れる。
  for (const op of ['-filter ', '-resize ', '-unsharp ']) {
    const at = lines.findIndex((l) => l.startsWith(op));
    assert.ok(at > openAt && at < closeAt, `${op.trim()} が括弧の外にあります（背景にも効いてしまいます）`);
  }

  // 背景は括弧の前に読み込むこと
  const bgAt = lines.findIndex((l) => l.includes('bg card.png'));
  assert.ok(bgAt >= 0 && bgAt < openAt, '背景の読み込みが括弧の外（前）にありません');
});

test('サイズ指定が無い前景はリサイズしない（位置だけ渡す）', async () => {
  const script = await buildScript(baseConfig({ foregroundPosition: { x: 10, y: 20 } }));
  assert.ok(!/^-resize /m.test(script), 'サイズ指定が無いのにリサイズしています');
  assert.ok(!/^-unsharp /m.test(script), 'リサイズしていないのにシャープをかけています');
  assert.match(script, /^-geometry \+10\+20$/m, '位置が渡されていません');
});
