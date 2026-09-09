/**
 * `magick`（ImageMagick）の実行ファイルの場所を決める。
 *
 * ■ なぜ要るのか（敵対的レビュー 2026-09-09 の指摘）
 * 🔴 **`magick` を PATH 前提で呼んではいけない。** 当日PC の ImageMagick は
 * インストールせず `C:\kidspg\bin\ImageMagick\` に置いた携帯版で、PATH には入らない。
 * 起動バッチは自分の PATH の先頭に足しているが、**アプリはそれを受け取れない**——
 * アプリは `Win32_Process.Create`（WMI）で起こしており、
 * この呼び方は呼び出し元の環境変数を一切受け継がないため
 * （同じ理由で ComfyUI 側の `OMP_NUM_THREADS` も届いていなかった。
 * バッチの `:launch_detached` にその実測が書いてある）。
 *
 * 結果として当日PC では `spawn('magick')` が ENOENT になり、
 * **記念カードが1枚も作られない**。しかもそれは `ready.json` に載らないので、
 * 起動バッチは「★★★ 準備完了 ★★★」と表示する——いちばん危ない壊れ方。
 *
 * ■ 決め方（上から順に）
 *   1. 環境変数 `KIDSPG_MAGICK`（明示したいとき・テスト）
 *   2. 渡されたルートの `bin\ImageMagick\magick.exe`
 *   3. 渡されたルートの `..\bin\ImageMagick\magick.exe`（当日PC: app の隣が bin）
 *   4. `magick`（PATH に任せる。開発機はインストール済み）
 *
 * 4 に落ちるのは「開発機」か「本当に無い」のどちらか。無い場合は spawn が
 * ENOENT で失敗するので、呼び出し側がその理由を表示できるようにする。
 *
 * ⚠️ electron を import しないこと。この関数は救済ツール（素の node で動く）からも使う。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 携帯版 ImageMagick を探す相対の並び。当日PC は `<app>\..\bin\ImageMagick` */
const PORTABLE_RELATIVE = [
  ['bin', 'ImageMagick', 'magick.exe'],
  ['..', 'bin', 'ImageMagick', 'magick.exe'],
];

export interface MagickResolution {
  /** spawn に渡すコマンド。絶対パスか、PATH に任せる 'magick' */
  command: string;
  /** どうやって決めたか。ログと点検の表示に使う */
  from: 'KIDSPG_MAGICK' | 'portable' | 'PATH';
  /** 探した場所。見つからないと言うときに全部見せる */
  searched: string[];
}

export const resolveMagick = (searchRoots: string[] = []): MagickResolution => {
  const searched: string[] = [];

  const fromEnv = process.env.KIDSPG_MAGICK;
  if (fromEnv) {
    searched.push(fromEnv);
    // 🔴 **existsSync だけでは足りない。** フォルダを渡されると受理してしまい、
    //    spawn が失敗して「ImageMagick を起動できません（…\Temp）」という
    //    意味の分からない blocker になる。逆に**存在しないパスを渡すと
    //    黙って PATH へ落ち**、明示した設定が無視されたことがどこにも出ない
    //    （敵対的レビュー 2026-09-09 の指摘）。
    let isFile = false;
    try {
      isFile = fs.statSync(fromEnv).isFile();
    } catch {
      isFile = false;
    }
    if (isFile) {
      return { command: fromEnv, from: 'KIDSPG_MAGICK', searched };
    }
    console.warn(
      '[ImageMagick] KIDSPG_MAGICK が実行ファイルを指していません（無視して探し直します）: ' + fromEnv
    );
  }

  for (const root of searchRoots) {
    for (const rel of PORTABLE_RELATIVE) {
      const candidate = path.resolve(root, ...rel);
      searched.push(candidate);
      if (fs.existsSync(candidate)) {
        return { command: candidate, from: 'portable', searched };
      }
    }
  }

  return { command: 'magick', from: 'PATH', searched };
};

/** spawn へ渡すコマンドだけが欲しいとき */
export const resolveMagickCommand = (searchRoots: string[] = []): string =>
  resolveMagick(searchRoots).command;
