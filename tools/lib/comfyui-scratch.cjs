/**
 * ComfyUI が作業用に使う input/ と output/ の中身を数える・消す。
 *
 * ■ なぜ要るのか（敵対的レビュー 2026-09-09 の指摘）
 * 🔴 **当日PCの ComfyUI に、参加した子ども全員の生の顔写真が溜まる。**
 * アプリは `/upload/image` で写真を上げるので `<ComfyUI>\input\` に
 * 撮ったままの顔写真が残り、ワークフローに SaveImage があるので
 * `<ComfyUI>\output\` に変換後の絵が残る。にもかかわらず、
 * 起動バッチ・停止バッチ・`start-comfyui.bat`・`purge-photos.cjs` の
 * どれもこれを消していなかった。
 *
 * さらに `purge-photos.cjs` の説明は「ComfyUI の input は再起動で消えるため」と
 * 書いていたが、**そうなる仕組みはどこにも無い**。実測（2026-09-09、開発機で
 * 何度も再起動したあと）で input に 44 件、output に 51 件が残っていた。
 * つまり `purge-photos --apply` で results の顔写真を消しても、
 * **同じ写真の完全なコピーが ComfyUI 側に残る**。
 * しかもパッケージが書き出す `start-comfyui.bat` は
 * 「持ち帰りは丸ごとコピーだけ」と案内しているので、その通りにすると
 * 顔写真がそのまま持ち出される。
 *
 * ■ 消してよい理由
 * ComfyUI の input/output は**作業用の置き場**で、成果物は results/ 側にある。
 * 作り直し（tools/retry-failed.cjs のパターンA）は毎回 results の写真を
 * 上げ直すので、ここを空にしても作り直しはできる。
 *
 * ■ 消してはいけないもの
 * 🔴 `input` / `output` という名前のフォルダは ComfyUI のソースの中にもある
 * （`comfy_api\input` など）。**トップレベルの input/ output/ だけ**を対象にする。
 * また `input/3d` のようなサンプルのサブフォルダは触らない（ファイルだけ消す）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** 作業用の置き場。ComfyUI のルート直下のこの2つだけ */
const SCRATCH_DIRS = ['input', 'output'];

/**
 * config.json から ComfyUI のルートを解決する。
 * アプリ本体と同じ流儀（プロファイル側の paths が優先、無ければ共通側）。
 *
 * @param {string} configPath
 * @returns {{ root: string|null, from: string }}
 */
const resolveComfyUIRoot = (configPath) => {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const comfy = config.comfyui;
    if (!comfy) return { root: null, from: 'config.json に comfyui がありません' };
    const profile = comfy.profiles?.[comfy.activeProfile];
    const paths = profile?.paths ?? comfy.paths;
    if (!paths?.root) {
      return { root: null, from: `プロファイル ${comfy.activeProfile} に paths.root がありません` };
    }
    return { root: path.resolve(paths.root), from: `config.json (${comfy.activeProfile})` };
  } catch (error) {
    return { root: null, from: `config.json を読めません: ${error.message}` };
  }
};

/**
 * 作業用の置き場にあるファイルを列挙する（サブフォルダは辿らない）。
 * @param {string} comfyRoot
 * @returns {{ dir: string, files: {path: string, size: number}[] }[]}
 */
const listScratchFiles = (comfyRoot) =>
  SCRATCH_DIRS.map((name) => {
    const dir = path.join(comfyRoot, name);
    const files = [];
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        // サブフォルダ（input/3d のようなサンプル）は触らない
        if (!entry.isFile()) continue;
        const full = path.join(dir, entry.name);
        try {
          files.push({ path: full, size: fs.statSync(full).size });
        } catch {
          // 消えていてもよい
        }
      }
    } catch {
      // フォルダが無いのは正常（まだ一度も生成していない）
    }
    return { dir, files };
  });

module.exports = { SCRATCH_DIRS, resolveComfyUIRoot, listScratchFiles };
