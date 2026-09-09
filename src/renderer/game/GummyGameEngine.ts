import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AppConfig } from '@shared/types';
import type { BoardMode } from '../contexts/GameSessionContext';
// 3Dグミパズル本体（React コンポーネント）
import GummyGame from './gummy/GummyGame';

/**
 * GamePage から見たゲームエンジンのアダプター。
 *
 * 昨年の PixiGameEngine と同じ呼び出し口を保つことで、GamePage 側の改修を
 * import 1行に閉じ込める。中身は React ルートを container にマウントして
 * Three.js のパズルを描画するだけ。
 *
 *   new GummyGameEngine(config)
 *   await initialize(container)
 *   setGameOverCallback(score => ...)
 *   setEscapeCallback(() => ...)
 *   getScore() / getLevel()
 *   destroy()
 */
export class GummyGameEngine {
  private config: AppConfig;
  /**
   * 盤面の作り。GummyGame は createRoot で**別の React ルート**へマウントするため、
   * Context が届かない。プレイ1回ぶんの選択なので props で渡す。
   */
  private boardMode: BoardMode;
  private root: Root | null = null;
  /**
   * React ルートは container 直下ではなく、専用に作った子要素へマウントする。
   * StrictMode の二重実行で「破棄 → 生成」が同じタックで走ったとき、
   * 古いルートの unmount が新しいルートの描画を消してしまうのを避けるため。
   */
  private host: HTMLDivElement | null = null;

  private score = 0;
  /** クリアしたステージ数。GamePage のヘッダーでは「レベル」として表示される */
  private level = 0;

  private gameOverCallback: ((score: number) => void) | null = null;
  private escapeCallback: (() => void) | null = null;

  constructor(config: AppConfig, boardMode: BoardMode = 'cube') {
    this.config = config;
    this.boardMode = boardMode;
  }

  async initialize(container: HTMLElement): Promise<void> {
    // GummyGame は absolute inset-0 で描画するため、親に位置基準が必要
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    const host = document.createElement('div');
    host.style.position = 'absolute';
    host.style.inset = '0';
    container.appendChild(host);
    this.host = host;

    this.root = createRoot(host);
    this.root.render(
      React.createElement(GummyGame, {
        config: this.config,
        boardMode: this.boardMode,
        onScoreChange: (s: number) => { this.score = s; },
        onLevelChange: (n: number) => { this.level = n; },
        // コールバックは initialize の後に差し込まれるので、毎回 this 経由で引く
        onGameOver: (s: number) => { this.gameOverCallback?.(s); },
        onEscape: () => { this.escapeCallback?.(); },
      })
    );

    // 初回マウントを待ってから解決する（GamePage 側のタイムアウト計測のため）。
    // 🔴 requestAnimationFrame だけに頼らない。ウィンドウが隠れている間はブラウザが
    //    rAF を呼ばないため、**初期化が永遠に終わらず15秒でタイムアウト**する
    //    （＝「ゲームエラー」の画面になる）。保険のタイマーで必ず前へ進める。
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  setGameOverCallback(callback: (score: number) => void): void {
    this.gameOverCallback = callback;
  }

  setEscapeCallback(callback: () => void): void {
    this.escapeCallback = callback;
  }

  getScore(): number {
    return this.score;
  }

  getLevel(): number {
    return this.level;
  }

  destroy(): void {
    const root = this.root;
    const host = this.host;
    this.root = null;
    this.host = null;
    this.gameOverCallback = null;
    this.escapeCallback = null;
    // 画面からは即座に外し、unmount 自体は React の描画サイクル外へ逃がす
    host?.remove();
    if (root) setTimeout(() => root.unmount(), 0);
  }
}
