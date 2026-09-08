# Bug Report: 正規版メモリアルカードが生成されない問題

## 1. 現象

- ゲーム完了後、ダミー画像を使用した `memorial_card_{datetime}.dummy.png` は正常に生成される。
- その後、ComfyUIによるAI画像生成が完了しても、AI生成画像を使用した正規の `memorial_card_{datetime}.png` が生成されない。

## 2. 原因

根本的な原因は、**メモリアルカードの重複生成を防止するためのフラグ管理ロジックの欠陥**にあります。

現在の処理フローは以下の通りです。

1.  **ダミー版生成とフラグ設定**:
    - `main.ts`の`save-json`ハンドラが呼び出されると、まずダミー版メモリアルカードを生成するために、重複防止フラグ `memorialCardGenerationFlags` に現在のセッションのタイムスタンプ (`datetime`) が追加されます。
    - その後、`generateDummyMemorialCard`が実行され、`.dummy.png`ファイルが生成されます。

2.  **正規版生成のスキップ**:
    - ComfyUIでのAI画像生成が完了すると、`main.ts`の`handleComfyUICompletion`関数が呼び出されます。
    - この関数の冒頭では、重複生成を防ぐために`memorialCardGenerationFlags`がチェックされます。
    - しかし、ステップ1で既にフラグが設定されているため、このチェックが常に`true`となり、**正規版の生成処理が重複とみなされて実行されずにスキップされてしまいます。**

このロジックは、ダミー版メモリアルカード機能を追加した際に、正規版の生成フローを意図せずブロックする形になってしまったものと考えられます。

## 3. 関連コンポーネント

- **`src/main/main.ts`**:
  - `save-json` IPCハンドラ: ダミー版生成のトリガーとフラグ設定を行う箇所。
  - `handleComfyUICompletion`関数: 正規版生成のトリガーとフラグチェックを行う箇所。
- **`src/main/services/memorial-card-service.ts`**:
  - `generateDummyMemorialCard`: ダミー版の生成ロジック。
  - `generateFromAIImage` / `generateMemorialCard`: 正規版の生成ロジック。

## 4. 修正方針

ユーザーの指示と提案に基づき、以下の修正方針を決定する。

**方針：ダミー版生成と正規版生成で、重複防止フラグを別々に管理する。**

具体的な実装案は以下の通り。

1.  `memorialCardGenerationFlags` のデータ構造を、単純な `Set<string>` から、生成状態を詳細に管理できる `Map<string, 'dummy_inprogress' | 'dummy_completed' | 'ai_inprogress' | 'ai_completed'>` のような構造に変更する。
2.  **ダミー版生成プロセス**:
    - `save-json` ハンドラ呼び出し時、まず状態を `'dummy_inprogress'` として設定する。
    - `generateDummyMemorialCard` 処理が正常に完了した後、状態を `'dummy_completed'` に更新する。
3.  **正規版生成プロセス**:
    - `handleComfyUICompletion` ハンドラ呼び出し時、状態が `'dummy_completed'` であることを確認してから処理を続行する。
    - 処理を開始する際に状態を `'ai_inprogress'` に更新し、正常に完了した後、最終状態として `'ai_completed'` に更新する。

この詳細な状態管理により、各プロセスの実行状況が明確になり、より安全に処理の順序を制御し、意図しない重複実行を防ぐことができる。
