import { useEffect, useRef, useState } from 'react';

import { useCamera } from '../contexts/CameraContext';
import { useConfig } from '../contexts/ConfigContext';
import { useScreen } from '../contexts/ScreenContext';

/**
 * 「画面が出て、遊べる状態になった」ことを main へ1回だけ報告する。
 *
 * ■ 何のためか
 * 当日の運用は「モニタとPCを置く → 電源 → 起動バッチを叩く → 準備完了」だけにしたい。
 * ところが起動バッチは**アプリを起こしたところまでしか見ていなかった**ため、
 * 起動に失敗しても「起動しました／問題なし」と表示できてしまっていた。
 *
 * ここから報告すると main が `logs/ready.json` を書き、起動バッチはそれを待つ。
 * 「準備完了」が推測ではなく実測になる。
 *
 * ■ 何をもって準備完了とするか
 *   ・設定の読み込みが終わっている（読めなかった場合も既定値で先へ進む）
 *   ・背景アセットの読み込みが終わっている（TOP 画面が描ける）
 *   ・カメラの初期化が**決着している**
 *
 * カメラは「成功」だけでなく「失敗して確定した」場合も決着とみなす。
 * カメラが無くてもゲームは動く（全員ダミー写真になる）ので、起動を止めるのではなく
 * **警告として当日スタッフに見せる**のが正しい（判断は main 側の
 * buildReadinessWarnings が持っている）。
 *
 * ■ 決着しないときも黙って待たない
 * `getUserMedia` が返ってこない場合（権限の問い合わせが出たまま等）、待ち続けると
 * バッチは「時間切れ」しか言えず、当日それでは何も分からない。
 * そこで CAMERA_SETTLE_TIMEOUT_MS で打ち切り、**そのときの状態のまま報告する**。
 * バッチには「カメラの初期化が終わっていません」と出るので、次の手が打てる。
 */
const CAMERA_SETTLE_TIMEOUT_MS = 20000;

export const useReportReady = (): void => {
  const { assetsLoaded, currentScreen } = useScreen();
  const { isReady: cameraReady, isUsingDummy, error: cameraError } = useCamera();
  const { loading: configLoading } = useConfig();

  // 報告は1回だけ。state が動くたびに送ると ready.json を書き換え続けることになる
  const reported = useRef(false);
  // 🔴 **ここは ref ではなく state。** ref に入れても再描画が起きないので、
  // 打ち切りの時刻が来ても下の useEffect が動かず、永遠に報告しない。
  const [settleTimedOut, setSettleTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSettleTimedOut(true), CAMERA_SETTLE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (reported.current) return;
    if (configLoading) return;
    if (!assetsLoaded) return;

    const cameraSettled = cameraReady || cameraError !== null;
    if (!cameraSettled && !settleTimedOut) return;

    reported.current = true;
    // ブラウザで画面だけ確認しているときは electronAPI が無い。そのときは何もしない
    void window.electronAPI
      ?.reportReady({
        assetsLoaded,
        cameraReady,
        usingDummyCamera: isUsingDummy,
        screen: currentScreen,
      })
      .catch((error) => {
        // 報告できなくてもゲームは動く。バッチが「確かめられなかった」と言うだけ
        console.warn('準備完了の報告に失敗しました:', error);
      });
  }, [assetsLoaded, cameraReady, cameraError, configLoading, isUsingDummy, currentScreen, settleTimedOut]);
};
