# Test Scripts

このフォルダには、開発・テスト・メンテナンス用のスクリプトが含まれています。

## 目次

- [Memorial Card Recovery Script](#memorial-card-recovery-script)
- [Image Gallery Generator Scripts](#image-gallery-generator-scripts)
  - [概要](#概要)
  - [**重要：実行ワークフロー**](#重要実行ワークフロー)
  - [各スクリプトの詳細](#各スクリプトの詳細)

---

## Memorial Card Recovery Script

正規版メモリアルカードが作成されなかった結果データをリカバリするスクリプト。

### 使用方法

```bash
# プロジェクトルートに移動
cd C:\Users\owner\MG\PoC_base\000-kidspg-game01

# ドライランモード（変更を行わずに確認のみ）
npx ts-node --compiler-options '{\"module\": \"CommonJS\"}' src/test/memorial-card-recovery.ts --dry-run

# 実際の復旧実行
npx ts-node --compiler-options '{\"module\": \"CommonJS\"}' src/test/memorial-card-recovery.ts
```

*（その他の詳細な説明は省略）*

---

## Image Gallery Generator Scripts

### 概要

`results`フォルダ内の全結果を一覧表示する`gallery.html`を生成するための一連のツールです。ページの表示速度を向上させるため、サムネイル画像を利用する3ステップのワークフローを採用しています。

### **重要：実行ワークフロー**

HTMLギャラリーを正しく生成・更新するには、**必ず以下の順番でコマンドを実行してください。**

#### ステップ1：サムネイル画像を生成する

`results`フォルダ内のカメラ撮影写真（`photo_*.png`）から、一覧表示用のサムネイル画像を生成します。既存のサムネイルは常に上書きされます。

```bash
# 例: 幅500pxでサムネイルを生成
npx ts-node --compiler-options '{\"module\": \"CommonJS\"}' src/test/create-thumbnails.ts 500
```

#### ステップ2：画像パス情報のJSONファイルを更新する

ステップ1で作成したサムネイルを含め、すべての画像ファイルのパスを`image-paths.json`に書き出します。ギャラリーの設計図となる重要なファイルです。

```bash
bash
npx ts-node --compiler-options '{\"module\": \"CommonJS\"}' src/test/create-image-path-json.ts
```

#### ステップ3：HTMLギャラリーを生成する

ステップ2で作成した`image-paths.json`とHTMLテンプレートを元に、最終的な`gallery.html`を生成します。

```bash
npx ts-node --compiler-options '{\"module\": \"CommonJS\"}' src/test/generate-gallery.ts
```

完了後、`results/gallery.html`をブラウザで開くと、最新の状態でギャラリーが表示されます。

### 各スクリプトの詳細

- **`create-thumbnails.ts`**
  - **目的**: カメラ写真のサムネイルを一括生成します。
  - **機能**: `magick`コマンドを利用し、指定された幅を基準にアスペクト比を維持して画像をリサイズします。
  - **引数**: `<width>` (必須) - 生成するサムネイルの幅をピクセル単位で指定します。

- **`create-image-path-json.ts`**
  - **目的**: `results`フォルダをスキャンし、ギャラリー生成に必要な全画像（サムネイル含む）のパスをJSONファイルにまとめます。
  - **出力**: `results/image-paths.json`

- **`generate-gallery.ts`**
  - **目的**: `image-paths.json`と`src/test/templates/gallery-template.html`を組み合わせて、最終的な`results/gallery.html`を生成します。
  - **機能**: 一覧ではサムネイルを表示し、クリックでフルサイズの画像を表示する動的なHTMLを構築します.
