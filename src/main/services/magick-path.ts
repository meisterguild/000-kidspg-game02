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
  /**
   * magick.exe のあるフォルダ。PATH 任せのときは null。
   * コーダー（PNG などを読み書きする DLL）の置き場をここから決める。
   */
  home: string | null;
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
      return { command: fromEnv, from: 'KIDSPG_MAGICK', searched, home: path.dirname(fromEnv) };
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
        return { command: candidate, from: 'portable', searched, home: path.dirname(candidate) };
      }
    }
  }

  return { command: 'magick', from: 'PATH', searched, home: null };
};

/**
 * 携帯版の ImageMagick が**自分の部品を見つけられる**ようにする。
 *
 * ■ 何が起きていたか（当日PCで実測 2026-09-10）
 * 🔴 インストール版の ImageMagick は、PNG などを読み書きする**コーダー DLL**
 * （`modules\coders\IM_MOD_RL_png_.dll` など）の置き場を
 * **Windows のレジストリ**から引く。インストーラがそのキーを書くためで、
 * フォルダをコピーしただけの当日PCにはキーが無い。その結果:
 *
 *   magick.exe: RegistryKeyLookupFailed `CoderModulesPath'
 *   magick.exe: no decode delegate for this image format `...bg-card-rank-05-veteran.png'
 *
 * となり、**記念カードが1枚も作られなかった**（画像生成は成功していたのに、
 * ランキングは「じゅんび中」のまま）。
 *
 * 🔴 しかも点検が `magick -version` だったため**この状態でも通り**、
 * 起動バッチは「★★★ 準備完了 ★★★」と表示していた——
 * いちばん危ない壊れ方をそのまま通していた。
 *
 * ■ 直し方
 * 環境変数はレジストリより優先される（実測: 誤ったパスを指すと
 * インストール済みの開発機でも同じエラーを再現できた）。
 * magick.exe の隣から置き場を決めて入れる。子プロセスは process.env を
 * 受け継ぐので、ここで入れておけば合成のときも効く。
 *
 * @returns 設定した内容（ログに出す用）。PATH 任せのときは空
 */
export const applyMagickEnvironment = (resolution: MagickResolution): string[] => {
  const home = resolution.home;
  if (!home) return [];

  const applied: string[] = [];
  const set = (name: string, value: string): void => {
    process.env[name] = value;
    applied.push(name + '=' + value);
  };

  // コーダーが本体。これが無いと PNG を1枚も読めない
  const coders = path.join(home, 'modules', 'coders');
  if (fs.existsSync(coders)) set('MAGICK_CODER_MODULE_PATH', coders);
  // フィルタ（-resize の一部が使う）
  const filters = path.join(home, 'modules', 'filters');
  if (fs.existsSync(filters)) set('MAGICK_FILTER_MODULE_PATH', filters);
  // colors.xml / delegates.xml / type.xml などの置き場。同じフォルダにある
  if (fs.existsSync(path.join(home, 'colors.xml'))) set('MAGICK_CONFIGURE_PATH', home);
  set('MAGICK_HOME', home);

  return applied;
};

/**
 * ImageMagick が**実際に PNG を扱えるか**を確かめるための引数。
 *
 * 🔴 **`-version` で確かめてはいけない。** コーダーを読み込まないので、
 * 上の状態（コーダーが見つからない）でも成功する。実測で確認済み。
 * これは 4×4 の画像を作って PNG として書き出すので、
 * XC と PNG の両方のコーダーが読めないと失敗する。
 */
export const MAGICK_PROBE_ARGS = ['-size', '4x4', 'xc:white', 'PNG:-'];

/** spawn へ渡すコマンドだけが欲しいとき */
export const resolveMagickCommand = (searchRoots: string[] = []): string =>
  resolveMagick(searchRoots).command;
