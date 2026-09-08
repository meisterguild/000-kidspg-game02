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
 * **毎回この写真を ComfyUI へ上げ直す**（ComfyUI の input は再起動で消えるため）。
 * 写真を消した回は、あとから AI 画像を作り直せない。
 * そのため既定では「カードが完成している回」だけを対象にする。
 * 未完成の回まで消したいときだけ --include-incomplete を付ける。
 *
 * ■ 壊さないための約束（retry-failed.cjs と同じ）
 *   ・既定はドライラン。--apply を付けたときだけ消す
 *   ・カードの完成を PNG の中身まで見て確かめる（png-integrity）
 *   ・result.json が写真を指している場合は参照も外す（実体の無いパスを残さない）
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const APPLY = has('apply');
const INCLUDE_INCOMPLETE = has('include-incomplete');
const ONLY = flag('only');

const resultsDir = process.env.KIDSPG_RESULTS_DIR
  ? path.resolve(process.env.KIDSPG_RESULTS_DIR)
  : path.join(ROOT, 'results');

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
    console.error(`results フォルダがありません: ${resultsDir}`);
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
      // unknown（読めなかった）は OneDrive 同期などで普通に起きるので完成扱いにする
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
    return;
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
};

main().catch((error) => {
  console.error('[purge] 失敗:', error.message);
  process.exit(1);
});
