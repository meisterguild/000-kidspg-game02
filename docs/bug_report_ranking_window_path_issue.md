# Bug Report: ランキングウィンドウ機能完全不全

## 🚨 CRITICAL: 本番環境でランキング機能が完全に動作しない

## 問題概要
npm run electronと exe起動で、ランキング表示ページの動作が異なる問題。npm run electronでは正常に表示されるが、exe起動では「ランキング準備中...」プレースホルダーが表示される。

## 発生環境
- **開発環境 (npm run electron)**: 正常動作 ✅
- **本番環境 (exe起動)**: 機能不全 ❌

## 🔍 上級エンジニア分析結果

### **ROOT CAUSE 1: electron-builder設定欠陥**
**CRITICAL**: `ranking.html`がelectron-builderのextraFilesに含まれていない

**package.json:81-94 実際の設定**:
```json
"extraFiles": [
  {"from": "config.json", "to": "."},
  {"from": "assets", "to": "assets"}, 
  {"from": "card_base_images", "to": "card_base_images"}
  // ranking.html が存在しない！
]
```

### **ROOT CAUSE 2: 一貫性のないパス解決実装**
**src/main/main.ts:162**が唯一環境判定を実装していない：
```typescript
const rankingPath = path.join(process.cwd(), 'ranking.html'); // ← バグ箇所
```

他の7箇所では`app.isPackaged`による適切な環境判定が実装済み。

### **ROOT CAUSE 3: 設計上の根本的問題**
- HTMLファイル配置: プロジェクトルート
- パッケージ化対象: 未指定
- 結果: 本番環境で必然的に動作不可

## 技術的詳細

### 影響するコード箇所
**src/main/main.ts:160-166**:
```typescript
createRankingWindow() {
  // ...
  // ランキングHTMLファイルを読み込み
  const rankingPath = path.join(process.cwd(), 'ranking.html'); // ← 問題箇所
  this.rankingWindow.loadFile(rankingPath).catch(() => {
    // ファイルが存在しない場合はプレースホルダーを表示
    this.rankingWindow?.loadURL('data:text/html,<h1>ランキング準備中...</h1>');
  });
}
```

### 関連ファイル
- `/ranking.html`: プロジェクトルートに存在するランキングHTMLファイル
- `src/renderer/pages/TopPage.tsx:103`: ランキング表示ボタンの実装
- `src/main/preload.ts:22`: showRankingWindow IPCハンドラ

## 🛠️ 修正方法

### **STEP 1: electron-builder設定修正（CRITICAL）**
**package.json**のextraFilesに追加：
```json
"extraFiles": [
  {"from": "config.json", "to": "."},
  {"from": "assets", "to": "assets"}, 
  {"from": "card_base_images", "to": "card_base_images"},
  {"from": "ranking.html", "to": "."} // ← 追加必須
]
```

### **STEP 2: パス解決ロジック修正**
**src/main/main.ts:162**を既存パターンに統一：
```typescript
// 修正前（バグ）
const rankingPath = path.join(process.cwd(), 'ranking.html');

// 修正後（L76-78, L190パターンと統一）
const rankingPath = app.isPackaged 
  ? path.join(path.dirname(app.getPath('exe')), 'ranking.html')
  : path.join(process.cwd(), 'ranking.html');
```

**参考**: 同じパターンが既に以下で使用済み：
- L76-78: ResultsManager初期化
- L190: dummy_photo.pngアクセス

### **STEP 3: エラーハンドリング強化**
デバッグ情報追加：
```typescript
this.rankingWindow.loadFile(rankingPath).catch((error) => {
  console.error(`Ranking file not found: ${rankingPath}`, error);
  this.rankingWindow?.loadURL('data:text/html,<h1>ランキング準備中...</h1>');
});
```

## 影響範囲
- **優先度**: 高 - ユーザー向け機能の完全な機能不全
- **影響するユーザー**: 本番環境（exe）でランキング表示機能を使用するすべてのユーザー
- **影響する機能**: ランキング表示ウィンドウ

## 検証方法
1. 修正後にelectron-builderでビルド
2. 生成されたexeファイルを実行
3. トップページの「ランキング表示」ボタンをクリック
4. ranking.htmlの内容が正常に表示されることを確認

## 📋 メンテナンス推奨事項

### **コードベース全体の技術的負債**
1. **パス解決パターンの標準化**
   - 7箇所の`app.isPackaged`実装を統一関数に集約
   - TypeScript型安全性の向上

2. **electron-builder設定の見直し**
   - 必要ファイルの漏れチェック
   - ビルド検証自動化

3. **エラーハンドリング統一**
   - 本番環境でのファイル不足に対する一貫した対応

### **既知の関連問題**
- `docs/bug_report_filepath_issues.md`: 同様のパス問題を既に認識
- `main.ts:483-556`: 複雑な代替パス探索実装（リファクタリング対象）

## 🔄 検証手順
1. **STEP 1実行後**: electron-builderでビルド、exeディレクトリにranking.html存在確認
2. **STEP 2実行後**: exe起動でランキング機能動作確認  
3. **リグレッションテスト**: 開発環境での動作継続確認

## ⚠️ 緊急度評価
- **Priority**: **P0 (最高優先度)**
- **Severity**: **Critical** - 基幹機能の完全不全
- **Impact**: 本番環境ユーザー全員に影響