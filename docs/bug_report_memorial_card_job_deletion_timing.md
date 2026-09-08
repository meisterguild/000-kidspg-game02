# Bug Report: メモリアルカード生成失敗 - ジョブ削除タイミング問題

**日付**: 2025-08-24  
**報告者**: System Analysis  
**重要度**: Critical  
**影響範囲**: AI生成画像を使用したメモリアルカード生成機能全体  

## 1. 問題の概要

ComfyUIでの画像生成が正常に完了し、`photo_anime_*.png`ファイルも正しく作成されているにも関わらず、AI生成画像を使用した正規のメモリアルカード（`memorial_card_{datetime}.png`）が生成されない問題が発生している。特に高得点ユーザーにおいて頻発している。

## 2. 症状

### 発生している現象
- ComfyUIの画像生成処理は正常に完了する
- `photo_anime_*.png`ファイルは正しく結果フォルダに保存される
- ダミー版メモリアルカード（`memorial_card_{datetime}.dummy.png`）は正常に生成される
- AI生成画像を使用した正規版メモリアルカード（`memorial_card_{datetime}.png`）が生成されない
- エラーログは出力されない（処理がスキップされる）

### 期待される動作
- ComfyUI完了後、AI生成画像を使用して正規版メモリアルカードが生成される
- `memorial_card_{datetime}.png`ファイルが作成される

## 3. 根本原因の分析

### 原因特定の経緯

#### コミット履歴での問題発生の詳細分析

| コミット | 作成者 | 変化内容 | 状態管理 | updateJobStatus | 動作状況 |
|----------|--------|----------|----------|----------------|----------|
| **326b952a** | MGHiOgawa | (基準版) | `Map<string, 状態>` | 削除処理なし | ✅ **正常** |
| **5427313** | Gemini | ランキング機能追加 | `Set<string>`に劣化 | 削除処理なし | ❌ フラグ重複問題 |
| **16eb63b〜5af47a1** | - | 継続期間 | `Set<string>` | 削除処理なし | ❌ 同上継続 |
| **07a1673** | MGHiOgawa | config修正 | `Map<string, 状態>`復元 | **削除処理追加** | ❌ **新規問題発生** |
| **ce7fd19** | MGHiOgawa | ranking表示 | `Map<string, 状態>` | **削除処理継続** | ❌ **現在の問題** |

#### 各段階での問題詳細

**Phase 1: 正常動作期間（326b952a）**
- 状態管理: `Map<string, 'dummy_inprogress' | 'dummy_completed' | 'ai_inprogress' | 'ai_completed'>`
- ComfyUI完了処理: ジョブ情報削除なし、コールバック実行時に`job.resultDir`正常取得
- 結果: AI生成メモリアルカード正常作成

**Phase 2: ランキング機能追加による破綻（5427313）**
- 状態管理: `Set<string>`に劣化
- 問題: `handleComfyUICompletion()`で重複チェック `if (Set.has(dateTime)) return;`
- 結果: ダミー処理でフラグ設定後、AI処理が重複判定でスキップ

**Phase 3: 状態管理修正も新たな問題発生（07a1673）**
- 状態管理: `Map<string, 状態>`に復元（✅ 修正完了）
- **新規問題**: ジョブ早期削除ロジック追加
  ```typescript
  // 07a1673で追加された問題コード
  private updateJobStatus(jobId: string, status: 'completed' | 'error'): void {
    if (status === 'completed' || status === 'error') {
      if (!this.memorialCardEnabled || !this.memorialCardCallback) {
        this.activeJobs.delete(jobId); // ← コールバック実行前の削除
      }
    }
  }
  ```
- 結果: 状態管理は正常だが、ジョブ情報削除によりメモリアルカード生成失敗

### 根本原因：ジョブ情報の削除タイミング問題

#### 問題のあるコード（src/main/services/comfyui-service.ts:182-201）
```typescript
private updateJobStatus(jobId: string, status: 'queued' | 'processing' | 'completed' | 'error'): void {
  const job = this.activeJobs.get(jobId);
  if (job) {
    job.status = status;
    
    // 完了またはエラー時の削除処理
    if (status === 'completed' || status === 'error') {
      // メモリアルカード生成が無効、またはcallbackが設定されていない場合は即座に削除
      if (!this.memorialCardEnabled || !this.memorialCardCallback) {
        console.log(`ComfyUIService - Removing completed job immediately: ${jobId} (memorial card disabled or callback not set)`);
        this.activeJobs.delete(jobId); // ← 問題の箇所：コールバック実行前の削除
      } else {
        // メモリアルカード生成時間を考慮して遅延削除
        setTimeout(() => {
          if (this.activeJobs.has(jobId)) {
            console.log(`ComfyUIService - Removing completed job after delay: ${jobId}`);
            this.activeJobs.delete(jobId);
          }
        }, 5000); // 5秒後に削除
      }
    }
  }
}
```

## 4. 問題発生のメカニズム

### 破壊的フロー（現在の問題）
```
1. ComfyUIワーカー: 画像生成完了 → 'job-completed'メッセージ送信
2. ComfyUIサービス: handleWorkerMessage()で受信
3. ComfyUIサービス: updateJobStatus('completed')実行
4. ComfyUIサービス: 条件により activeJobs.delete(jobId) で即座削除 ← 問題発生
5. ComfyUIサービス: this.memorialCardCallback(jobId, job.resultDir) 実行
6. main.ts: handleComfyUICompletion()実行 → job情報が既に削除済みでundefined
7. 結果: job.resultDir取得不可、メモリアルカード生成スキップ
```

### 正しく動作していた時のフロー（326b952a）
```
1. ComfyUIワーカー: 画像生成完了 → 'job-completed'メッセージ送信
2. ComfyUIサービス: handleWorkerMessage()で受信
3. ComfyUIサービス: updateJobStatus('completed')実行（削除処理なし）
4. ComfyUIサービス: this.memorialCardCallback(jobId, job.resultDir) 実行
5. main.ts: handleComfyUICompletion()実行 → job.resultDir正常取得
6. 結果: AI生成メモリアルカード正常作成
```

### 高得点ユーザーでの頻発理由

1. **処理負荷の違い**: 高得点 → より複雑なメモリアルカード → 処理時間増加
2. **タイミング競合**: 処理時間が長いほど、ジョブ削除とコールバック実行の競合状態が顕在化
3. **リソース競合**: 高負荷時にWorkerメッセージ処理とコールバック実行のタイミングずれが発生

## 5. 影響範囲

### 直接的影響
- AI生成画像を使用した正規版メモリアルカードの完全欠損
- 高得点ユーザーのユーザー体験著しい劣化
- ランキングシステムでのAI画像表示不具合

### 間接的影響
- システム全体の信頼性低下
- ユーザーのモチベーション低下
- 機能の価値提供不能

## 6. 再現手順

1. ゲームを完了し高得点を取得する
2. 写真撮影を行う
3. ComfyUIでの画像生成を開始する
4. ComfyUI完了まで約2分30秒待機する
5. `results/{datetime}/`フォルダを確認する
6. `memorial_card_{datetime}.dummy.png`は存在するが`memorial_card_{datetime}.png`が存在しないことを確認する

## 7. 修正方法

### 即効性のある修正（推奨）

#### オプション1: 早期削除ロジックの無効化
```typescript
// src/main/services/comfyui-service.ts:187-201をコメントアウト
private updateJobStatus(jobId: string, status: 'completed' | 'error'): void {
  const job = this.activeJobs.get(jobId);
  if (job) {
    job.status = status;
    
    // 以下の削除処理をコメントアウト
    /*
    if (status === 'completed' || status === 'error') {
      // ... 削除処理
    }
    */
  }
}
```

#### オプション2: コールバック完了後の削除（最推奨）
```typescript
case 'job-completed': {
  this.updateJobStatus((data as ComfyUIJobProgressData).jobId, 'completed');
  this.sendToRenderer('comfyui-job-completed', data);
  
  // メモリアルカード生成をトリガー
  const jobData = data as ComfyUIJobProgressData;
  const job = this.activeJobs.get(jobData.jobId);
  if (job && this.memorialCardCallback) {
    // コールバック完了を待ってから削除
    try {
      await this.memorialCardCallback(jobData.jobId, job.resultDir);
      // コールバック完了後にジョブ削除
      this.activeJobs.delete(jobData.jobId);
    } catch (error) {
      console.error('ComfyUIService - Memorial card generation error:', error);
      // エラー時もジョブを削除
      this.activeJobs.delete(jobData.jobId);
    }
  }
  break;
}
```

### 根本的な修正（長期的）

#### ComfyUIジョブのライフサイクル管理改善
1. ジョブ削除タイミングの明確化
2. コールバック完了確認機構の実装
3. エラー処理とリトライ機構の強化
4. ジョブ状態の詳細ログ出力

## 8. 検証方法

### 修正前の確認
1. コンソールログで「Removing completed job immediately」メッセージを確認
2. `memorial_card_{datetime}.png`が存在しないことを確認
3. `memorial_card_{datetime}.dummy.png`のみ存在することを確認

### 修正後の確認
1. `memorial_card_{datetime}.png`が正常作成されることを確認
2. AI生成画像を使用したメモリアルカード生成が正常実行されることを確認
3. ランキング画面でAI生成画像が正常表示されることを確認
4. 高得点ユーザーでも正常動作することを確認

## 9. 関連ファイル

- **問題箇所**: `src/main/services/comfyui-service.ts:182-201`
- **影響を受けるファイル**: `src/main/main.ts:handleComfyUICompletion()`
- **関連する設定**: `memorialCardEnabled`, `memorialCardCallback`

## 10. ワークアラウンド

**緊急対応**: コミット`326b952a454d5042cc7cd028cbfab64588bffc4b`への一時的な戻し運用

```bash
git checkout 326b952a454d5042cc7cd028cbfab64588bffc4b
```

## 11. 優先度と対応期限

- **優先度**: Critical（主要機能の部分停止）
- **対応期限**: 即座（高得点ユーザーの体験劣化継続中）
- **影響ユーザー**: 高得点達成ユーザー（推定30-50%）

## 12. 追加調査項目

- [ ] `this.memorialCardEnabled`および`this.memorialCardCallback`の実際の設定値確認
- [ ] 高得点時の処理負荷とタイミング競合の詳細測定
- [ ] コールバック実行順序の詳細ログ分析
- [ ] メモリーリークの可能性調査（削除ロジック無効化時）

## 13. 重要な教訓と予防策

### 今回の問題から得られた教訓

1. **複合的なバグの危険性**
   - Phase 2で状態管理の破綻
   - Phase 3で状態管理修正も新たなタイミング問題導入
   - 結果として異なる原因で同じ症状が継続発生

2. **非同期処理でのライフサイクル管理の重要性**
   - コールバック実行前のリソース削除は危険
   - 依存関係の明確な管理が必要

3. **段階的修正の重要性**
   - 複数の問題を同時修正すると新たな問題導入のリスク
   - 十分な検証なしの修正は危険

### 予防策の提案

1. **ライフサイクル管理の標準化**
   - リソース削除タイミングの明確なルール策定
   - コールバック完了確認機構の標準実装

2. **テストカバレッジの拡充**
   - E2Eテストでの完全フロー検証
   - 高負荷時のタイミング競合テスト

3. **ログ出力の強化**
   - ジョブライフサイクルの詳細ログ
   - コールバック実行状況の可視化

4. **コードレビューの強化**
   - 非同期処理でのリソース管理に特別注意
   - タイミング競合の可能性を事前チェック

---
**注記**: この問題は07a1673コミットで導入されたジョブ削除タイミングの問題が根本原因です。状態管理の修正と同時に導入された副作用により、表面的には正常に見えるが実際にはコールバック実行時にリソースが不足する状況が発生しています。