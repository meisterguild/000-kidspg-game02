/**
 * 同梱アセット（効果音・画像）の実ファイルを探す。
 *
 * ■ なぜ要るのか（敵対的レビュー 2026-09-09 の指摘）
 * 🔴 **`app.isPackaged` で分岐してはいけない。**
 * 当日PC への配り方は「electron 本体で dist を読ませる」形（exe は作らない。
 * 理由は docs/distribution-plan.md）。この形は
 *   ・`app.isPackaged === false`（＝コードから見れば「開発環境」）
 *   ・しかし `src/` は配っていない
 * という**どちらの分岐にも当てはまらない**状態になる。
 * 以前はここで `isPackaged` を見て開発側の枝に入り、
 * `<app>\src\renderer\assets\sounds\bell.mp3` という存在しないパスを
 * そのまま返していた。開発機には `src/` があるので通ってしまい、
 * **当日PC でだけ効果音10個とタイトル画像が全滅する**という壊れ方になる。
 *
 * だから「どの形か」を推測せず、**実際にあるものを上から順に探す**。
 *
 * ■ 探す順（relativePath は "assets/sounds/bell.mp3" の形で来る）
 *   1. `<dist/main/main>/../../renderer/assets/<ファイル名>`
 *      … Vite が出す平坦配置。パッケージ版でも配布形でもここにある
 *   2. `<bundleRoot>/dist/renderer/assets/<ファイル名>`  … 1 と同じ場所を別経路で
 *   3. `<bundleRoot>/assets/<ファイル名>`  … 配布物の app/assets（dummy_photo.png など）
 *   4. `<bundleRoot>/src/renderer/<relativePath>`  … 開発機のソース
 *   5. `<exe のフォルダ>/resources/<relativePath>`  … 昔のパッケージ版
 *
 * ⚠️ `dist/renderer/assets/` は**平坦**（`images/` や `sounds/` の階層が無い）。
 * だから探すときはファイル名だけを使う。
 */

import * as fs from 'fs';
import * as path from 'path';

export interface AssetLocation {
  /** 見つかった絶対パス。見つからなければ null */
  path: string | null;
  /** 探した場所。見つからないと言うときに全部見せる */
  searched: string[];
}

export interface AssetRoots {
  /** config.json や assets を置いた基準（app.isPackaged ? exe のフォルダ : app.getAppPath()） */
  bundleRoot: string;
  /** コンパイル済み main のフォルダ（`__dirname`） */
  mainDir: string;
  /** exe のフォルダ（パッケージ版のときだけ意味がある） */
  exeDir?: string;
}

export const locateAsset = (relativePath: string, roots: AssetRoots): AssetLocation => {
  // "assets/sounds/bell.mp3" → "bell.mp3"
  const fileName = relativePath.replace(/^assets\/(sounds|images)\//, '').replace(/^assets\//, '');

  const candidates = [
    path.resolve(roots.mainDir, '..', '..', 'renderer', 'assets', fileName),
    path.resolve(roots.bundleRoot, 'dist', 'renderer', 'assets', fileName),
    path.resolve(roots.bundleRoot, 'assets', fileName),
    path.resolve(roots.bundleRoot, 'src', 'renderer', relativePath),
    ...(roots.exeDir ? [path.resolve(roots.exeDir, 'resources', relativePath)] : []),
  ];

  const searched: string[] = [];
  for (const candidate of candidates) {
    searched.push(candidate);
    try {
      if (fs.statSync(candidate).isFile()) return { path: candidate, searched };
    } catch {
      // 次の候補へ
    }
  }
  return { path: null, searched };
};
