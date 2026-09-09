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

/**
 * 作業用の置き場。
 *
 * 🔴 **4つ揃えること。** onsite-package-lib.cjs の FORBIDDEN_LOCATIONS は
 * input / output / temp / user を「持ち出してはいけない場所」として挙げ、
 * build-materials.ps1 も4つを空にする。にもかかわらずここだけ2つで、
 * **自分たちが危険と認めた場所の半分が未処理**だった
 * （敵対的レビュー 2026-09-09 の指摘）。
 *   temp/ … PreviewImage のプレビュー画像が溜まる
 *   user/ … comfyui.db に開いたワークフローと**入力画像名の履歴**が入る
 */
const SCRATCH_DIRS = ['input', 'output', 'temp', 'user'];

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
    // 🔴 **paths.input / paths.output も見る。** config は個別指定できる仕様で、
    //    アプリ本体（comfyui-config.ts）は使い分けている。root 決め打ちだと
    //    出力先を別の場所へ向けた構成で顔写真が残る
    //    （敵対的レビュー 2026-09-09 の指摘）。
    // 🔴 root は絶対パス前提（相対だと実行場所によって別の場所を掴む）。
    //    comfyui-config.ts も相対の root は使わずに警告へ回している。
    const root = paths.root;
    if (!path.isAbsolute(root)) {
      return { root: null, from: `paths.root が絶対パスではありません: ${root}` };
    }
    const resolveUnder = (value) => {
      if (!value) return null;
      return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
    };
    return {
      root: path.resolve(root),
      input: resolveUnder(paths.input),
      output: resolveUnder(paths.output),
      from: `config.json (${comfy.activeProfile})`,
    };
  } catch (error) {
    return { root: null, from: `config.json を読めません: ${error.message}` };
  }
};

/**
 * 作業用の置き場にあるファイルを列挙する（サブフォルダは辿らない）。
 * @param {string} comfyRoot
 * @returns {{ dir: string, files: {path: string, size: number}[] }[]}
 */
const listScratchFiles = (comfyRoot, overrides = {}) => {
  // 個別指定があればそこを、無ければルート直下を見る
  const dirs = SCRATCH_DIRS.map((name) => ({ name, dir: overrides[name] || path.join(comfyRoot, name) }));
  return dirs.map(({ name, dir }) => {
    const files = [];
    let missing = false;
    try {
      // 🔴 **ジャンクション／シンボリックリンクを辿らない。** input 自体が
      //    別の場所へのリンクだと、readdirSync はリンク先を列挙するので
      //    **関係のないフォルダを消す**ことになる。実体かどうかを見る。
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink()) {
        return { name, dir, files: [], missing: false, symlink: true };
      }
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
      // フォルダが無いのは正常（まだ一度も生成していない）。
      // ただし「掴み損ねた」と区別できるよう印を返す——区別しないと
      // 場所を間違えたときに「すでに空です」と誤って言う
      // （敵対的レビュー 2026-09-09 の指摘）。
      missing = true;
    }
    return { name, dir, files, missing, symlink: false };
  });
};

module.exports = { SCRATCH_DIRS, resolveComfyUIRoot, listScratchFiles };
