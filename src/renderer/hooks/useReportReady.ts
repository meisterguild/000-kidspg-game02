import { useEffect, useRef, useState } from 'react';

import { useCamera } from '../contexts/CameraContext';
import { useConfig } from '../contexts/ConfigContext';
import { useScreen } from '../contexts/ScreenContext';
import { isAssetsLoaded } from '../utils/assets';

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

  // 通常は1回だけ報告する（state が動くたびに送ると ready.json を書き換え続ける）。
  // ただし main から「もう一度報告して」と言われたら測り直す——
  // 起動バッチは印を消してから現れるのを待つので、すでに生きている場合に
  // 報告し直せないと必ず時間切れになる（詳細は main の second-instance）。
  const reported = useRef(false);
  /** 再報告の依頼が来た回数。増えると下の useEffect が動き直す */
  const [reportNonce, setReportNonce] = useState(0);
  // 🔴 **ここは ref ではなく state。** ref に入れても再描画が起きないので、
  // 打ち切りの時刻が来ても下の useEffect が動かず、永遠に報告しない。
  const [settleTimedOut, setSettleTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSettleTimedOut(true), CAMERA_SETTLE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  // main からの再報告の依頼を受ける
  useEffect(() => {
    if (!window.electronAPI?.onRequestReadyReport) return;
    window.electronAPI.onRequestReadyReport(() => {
      reported.current = false;
      setReportNonce((n) => n + 1);
    });
    return () => window.electronAPI?.removeRequestReadyReportListener?.();
  }, []);

  useEffect(() => {
    if (reported.current) return;
    if (configLoading) return;
    if (!assetsLoaded) return;

    // 「決着」は cameraReady（= cameraService の初期化処理が走り切ったか）で見る。
    // ⚠️ cameraError は現状ほぼ立たない——camera-service は getUserMedia の失敗を
    // 自分で受けてダミーモードへ落ち、resolve するため（実装を確認済み）。
    // 将来 initialize() が throw するようになったときの保険として条件に残すが、
    // **これが決着の主たる判定ではない**（敵対的レビュー 2026-09-09 の指摘）。
    const cameraSettled = cameraReady || cameraError !== null;
    if (!cameraSettled && !settleTimedOut) return;

    reported.current = true;
    // 🔴 **画面側のフラグ（assetsLoaded）ではなく、実際に読めたかを報告する。**
    // App.tsx は読み込みが失敗しても setAssetsLoaded(true) で先へ進める
    // （ゲームは動くので、その判断自体は正しい）。そのぶん画面側のフラグは
    // 常に true になり、「読み込みが終わっていません」の警告が**到達不能**に
    // なっていた（敵対的レビュー 2026-09-09 の指摘）。
    // USB からのコピーが欠けて assets が足りない場合に、これを黙って通すと
    // 背景が抜けた画面やカード合成の全滅に気づけない。
    void window.electronAPI
      ?.reportReady({
        assetsLoaded: isAssetsLoaded(),
        cameraReady,
        usingDummyCamera: isUsingDummy,
        screen: currentScreen,
      })
      .catch((error) => {
        // 報告できなくてもゲームは動く。バッチが「確かめられなかった」と言うだけ
        console.warn('準備完了の報告に失敗しました:', error);
      });
  }, [
    assetsLoaded,
    cameraReady,
    cameraError,
    configLoading,
    isUsingDummy,
    currentScreen,
    settleTimedOut,
    reportNonce,
  ]);
};
