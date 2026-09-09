/**
 * ComfyUI の起動バッチを、アプリから「開いたままの PowerShell ウィンドウ」で走らせる。
 *
 * ■ なぜウィンドウを残すのか
 * ComfyUI はモデルの読み込みで数十秒かかり、失敗するときもそのウィンドウの中に
 * 理由が出る（モデルが無い・ポートが埋まっている・venv が壊れている）。
 * 当日スタッフはログファイルを開けないので、**画面に残っているのが唯一の手がかり**。
 * さらに ComfyUI を止めるのもこのウィンドウを閉じる操作になる。
 * そのため `-NoExit` を付ける。プロセスは Windows では親の終了で道連れにならないので、
 * アプリを終了しても ComfyUI は動き続ける（逆も同じ）。
 * ⚠️ `detached: true` で切り離すのは**間違い**。理由は buildLaunchCommand と spawn のコメント。
 *
 * ■ ここに手順を書かない
 * 起動の中身（CPU/GPU の切り替え、OMP_NUM_THREADS、venv の場所）は
 * `start-comfyui.bat` 側が持っている。ここはそれを**呼ぶだけ**にとどめる。
 * 二重管理にすると、バッチだけ直したときにアプリ経由の起動だけ挙動が違う、が起きる。
 *
 * ■ レンダラからパスを受け取らない
 * 叩くのは config.json で解決した `comfyui.paths.startBat` だけ。
 * 画面から任意のパスを渡せるようにすると、レンダラが乗っ取られたときに
 * 任意コマンドの実行口になる。
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';

export interface LaunchCommand {
  command: string;
  args: string[];
  cwd: string;
}

/** PowerShell の単一引用符リテラルへ埋め込む（'' で 1 個の ' を表す） */
const psSingleQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * 起動コマンドを組む。**副作用なし**（実行はしない）ので単体テストで固定できる。
 *
 * `powershell.exe` を直に起動する。`cmd.exe /c start` を挟む形も試したが、
 * **Node の引数のクォート方法では cmd.exe に通らなかった**（2026-09-08 実測）。
 * 素のままだと終了コード 1 でバッチが走らず、何のメッセージも出ない。
 * `windowsVerbatimArguments` を付けるとバッチは走るが、それでも終了コード 1 が返る
 * ——起動できたかを戻り値で判断できないので、どちらも採らない。
 * 窓は Windows が用意する——コンソールを持たないプロセス（Electron は GUI）から
 * コンソールアプリを起こすと、新しいコンソール窓が割り当てられる。
 *
 * `-NoExit` があるので、この PowerShell は**自分から終わらない**。
 * 呼び出し側は終了を待ってはいけない（launchComfyUI は spawn できた時点で返す）。
 */
export const buildLaunchCommand = (startBat: string, cwd: string): LaunchCommand => ({
  command: 'powershell.exe',
  args: ['-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', `& ${psSingleQuote(startBat)}`],
  cwd,
});

export interface LaunchOutcome {
  success: boolean;
  startBat?: string;
  error?: string;
}

/**
 * 起動バッチを叩く。**すでに動いているかどうかはここでは見ない**
 * （呼び出し側がヘルスチェックしてから呼ぶ。二重起動するとポートが埋まっていて
 * ComfyUI 側が即座に落ちるだけだが、窓が増えてスタッフが混乱する）。
 */
export const launchComfyUI = async (
  paths: { root: string; startBat?: string }
): Promise<LaunchOutcome> => {
  const { root, startBat } = paths;
  if (!startBat) {
    return {
      success: false,
      error: 'config.json の comfyui...paths.startBat が設定されていません',
    };
  }
  try {
    await fs.access(startBat);
  } catch {
    return { success: false, startBat, error: '起動バッチが見つかりません: ' + startBat };
  }
  // 作業フォルダは ComfyUI のルート。バッチを別の場所へ置いた場合でも、
  // バッチの中身は venv や main.py をルート基準で見ている（バッチの隣に合わせると壊れる）。
  const { command, args } = buildLaunchCommand(startBat, root);
  const cwd = root;

  return await new Promise<LaunchOutcome>((resolve) => {
    let settled = false;
    const done = (outcome: LaunchOutcome): void => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };
    try {
      const child = spawn(command, args, {
        cwd,
        // 🔴 **detached: true にしないこと。** Windows では DETACHED_PROCESS が付き、
        // 子はコンソールを一切持たなくなる。窓が出ないだけでなく、実測では
        // バッチそのものが走らなかった（2026-09-08。終了コード 0 なのに何も起きない）。
        detached: false,
        stdio: 'ignore',
        windowsHide: false,
      });
      // Node のイベントループを掴んだままにしない（終了の妨げになる）。
      // 子プロセス自体は Windows では親の終了で道連れにならないので、
      // アプリを閉じても ComfyUI は動き続ける。
      child.unref();
      child.on('error', (error) => {
        done({ success: false, startBat, error: String(error) });
      });
      // 🔴 **exit を待たないこと。** -NoExit を付けているので、この PowerShell は
      // 窓を閉じるまで終わらない。'spawn' は起動できた時点で1回だけ飛ぶ。
      child.on('spawn', () => {
        done({ success: true, startBat });
      });
    } catch (error) {
      done({ success: false, startBat, error: String(error) });
    }
  });
};
