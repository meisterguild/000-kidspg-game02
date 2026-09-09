#!/usr/bin/env node
/**
 * results/ から**生の顔写真だけ**を消す（todo #10）
 *
 *   node tools/purge-photos.cjs                    # 何が消えるかを表示するだけ（既定）
 *   node tools/purge-photos.cjs --apply            # 実際に消す
 *   node tools/purge-photos.cjs --apply --only 20260912_101112
 *   node tools/purge-photos.cjs --apply --include-incomplete   # 未完成の回も消す（危険）
 *
 *   KIDSPG_RESULTS_DIR=D:\kidspg-2026\results node tools/purge-photos.cjs
 *
 * ■ 消すもの / 残すもの
 *   消す : photo_<日時>.png            … カメラで撮った**そのままの顔写真**
 *   残す : photo_anime_<日時>_*.png    … AI変換後の絵（カードの中身。後日の公開物）
 *          memorial_card_<日時>.png    … 記念カード
 *          result.json / image_generate.json
 *
 * ■ 🔴 消すと AI 画像の再生成ができなくなる
 * tools/retry-failed.cjs のパターンA（AI画像が無い回の作り直し）は、
 * **毎回この写真を ComfyUI へ上げ直す**。写真を消した回は、あとから
 * AI 画像を作り直せない。
 * そのため既定では「カードが完成している回」だけを対象にする。
 * 未完成の回まで消したいときだけ --include-incomplete を付ける。
 *
 * ■ 壊さないための約束（retry-failed.cjs と同じ）
 *   ・既定はドライラン。--apply を付けたときだけ消す
 *   ・カードの完成を PNG の中身まで見て確かめる（png-integrity）
 *   ・result.json が写真を指している場合は参照も外す（実体の無いパスを残さない）
 *
 * ■ ComfyUI 側にも同じ写真が残る（2026-09-09 の敵対的レビューで発覚）
 * 🔴 アプリは `/upload/image` で写真を上げるので `<ComfyUI>\input\` に
 * **参加した子ども全員の生の顔写真**が、ワークフローの SaveImage により
 * `<ComfyUI>\output\` に変換後の絵が溜まる。ここは誰も消していなかった。
 * 以前この説明は「ComfyUI の input は再起動で消えるため」と書いていたが、
 * **そうなる仕組みはどこにも無い**（実測: 何度も再起動した開発機で
 * input 44 件・output 51 件が残っていた）。つまり results の写真を消しても
 * 同じ写真の完全なコピーが残る状態だった。
 * このツールは results と合わせて**そこも消す**。判断は
 * tools/lib/comfyui-scratch.cjs（トップレベルの input/ output/ のファイルだけ）。
 * 触りたくない場合は `--keep-comfyui` を付ける。
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { resolveResultsDir, describeMissing } = require('./lib/resolve-results-dir.cjs');
const { resolveComfyUIRoot, listScratchFiles } = require('./lib/comfyui-scratch.cjs');

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
/**
 * 🔴 **値の書き忘れを黙って通してはいけない。**
 * `--only --apply` のように値を書き忘れると、以前はここが null を返し、
 * ONLY 無し＝**全プレイの生の顔写真を一括削除**になっていた。
 * しかも写真を消した回は AI 画像を作り直せなくなる（このファイル冒頭の注意）。
 * retry-failed.cjs は同じ罠にちゃんと検証を入れているのに、
 * こちらだけ抜けていた（敵対的レビュー 2026-09-09 の指摘）。
 */
const flagErrors = [];
const flag = (name, { pattern, example } = {}) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const next = argv[i + 1];
  if (!next || next.startsWith('--')) {
    flagErrors.push(`--${name} には値を指定してください` + (example ? `（例: --${name} ${example}）` : ''));
    return null;
  }
  if (pattern && !pattern.test(next)) {
    flagErrors.push(`--${name} の指定が想定の形ではありません: ${next}` + (example ? `（例: ${example}）` : ''));
    return null;
  }
  return next;
};

/**
 * 🔴 **未知のフラグを黙って無視してはいけない。**
 * `--keep-comfy` のような打ち間違いが「触らないつもり」なのに
 * **全消し**になる（敵対的レビュー 2026-09-09 の指摘）。
 * 値つきのフラグは flag() が検証するので、ここは真偽フラグの綴りを見る。
 */
const KNOWN_FLAGS = new Set([
  'apply',
  'include-incomplete',
  'include-unverified',
  'keep-comfyui',
  'only',
]);
for (const arg of argv) {
  if (!arg.startsWith('--')) continue;
  const name = arg.slice(2);
  if (!KNOWN_FLAGS.has(name)) {
    flagErrors.push(
      `知らない指定です: ${arg}（使えるのは ${[...KNOWN_FLAGS].map((f) => '--' + f).join(' / ')}）`
    );
  }
}

const APPLY = has('apply');
const INCLUDE_INCOMPLETE = has('include-incomplete');
const INCLUDE_UNVERIFIED = has('include-unverified');
const KEEP_COMFYUI = has('keep-comfyui');
const ONLY = flag('only', { pattern: /^\d{8}_\d{6}$/, example: '20260912_101112' });

if (flagErrors.length > 0) {
  console.error('指定に誤りがあります:');
  for (const e of flagErrors) console.error('  ・' + e);
  console.error('\n何も消していません。');
  process.exit(1);
}

// results の場所は tools/lib/resolve-results-dir.cjs に集めてある
// （配布された ops から実行すると ops/results を見てしまい、当日動かなかった）
const resolvedResults = resolveResultsDir(ROOT);
const resultsDir = resolvedResults.dir;

/** dist から PNG の完全性判定を借りる（アプリと同じ判定を使う） */
const loadVerifier = () => {
  const p = path.join(ROOT, 'dist', 'main', 'main', 'services', 'png-integrity.js');
  if (!fs.existsSync(p)) {
    throw new Error(`dist が見つかりません。先に \`npm run build\` を実行してください: ${p}`);
  }
  return require(p);
};

const human = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const main = async () => {
  if (!fs.existsSync(resultsDir)) {
    console.error(describeMissing(resolvedResults));
    process.exit(1);
  }
  const { verifyPngFile } = loadVerifier();

  console.log(`[purge] 対象      : ${resultsDir}`);
  console.log(`[purge] モード    : ${APPLY ? '実行（消します）' : 'ドライラン（表示のみ）'}`);
  if (INCLUDE_INCOMPLETE) {
    console.log('[purge] ⚠️ --include-incomplete : カードが未完成の回も消します（再生成できなくなります）');
  }

  const dirs = (await fsp.readdir(resultsDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^\d{8}_\d{6}$/.test(e.name))
    .map((e) => e.name)
    .filter((name) => !ONLY || name === ONLY)
    .sort();

  if (dirs.length === 0) {
    console.log('[purge] 対象の回がありません');
    return;
  }

  const targets = [];
  const skipped = [];

  for (const dt of dirs) {
    const dir = path.join(resultsDir, dt);
    const photo = `photo_${dt}.png`;
    const photoPath = path.join(dir, photo);
    if (!fs.existsSync(photoPath)) continue; // すでに消えている

    const cardPath = path.join(dir, `memorial_card_${dt}.png`);
    let reason = null;
    if (!fs.existsSync(cardPath)) {
      reason = '正規カードがまだ無い';
    } else {
      // 実体の中身まで見る。上半分だけのカードで「完成」と見なすと写真を失う
      const check = await verifyPngFile(cardPath);
      if (check.status === 'corrupt') reason = `カードが壊れている（${check.error}）`;
      // 🔴 unknown（読めなかった）を完成扱いにしてはいけない。
      // ロック・ウイルス対策・同期の干渉で読めないことは普通に起きるが、
      // **半端なカードの写真を先に消すと、あとから作り直せない**。
      // retry-failed.cjs は同じ unknown を「触らない」として厳格に扱っており、
      // 2つのツールで判断が真逆になっていた（敵対的レビュー 2026-09-09 の指摘）。
      // どうしても消したい場合だけ --include-unverified を要求する。
      else if (check.status === 'unknown' && !INCLUDE_UNVERIFIED) {
        reason = `カードを確かめられなかった（${check.error || '読み取り失敗'}）`;
      }
    }

    const size = (await fsp.stat(photoPath)).size;
    if (reason && !INCLUDE_INCOMPLETE) {
      skipped.push({ dt, reason, size });
      continue;
    }
    targets.push({ dt, dir, photo, photoPath, size, reason });
  }

  console.log('');
  if (skipped.length) {
    console.log(`[purge] 見送り（${skipped.length}件）: カードが完成していないので写真を残します`);
    for (const s of skipped) console.log(`   ${s.dt}  ${s.reason}`);
    console.log('   → 先に `node tools/retry-failed.cjs --apply` で作り直してください');
    console.log('');
  }

  if (targets.length === 0) {
    console.log('[purge] 消せる写真はありません');
    return;
  }

  const total = targets.reduce((a, t) => a + t.size, 0);
  console.log(`[purge] 対象 ${targets.length} 件 / 合計 ${human(total)}`);
  for (const t of targets) {
    console.log(`   ${t.dt}  ${t.photo}  ${human(t.size)}${t.reason ? `  ⚠️ ${t.reason}` : ''}`);
  }

  if (!APPLY) {
    console.log('');
    console.log('[purge] ドライランなので何も消していません。消すには --apply を付けてください');
    // ドライランでも ComfyUI 側の件数は見せる（何が残っているかを知るため）
    await purgeComfyUIScratch();
    return;
  }

  // 🔴 **消す前に保守ロックを取る。**
  // retry-failed が写真を ComfyUI へ上げ直している最中（1枚3分）に、別の人が
  // このツールを --apply で叩くと、読み込む直前に写真が消えて ENOENT になる。
  // retry-failed はロックを取るのに、こちらは見ていなかったので防波堤が
  // 片側しか無かった（敵対的レビュー 2026-09-09 の指摘）。
  const cardOutputPath = path.join(ROOT, 'dist', 'main', 'main', 'services', 'card-output.js');
  let releaseLock = null;
  if (fs.existsSync(cardOutputPath)) {
    // eslint-disable-next-line global-require
    const { acquireMaintenanceLock } = require(cardOutputPath);
    releaseLock = await acquireMaintenanceLock(resultsDir);
    if (!releaseLock) {
      console.error('');
      console.error('[purge] 別のプロセスが results/ を保守中です（アプリの起動時点検や作り直し）。');
      console.error('        写真を消すのは待ってください。何も消していません。');
      console.error('        ＊ 誰も動いていないのに出る場合は、アプリを stop-kidspg.bat で止めてから');
      console.error('          node tools/retry-failed.cjs --force-unlock --apply を一度実行してください');
      process.exitCode = 1;
      return;
    }
    // Ctrl-C で抜けたときにロックを残さない
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.once(sig, async () => {
        try { await releaseLock(); } catch { /* 解放できなくても終了する */ }
        process.exit(130);
      });
    }
  } else {
    console.error('[purge] dist が無いため保守ロックを取れません。排他なしで続行します');
  }

  console.log('');
  let done = 0;
  let freed = 0;
  for (const t of targets) {
    try {
      // result.json が写真を指しているなら参照も外す。
      // 実体の無いパスを残すと、後日のカード公開ツールがそこを読もうとする
      const resultPath = path.join(t.dir, 'result.json');
      if (fs.existsSync(resultPath)) {
        try {
          const data = JSON.parse(await fsp.readFile(resultPath, 'utf-8'));
          if (data.imagePath === t.photo) {
            delete data.imagePath;
            data.photoPurgedAt = new Date().toISOString();
            const tmp = `${resultPath}.${process.pid}-${Date.now()}.tmp`;
            await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
            await fsp.rename(tmp, resultPath);
          }
        } catch (error) {
          // result.json が壊れていても写真の削除は続ける（消すのが目的）
          console.warn(`   ${t.dt} result.json を更新できませんでした: ${error.message}`);
        }
      }
      await fsp.unlink(t.photoPath);
      done += 1;
      freed += t.size;
    } catch (error) {
      console.error(`   ${t.dt} 削除に失敗: ${error.message}`);
    }
  }
  console.log(`[purge] 完了: ${done} 件 / ${human(freed)} を解放しました`);
  if (done < targets.length) {
    console.log(`[purge] ⚠️ ${targets.length - done} 件は消せませんでした（上のエラーを確認してください）`);
  }

  // 🔴 **ロックを返す前に ComfyUI 側も片付ける。** 解放してから消すと、
  // 枠の合間に叩いたときに生成中の子の input や、まだ /view で取っていない
  // output を消せてしまう（その子のカードはプレースホルダに倒れる。
  // 敵対的レビュー 2026-09-09 の指摘）。
  await purgeComfyUIScratch();

  // 取ったロックは必ず返す（残すとアプリの起動時点検が毎回飛ばされる）
  if (releaseLock) { try { await releaseLock(); } catch { /* 解放できなくても続ける */ } }
};

/**
 * ComfyUI の作業用の置き場（input/ output/）を空にする。
 * 🔴 results を消しても**ここに同じ顔写真の完全なコピーが残る**ため、
 * 個人情報の始末としては必須（上の注釈を参照）。
 */
const purgeComfyUIScratch = async () => {
  console.log('');

  // 🔴 **別のツリーを指されたら、このPCの ComfyUI は触らない。**
  // ComfyUI の場所はリポジトリの config.json から解決するので、
  // `KIDSPG_RESULTS_DIR` で別の results（後日の作業用コピー、テストの
  // 一時フォルダ）を指されたときにここを消すと、**関係のない
  // 開発機の資材を消す**ことになる。
  // 実際に `tools/test-purge-photos.cjs` が `--apply` を10回近く走らせるため、
  // `npm test`／`npm run check`／パッケージ作成のたびに
  // 開発機の ComfyUI の input/output が消えていた（2026-09-09 に実害を確認:
  // input 43件・output 51件が消えた。results 側の原本は無事だった）。
  // 「自分で解決した results」＝同じ置き場のものだけを後始末の対象にする。
  if (process.env.KIDSPG_RESULTS_DIR) {
    console.log('[purge] ComfyUI の input/output は触りません（KIDSPG_RESULTS_DIR で別のツリーを指しているため）');
    console.log('        このPCの ComfyUI を片付けるなら、環境変数を外して実行してください');
    return;
  }
  // `--only` は「その回だけ」の指定。ComfyUI の作業用の置き場は回ごとに
  // 分かれていないので、一括で消すとほかの回の作り直しに影響する
  if (ONLY) {
    console.log('[purge] ComfyUI の input/output は触りません（--only は回ごとの指定のため）');
    return;
  }
  if (KEEP_COMFYUI) {
    console.log('[purge] ComfyUI の input/output は --keep-comfyui が指定されたので触りません');
    console.log('        🔴 生の顔写真が残ります。持ち帰る前に必ず消してください');
    return;
  }

  // config.json は app 側にある（配布形では ops から実行するため隣を見る）
  const candidates = [
    path.join(ROOT, 'config.json'),
    path.join(ROOT, '..', 'app', 'config.json'),
  ];
  const configPath = candidates.find((c) => fs.existsSync(c));
  if (!configPath) {
    console.log('[purge] ComfyUI の場所が分かりません（config.json が見つかりません）。探した場所:');
    for (const c of candidates) console.log('        ' + c);
    return;
  }
  const resolved = resolveComfyUIRoot(configPath);
  const { root, from } = resolved;
  if (!root) {
    console.log(`[purge] ComfyUI の場所が分かりません（${from}）。input/output は触りません`);
    console.log('        🔴 AI 変換を使っていた場合、生の顔写真が残っている可能性があります');
    return;
  }

  // paths.input / paths.output の個別指定にも従う（comfyui-scratch.cjs の注釈）
  const groups = listScratchFiles(root, { input: resolved.input, output: resolved.output });
  const all = groups.flatMap((g) => g.files);
  console.log(`[purge] ComfyUI の作業用の置き場 : ${root}  (${from})`);
  for (const g of groups) {
    const note = g.symlink
      ? ' … リンクなので触りません'
      : g.missing
        ? ' … フォルダがありません'
        : '';
    console.log(
      `        ${g.name}\\ : ${g.files.length} 件 / ` +
        `${human(g.files.reduce((a, f) => a + f.size, 0))}${note}`
    );
  }
  // 🔴 **「掴み損ねた」を「空です」と言わない。** 場所を間違えたときに
  // 片付いたと読めるのがいちばん危ない（敵対的レビュー 2026-09-09 の指摘）。
  if (groups.every((g) => g.missing)) {
    console.log('        🔴 4つのフォルダがどれも見つかりません。場所が違う可能性があります');
    console.log('           生の顔写真が残っているかもしれないので、手で確認してください');
    return;
  }
  if (all.length === 0) {
    console.log('        すでに空です');
    return;
  }
  if (!APPLY) {
    console.log('        ドライランなので消していません（--apply を付けてください）');
    return;
  }

  let removed = 0;
  let bytes = 0;
  for (const f of all) {
    try {
      await fsp.unlink(f.path);
      removed += 1;
      bytes += f.size;
    } catch (error) {
      console.error(`        削除に失敗: ${f.path} (${error.message})`);
    }
  }
  console.log(`        消しました: ${removed} 件 / ${human(bytes)}`);
  if (removed < all.length) {
    console.log(`        ⚠️ ${all.length - removed} 件は消せませんでした（ComfyUI が使用中かもしれません）`);
  }
};

main().catch((error) => {
  console.error('[purge] 失敗:', error.message);
  process.exit(1);
});
