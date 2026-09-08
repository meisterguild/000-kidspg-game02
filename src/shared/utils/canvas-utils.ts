/**
 * Canvas画像処理ユーティリティ
 * カメラ撮影画像のリサイズやフォーマット変換を行います
 */

/**
 * Canvas要素から指定サイズの正方形画像を生成
 * @param canvas 元のCanvas要素
 * @param size 出力サイズ（デフォルト: 512px）
 * @returns リサイズされた新しいCanvas要素
 */
export const resizeToSquare = (canvas: HTMLCanvasElement, size: number = 512): HTMLCanvasElement => {
  const squareCanvas = document.createElement('canvas');
  const ctx = squareCanvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context を取得できませんでした');
  }
  
  squareCanvas.width = size;
  squareCanvas.height = size;
  
  // 元画像のアスペクト比を保持しながら正方形にフィット
  const sourceSize = Math.min(canvas.width, canvas.height);
  const sourceX = (canvas.width - sourceSize) / 2;
  const sourceY = (canvas.height - sourceSize) / 2;
  
  ctx.drawImage(canvas, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
  
  return squareCanvas;
};