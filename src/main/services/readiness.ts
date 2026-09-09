/**
 * 「準備OK」の印をファイルに残す。
 *
 * ■ 何のためか
 * 当日の運用は「モニタとPCを置く → 電源 → 起動バッチを叩く → 準備完了」だけにしたい。
 * ところが起動バッチは**アプリを起こしたところまでしか見ていなかった**ため、
 * 起動に失敗しても「起動しました／問題なし」と表示できてしまう。
 * 画面が出ていないことに気づけるのは、スタッフがモニタを見たときだけだった。
 *
 * そこで**アプリ自身に「ここまで来た」と書かせる**。書くのは画面が実際に描かれ、
 * カメラの初期化まで終わってから（renderer から `app-ready` で報告が来たとき）。
 * 起動バッチはこのファイルが現れるのを待つので、「準備完了」が推測ではなく実測になる。
 *
 * ■ 古い印を信じないための決めごと
 * 🔴 **起動時に必ず消す。** 前回の印が残っていると、今回起動に失敗しても
 * バッチが即座に「準備OK」と言ってしまう——いちばん危ない壊れ方なので、
 * 消してから起こす（バッチ側でも消しているが、片方に頼らない）。
 * 終了時にも消す。
 *
 * ■ 置き場所
 * `<アプリのフォルダ>/logs/ready.json`。ComfyUI のログと同じ場所に置くのは、
 * 当日「様子を見るならこのフォルダ」を1つに絞るため。
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/** renderer が報告してくる、画面側の準備状況 */
export interface RendererReadiness {
  /** 背景アセットの読み込みが終わったか */
  assetsLoaded: boolean;
  /** カメラの初期化が終わったか（失敗して確定した場合も true） */
  cameraReady: boolean;
  /** カメラが見つからず、ダミー写真モードで動いているか */
  usingDummyCamera: boolean;
  /** 最初に表示している画面（ふつうは top） */
  screen: string;
}

/** ready.json の中身 */
export interface ReadinessReport extends RendererReadiness {
  readyAt: string;
  /**
   * config.json を読めたか。
   * 🔴 **これが false だと遊べない。** 読めないと画面は TOP まで出るが、
   * ゲーム画面は永久に「読み込み中」で止まり、記念カードも1枚も作られない。
   * それでも TOP が描けてしまうため renderer は「準備できた」と報告し、
   * さらに comfyui が null になって
   * 「ComfyUI の設定がありません（意図した構成なら問題ありません）」という
   * **正反対の注意書き**だけが出ていた（敵対的レビュー 2026-09-09 の指摘）。
   */
  configLoaded: boolean;
  /**
   * 記念カードの合成が使える見込みか。
   * 🔴 **false だとカードが1枚も作られない。** results に書けない場合と
   * 結果は同じなので、同じ重さ（blocker）で扱う。
   * 当日PC の ImageMagick は PATH に無い携帯版で、しかもアプリは
   * WMI 経由で起こされるため起動バッチの PATH を受け取れない
   * （services/magick-path.ts の注釈）。ここに載せないと
   * 「準備完了と言われたのにカードが0枚」に当日まで気づけない。
   */
  memorialCard: {
    /** config の memorialCard.enabled が真で、サービスを組めたか */
    ready: boolean;
    /** 実際に使う magick の場所。'magick' なら PATH 任せ */
    magickCommand: string;
    /** magick を起動できたか */
    magickUsable: boolean;
  };
  appVersion: string;
  /** 実行の形。electron 本体で dist を読んでいるのか、パッケージ版の exe か */
  packaged: boolean;
  pid: number;
  comfyui: {
    profile: string;
    baseUrl: string;
    /** 疎通できたか。false でもゲームは動く（カードの絵はプレースホルダになる） */
    healthy: boolean;
  } | null;
  results: {
    dir: string;
    /** 書き込めるか。ここが false だとカードも results.json も残らない */
    writable: boolean;
  };
  /**
   * 🔴 **これがあると遊べない。** 起動バッチは「準備できていません」と出す。
   * 例: results に書けない（カードが1枚も残らない）・画面の素材が読めていない
   */
  blockers: string[];
  /**
   * ⚠️ **遊べるが当日困ること。** 起動バッチは
   * 「準備完了（ただし気になる点が N 件）」と出す。
   * 例: カメラが無い（全員ダミー写真）・ComfyUI が落ちている（絵が全員同じ）
   *
   * ■ なぜ分けるのか（敵対的レビュー 2026-09-09 の指摘）
   * 以前は両方を warnings ひとつにまとめ、**1件でもあれば「準備できていません」**に
   * していた。そのため
   *   ・カメラを挿し忘れただけ／ComfyUI が落ちただけ、という**遊べる状態**で
   *     開場を止めることになる（しかも当日手順書はその2つを
   *     「遊べるが困る」例として挙げていた＝文書と実装が逆）
   *   ・退避策（config.json の comfyui を外して AI 変換を切る）を採った瞬間に
   *     「準備できていません」と出て、**意図した構成が異常扱い**になる
   * という二重の逆転が起きていた。
   */
  notes: string[];
}

export const readinessFilePath = (baseDir: string): string =>
  path.join(baseDir, 'logs', 'ready.json');

/**
 * 準備OKの印を消す。起動時と終了時に呼ぶ。
 * 消せなかった場合は理由を返すだけで例外にしない（印が無いことより、
 * 消せないことを理由にアプリが起動しないほうが困る）。
 */
export const clearReadiness = async (baseDir: string): Promise<void> => {
  try {
    await fs.unlink(readinessFilePath(baseDir));
  } catch (error) {
    // 無ければそれでよい
    // NodeJS 名前空間は eslint の設定で見えないので、必要な形だけを言う
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT') {
      console.warn('[準備確認] 前回の ready.json を消せませんでした:', error);
    }
  }
};

/** results に本当に書けるかを、実際に書いて確かめる（権限と空き容量の両方を見る） */
export const checkResultsWritable = async (resultsDir: string): Promise<boolean> => {
  const probe = path.join(resultsDir, '.write-probe');
  try {
    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
    return true;
  } catch (error) {
    console.error('[準備確認] results に書き込めません:', resultsDir, error);
    return false;
  }
};

/**
 * 集めた事実を「遊べないこと（blockers）」と「遊べるが困ること（notes）」に分ける。
 *
 * ■ ここの分け方が当日の運用判断そのもの
 * 当日手順書は「★★★ 準備完了 ★★★ が出たら受付を開けてよい」と約束している。
 * だから **blockers に入れるのは「本当に遊べないもの」だけ**にする。
 * 遊べるのに開場を止めると、回復手段が無いまま列が止まる。
 * 逆に「動くけれど当日困ること」を黙って通すと、カメラが無い（全員ダミー写真）や
 * ComfyUI が落ちている（全員同じ絵）に気づかないまま開場してしまう。
 * だから notes として**必ず見せる**が、開場は止めない。
 */
export const classifyReadiness = (
  report: Omit<ReadinessReport, 'blockers' | 'notes'>
): { blockers: string[]; notes: string[] } => {
  const blockers: string[] = [];
  const notes: string[] = [];

  // --- 遊べないもの ---
  if (!report.configLoaded) {
    // 🔴 いちばん危ない壊れ方だった。TOP は描けるので renderer は準備完了と言い、
    //    comfyui が null になるので「意図した構成なら問題ありません」が出ていた
    blockers.push(
      'config.json を読み込めていません。ゲーム画面が「読み込み中」で止まり、' +
        'カードも1枚も作られません（JSON の壊れ・コピー漏れを確認してください）'
    );
  }
  if (!report.memorialCard.ready) {
    blockers.push(
      '記念カードの設定がありません（config.json の memorialCard）。' +
        'カードが1枚も作られません'
    );
  } else if (!report.memorialCard.magickUsable) {
    blockers.push(
      'ImageMagick を起動できません（' + report.memorialCard.magickCommand + '）。' +
        'カードが1枚も作られません。当日PCでは bin\\ImageMagick\\magick.exe を使います'
    );
  }
  if (!report.results.writable) {
    // カードも results.json も残らない。遊ばせても何も持ち帰れない
    blockers.push(
      'results に書き込めません（' + report.results.dir + '）。カードが1枚も残りません'
    );
  }
  if (!report.assetsLoaded) {
    // 画面の背景やカードの素材が欠けている＝コピーが不完全
    blockers.push(
      '背景アセットを読み込めていません（画面の背景やカードの素材が欠けている可能性）。' +
        'コピーが不完全かもしれません'
    );
  }
  if (!report.cameraReady) {
    // 「カメラが無い」とは違う。**初期化が決着していない**＝撮影画面で止まりうる
    blockers.push(
      'カメラの初期化が終わっていません。カメラを抜き差しし、' +
        'Windows の設定 > プライバシー > カメラ を確認してからアプリを再起動してください'
    );
  }

  // --- 遊べるが当日困るもの ---
  if (report.usingDummyCamera) {
    notes.push(
      'カメラが見つかりません。全員ダミー写真になり、AI変換も走りません' +
        '（Windows の設定 > プライバシー > カメラ を確認）'
    );
  }
  if (report.comfyui && !report.comfyui.healthy) {
    notes.push(
      'ComfyUI に繋がりません（' +
        report.comfyui.baseUrl +
        '）。カードの絵が全員同じプレースホルダになります'
    );
  }
  if (!report.comfyui) {
    // 🔴 これは**意図してそうする退避策**（README の「AI変換を当日オフにする」）。
    // 異常として扱うと、最後の逃げ道を採った瞬間に「準備できていません」と出る
    notes.push('ComfyUI の設定がありません。AI変換なしで動きます（意図した構成なら問題ありません）');
  }
  return { blockers, notes };
};

/**
 * 印を書く。**書き込みは1回で終わらせる**（途中まで書かれた JSON を
 * 起動バッチが読むと、準備できていないのに「読めた」と判断しうるため、
 * 一時ファイルへ書いてから置き換える）。
 */
export const writeReadiness = async (
  baseDir: string,
  report: ReadinessReport
): Promise<void> => {
  const target = readinessFilePath(baseDir);
  // 🔴 **一時ファイル名を固定しない。** app-ready の中で ComfyUI の疎通を
  // 最大40秒待つため、その間に「準備できていません」を見たスタッフが
  // もう一度バッチを叩くと report が2本並走する。固定名だと両方が同じ
  // .tmp を truncate しながら書き、混ざった JSON が rename されうる——
  // バッチは ConvertFrom-Json に失敗して「ready.json が壊れている」と出す
  // （＝正常なのに準備できていない扱い。敵対的レビュー 2026-09-09 の指摘）。
  // save-config が既に同じ流儀（.tmp-<pid>）を採っているのでそれに揃える。
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(report, null, 2) + '\n', 'utf8');
  try {
    await fs.rename(temp, target);
  } catch (error) {
    // 置き換えに失敗したら一時ファイルを残さない（logs が散らかると当日見づらい）
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
};
