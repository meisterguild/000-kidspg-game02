# 不具合報告：Electronビルド後の音声ファイル再生問題

**報告日:** 2025年8月14日

**問題の概要:**
`npm run dist` コマンドでビルドしたElectronアプリケーションを起動すると、アプリケーションは正常に動作するものの、音声ファイルが再生されない。

**再現手順:**
1. プロジェクトのルートディレクトリで `npm install` を実行し、依存関係をインストールする。
2. `npm run dist` コマンドを実行し、Electronアプリケーションをビルドする。
3. ビルドされた実行可能ファイル（例: `release/build/KidsPGよけまくり中ゲーム Setup 1.0.0.exe`）を起動する。
4. アプリケーション内で音声が再生される操作（例: ボタンクリック、ゲーム開始など）を行う。

**期待される結果:**
アプリケーション内で音声ファイルが正常に再生される。

**実際の結果:**
アプリケーションは動作するが、音声ファイルが一切再生されない。

**原因:**
Viteのビルドプロセスにおいて、`src/shared/utils/assets.ts` で文字列として定義されている音声ファイルのパスが、アセットとして認識されず、ビルド成果物ディレクトリ (`dist/renderer/assets/sounds`) にコピーされていなかったため。

`src/shared/utils/assets.ts` 内で、音声ファイルのパスが `./assets/sounds/action.mp3` のように相対パスの文字列として直接指定されている。
Viteは、JavaScriptやCSSから `import` や `url()` などで参照されているアセットは自動的に処理し、ビルド成果物ディレクトリにコピーするが、文字列として直接定義されているパスはアセットとして認識しない場合がある。
このため、ビルド後のアプリケーションが音声ファイルを見つけられず、再生に失敗していた。

**暫定的な解決策 (コード修正が必要な場合):**
`src/shared/utils/assets.ts` の該当箇所を以下のように修正することで解決する。
`new URL('./path/to/asset', import.meta.url).href` を使用してアセットをインポートすることで、Viteがアセットとして認識し、ビルド時に適切な場所にコピーし、パスを解決するようになる。

```typescript
// 修正前
export const SOUND_ASSETS = {
  action: './assets/sounds/action.mp3',
  bell: './assets/sounds/bell.mp3',
  // ...
} as const;

export const IMAGE_ASSETS = {
  spriteItems: './assets/images/sprite_items.png'
} as const;

// 修正後
export const SOUND_ASSETS = {
  action: new URL('./assets/sounds/action.mp3', import.meta.url).href,
  bell: new URL('./assets/sounds/bell.mp3', import.meta.url).href,
  buttonClick: new URL('./assets/sounds/button_click.mp3', import.meta.url).href,
  jump: new URL('./assets/sounds/jump.mp3', import.meta.url).href,
  machine: new URL('./assets/sounds/machine.mp3', import.meta.url).href,
  newtype: new URL('./assets/sounds/newtype.mp3', import.meta.url).href,
  ng: new URL('./assets/sounds/ng.mp3', import.meta.url).href,
  paltu: new URL('./assets/sounds/paltu.mp3', import.meta.url).href,
  screenChange: new URL('./assets/sounds/screen_change.mp3', import.meta.url).href,
  sound7: new URL('./assets/sounds/sound7.mp3', import.meta.url).href
} as const;

export const IMAGE_ASSETS = {
  spriteItems: new URL('./assets/images/sprite_items.png', import.meta.url).href
} as const;
```


**恒久対策:**
`src/shared/utils/assets.ts` において、Viteの提供する `new URL(path, import.meta.url).href`
構文を使用することで、ビルドシステムがアセットのパスを正しく解決し、アプリケーションの実行環境に合わせた適切
なURLを生成するようになります。
この方法は、Viteが推奨するアセットの取り扱い方であり、以下の理由から恒久的な解決策として適切です。

1.  **ビルドシステムによる自動解決**: 
`import.meta.url` を使用することで、Viteはビルド時にアセットを検出し、適切な出力ディレクトリにコピーし、そのパスを自動的に解決
します。これにより、開発環境とビルド後の実行環境でのパスの不一致を防ぎます。

2.  **キャッシュバーストと最適化**:
Viteは、この構文で参照されたアセットに対して、ファイル名にハッシュを追加するなどのキャッシュバースト戦略を適
用できます。これにより、ブラウザキャッシュの問題を回避し、アセットの更新が確実に反映されるようになります。

3.  **将来的な互換性**: 
`import.meta.url` はECMAScriptモジュールの一部として標準化されており、Viteだけでなく、他のモダンなビルドツールでもサポートされ
ています。これにより、将来的にビルドツールを変更した場合でも、アセットの参照方法を大きく変更する必要がなくな
ります。

4.  **コードの可読性と保守性**:
アセットのパスがコード内で明示的に定義され、ビルドシステムによって処理されることが明確になるため、コードの可
読性と保守性が向上します。
したがって、この修正は単なる一時的な対処ではなく、ViteとElectronを用いたアプリケーションにおけるアセット管理
のベストプラクティスに沿った恒久的な解決策であると言えます。

## 修正状況
*   **ステータス**: 修正済み
*   **修正コミット**: 
*   **修正日**: 
*   **修正者**: 
*   **備考**: 
