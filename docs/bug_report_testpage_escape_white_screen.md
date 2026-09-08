# 不具合報告：TestPageからEscキー押下による白画面表示問題

**報告日:** 2025年8月17日  
**報告者:** Claude Code調査  
**重要度:** 高（アプリケーション機能停止）

## 問題の概要
TestPageからEscキー押下でトップページに戻ろうとすると、画面が真っ白になりアプリケーションが使用不能になる。

## 再現手順
1. `npm run electron` でアプリケーションを起動
2. `t`キーを押してTestPageに遷移
3. TestPage画面でEscキーを押下
4. 画面が真っ白になる

## 期待される結果
- Escキー押下後、トップページ（TopPage）が正常に表示される
- アプリケーションが継続して使用可能

## 実際の結果
- 画面が真っ白になる
- アプリケーションが操作不能になる
- コンソールエラーが発生

## エラーログ
```
Electron Security Warning (Insecure Content-Security-Policy) This renderer process has either no Content Security
  Policy set or a policy with "unsafe-eval" enabled. This exposes users of
  this app to unnecessary security risks.

For more information and help, consult
https://electronjs.org/docs/tutorial/security.
This warning will not show up
once the app is packaged.
warnAboutInsecureCSP @ VM4 sandbox_bundle:2
chromewebdata/:1 Not allowed to load local resource: file:///C:/
```

## 根本原因分析

### 1. 主要原因：不適切なページ遷移方法
**ファイル:** `src/renderer/test/TestPage.tsx:17`
```typescript
// 問題のあるコード
if (event.key === 'Escape') {
  window.location.href = '/'; // トップページにリダイレクト
}
```

**問題点:**
- `window.location.href = '/'` を使用してページ遷移を行っている
- ElectronアプリケーションでこのAPIを使用すると、ブラウザのネイティブナビゲーションが発生
- Reactアプリケーションの状態管理が破壊される
- コンテキストプロバイダーの状態がリセットされる

### 2. 設計上の矛盾
**正しい遷移方法の存在:**
- アプリケーションはReact Contextベースの状態管理を使用
- `ScreenContext`による画面遷移システムが実装済み
- 他のページでは`setCurrentScreen('TOP')`を使用した正しい遷移を実装

**App.tsx:42-58での正しい実装例:**
```typescript
const handleKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    // ゲーム中はEscキーの処理をGamePageに委譲
    if (currentScreen === 'GAME') {
      return;
    }
    
    playSound('paltu');
    setCurrentScreen('TOP');  // 正しい遷移方法
    resetGameState();
  }
};
```

### 3. セキュリティ関連の副次的問題
- Content Security Policy（CSP）が適切に設定されていない
- `file://` プロトコルへのアクセス試行エラー
- Electronのセキュリティ警告が発生

## 技術的詳細

### TestPage.tsxの問題実装
```typescript
// src/renderer/test/TestPage.tsx:14-23
useEffect(() => {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      window.location.href = '/'; // ❌ 問題のあるコード
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, []);
```

### 推奨される修正方法
```typescript
// 修正版コード
import { useScreen } from '../contexts/ScreenContext';
import { useGameSession } from '../contexts/GameSessionContext';

const TestPage: React.FC = () => {
  const { setCurrentScreen } = useScreen();
  const { resetGameState } = useGameSession();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        playSound('paltu');
        setCurrentScreen('TOP'); // ✅ 正しい遷移方法
        resetGameState();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setCurrentScreen, resetGameState]);
```

## 影響範囲
- **対象機能:** TestPage → TopPage遷移
- **影響度:** 高（機能完全停止）
- **ユーザー体験:** アプリケーション再起動が必要
- **セキュリティ:** 軽微（開発環境のみの警告）

## 修正方針
1. **即座の修正:** TestPage.tsxのEscキー処理をReact Context APIベースに変更
2. **設計統一:** 全ページで統一された遷移方法を使用
3. **セキュリティ改善:** CSP設定の見直し（別途対応）

## 関連ファイル
- `src/renderer/test/TestPage.tsx` - 修正対象
- `src/renderer/contexts/ScreenContext.tsx` - 状態管理
- `src/renderer/App.tsx` - 正しい実装例

## 緊急度
**高** - ユーザーがTestPage機能を使用できない状態

## 修正見積り
- **工数:** 0.5時間
- **難易度:** 低
- **リスク:** 極小（既存実装パターンの適用）

## 追加調査が必要な項目
1. 他のページで同様の問題がないかの確認
2. CSP設定の適切化
3. セキュリティ警告の解消

---
**調査完了:** 2025年8月17日  
**次の行動:** TestPage.tsxの修正実装