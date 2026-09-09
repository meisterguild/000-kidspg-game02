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
   * 当日スタッフに伝えるべきこと。**空なら文字どおり準備完了**。
   * 起動バッチはこの中身をそのまま画面へ出す。
   */
  warnings: string[];
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
 * 集めた事実から、当日スタッフに伝えるべきことを組み立てる。
 *
 * **「動くけれど当日困ること」を漏らさないのがここの役目。**
 * 起動できたかどうかだけを見ると、カメラが無い（全員ダミー写真）や
 * ComfyUI が落ちている（全員同じ絵）に気づかないまま開場してしまう。
 */
export const buildReadinessWarnings = (
  report: Omit<ReadinessReport, 'warnings'>
): string[] => {
  const warnings: string[] = [];
  if (!report.results.writable) {
    warnings.push(
      'results に書き込めません（' + report.results.dir + '）。カードが1枚も残りません'
    );
  }
  if (report.usingDummyCamera) {
    warnings.push(
      'カメラが見つかりません。全員ダミー写真になり、AI変換も走りません' +
        '（Windows の設定 > プライバシー > カメラ を確認）'
    );
  }
  if (!report.cameraReady) {
    warnings.push('カメラの初期化が終わっていません');
  }
  if (!report.assetsLoaded) {
    warnings.push('背景アセットの読み込みが終わっていません');
  }
  if (report.comfyui && !report.comfyui.healthy) {
    warnings.push(
      'ComfyUI に繋がりません（' +
        report.comfyui.baseUrl +
        '）。カードの絵が全員同じプレースホルダになります'
    );
  }
  if (!report.comfyui) {
    warnings.push('ComfyUI の設定がありません。AI変換なしで動きます');
  }
  return warnings;
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
  const temp = target + '.tmp';
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(report, null, 2) + '\n', 'utf8');
  await fs.rename(temp, target);
};
