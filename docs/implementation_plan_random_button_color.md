# ニックネーム選択画面「ランダム」ボタンのカラー変更実装計画

## 概要

ニックネームを選択する画面で、「ランダム」と表示されているボタンだけ色を緑系に変更する。

## 変更ファイル

- `src/renderer/pages/CameraPage.tsx`
- `src/renderer/styles/globals.css`

## 実装手順

### 1. `CameraPage.tsx` の修正

`NICKNAME_OPTIONS` を `map` で展開してボタンを生成している箇所に、`option.id` をチェックするロジックを追加する。
`option.id` が `'random'` の場合にのみ、特定のCSSクラス（例: `is-random`）をボタンに付与する。

**修正前:**

```tsx
<button
  key={option.id}
  className={`nickname-button ${
    selectedNickname === option.text
      ? 'nickname-button--selected' 
      : 'nickname-button--unselected'
  }`}
  onClick={() => handleNicknameClick(option.text)}
>
  {option.text}
</button>
```

**修正後:**

```tsx
<button
  key={option.id}
  className={`nickname-button ${
    selectedNickname === option.text
      ? 'nickname-button--selected' 
      : 'nickname-button--unselected'
  } ${
    option.id === 'random' ? 'is-random' : ''
  }`}
  onClick={() => handleNicknameClick(option.text)}
>
  {option.text}
</button>
```

### 2. `globals.css` の修正

`src/renderer/styles/globals.css` に、手順1で追加した `is-random` クラスに対するスタイリングを追記する。
背景色を緑系にし、ホバー時の色も設定する。

```css
/* ランダムボタン専用スタイル */
.nickname-button.is-random {
  @apply bg-green-600 text-white;
}

.nickname-button.is-random:hover {
  @apply bg-green-700;
}

/* 選択時のスタイルが上書きされるように調整 */
.nickname-button.is-random.nickname-button--selected {
  @apply bg-green-500 ring-green-400;
}
```

上記の実装により、「ランダム」ボタンのみが緑系の色で表示されるようになる。
