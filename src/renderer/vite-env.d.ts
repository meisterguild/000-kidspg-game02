/// <reference types="vite/client" />

// `import.meta.env` の型を有効にするための宣言。
// これが無いと `tsc --noEmit` で TS2339 (Property 'env' does not exist on type 'ImportMeta') になる。

interface Window {
  /** Safari 系の古い名前。assets.ts の AudioContext 生成でフォールバックに使う */
  webkitAudioContext?: typeof AudioContext;
}
