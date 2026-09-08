# バグレポート: ランキング画面カード画像の縦横比表示不具合

**報告日**: 2025-08-21  
**報告者**: ユーザー  
**優先度**: Medium  
**影響範囲**: RankingPage のカード画像表示  

## 問題の概要

RankingPageにおいて、ウィンドウサイズを変更した際にカード画像の表示が適切に調整されない問題が発生しています。現在は横幅のみにフィットする設定のため、ウィンドウの高さが小さくなると画像が見切れてしまいます。

## 発生条件

- **画面**: RankingPage
- **操作**: ウィンドウサイズを変更（特に高さを小さくする）
- **影響**: カード画像表示域内での画像表示

## 現在の実装状況

### 問題の箇所
**ファイル**: `src/renderer/components/ranking/PaginatedScrollList.tsx:123`

```tsx
<img 
  src={imageUrl} 
  alt={`Score ${entry.score}`}
  className="max-w-full max-h-full object-contain" 
/>
```

### 問題の詳細

1. **CSS設定**: `object-contain` が使用されているが、制約が十分でない
2. **縦横比制御**: `max-w-full max-h-full` の組み合わせにより、実際には横幅優先でのスケーリングが行われる
3. **コンテナ設定**: カード表示域（`.flex-1 w-full min-h-0`）は可変だが、画像は最適な縦横比調整ができていない

### 根本原因

現在の実装では以下の状況が発生しています：

- カード画像表示域：可変サイズ（レスポンシブ）
- 画像スケーリング：`object-contain`使用だが、`max-w-full max-h-full`により横幅優先
- 結果：ウィンドウ高さが小さい場合、画像の上下が見切れる

## 期待される動作

1. **適応的フィット**: 画像がカード表示域に完全に収まる
2. **縦横比保持**: 元の画像の縦横比を維持
3. **最適スケーリング**: 縦幅または横幅のうち制約の強い方に合わせてスケーリング

## 技術的解決案

### 解決方法1: CSS改善
```tsx
<img 
  src={imageUrl} 
  alt={`Score ${entry.score}`}
  className="w-full h-full object-contain" 
/>
```

### 解決方法2: より厳密な制御
```tsx
<img 
  src={imageUrl} 
  alt={`Score ${entry.score}`}
  className="max-w-full max-h-full object-contain"
  style={{ 
    width: 'auto', 
    height: 'auto',
    maxWidth: '100%',
    maxHeight: '100%'
  }}
/>
```

### 解決方法3: コンテナレベルでの調整
```tsx
<div className="w-full h-full bg-gradient-to-b from-slate-700 to-slate-800 border border-cyan-400/20 rounded-lg shadow-lg overflow-hidden flex items-center justify-center p-2">
  <img 
    src={imageUrl} 
    alt={`Score ${entry.score}`}
    className="max-w-full max-h-full object-contain" 
  />
</div>
```

## 関連ファイル

- `src/renderer/components/ranking/PaginatedScrollList.tsx` (Line 118-134)
- `src/renderer/styles/globals.css` (Line 136: `.title-image` クラス参考)

## 追加調査事項

1. **既存の類似実装**: `src/renderer/styles/globals.css:136` で `.title-image` に `object-contain` が適用されており、正常動作している
2. **要件確認**: `docs/ranking_feature_requirements.md:41` には `object-fit: cover` の記載があるが、実装では `object-contain` が使用されている
3. **他画面での実装**: CameraPage では `object-cover` が使用されており、用途に応じた使い分けが必要

## 検証方法

1. ウィンドウサイズを様々に変更
2. 横長・縦長の画像での表示確認
3. 異なる解像度での動作確認
4. レスポンシブ動作の検証

## 影響度

- **ユーザビリティ**: 画像が見切れることでカード内容が把握できない
- **レスポンシブデザイン**: ウィンドウサイズ変更時の表示品質低下
- **視認性**: 記念カード画像の重要部分が隠れる可能性