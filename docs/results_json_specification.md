# results.json ファイル仕様書

## 概要
`results/results.json`は、ゲームの結果データを管理するためのJSONファイルです。プレイヤーの最近のゲーム結果とランキング情報を保存します。

## ファイル構造

### トップレベル構造
```json
{
  "recent": [...],
  "ranking_top": [...]
}
```

### recent 配列
最近のゲーム結果を時系列順で管理します。

#### オブジェクト構造
| フィールド名 | 型 | 説明 |
|---|---|---|
| `resultPath` | string | 個別結果ファイルへの相対パス（YYYYMMDD_HHMMSS/result.json 形式） |
| `memorialCardPath` | string | 記念カード画像ファイルへの相対パス（YYYYMMDD_HHMMSS/memorial_card_YYYYMMDD_HHMMSS.png 形式） |
| `score` | number | ゲームスコア |
| `playedAt` | string | プレイ日時（YYYY-MM-DD HH:MM:SS 形式） |

#### 例
```json
{
  "resultPath": "20250818_003828/result.json",
  "memorialCardPath": "20250818_003828/memorial_card_20250818_003828.png",
  "score": 100,
  "playedAt": "2025-08-18 00:39:14"
}
```

### ranking_top 配列
スコア順でソートされたトップランキングを管理します。

#### オブジェクト構造
| フィールド名 | 型 | 説明 |
|---|---|---|
| `resultPath` | string | 個別結果ファイルへの相対パス |
| `memorialCardPath` | string | 記念カード画像ファイルへの相対パス |
| `score` | number | ゲームスコア |
| `rank` | number | ランキング順位（1位から連番） |

#### 例
```json
{
  "resultPath": "20250818_001906/result.json",
  "memorialCardPath": "20250818_001906/memorial_card_20250818_001906.png",
  "score": 200,
  "rank": 1
}
```

## データの特徴

### ファイルパス命名規則
- 結果ディレクトリ：`YYYYMMDD_HHMMSS/` 形式
- 個別結果ファイル：`result.json`
- 記念カード画像：`memorial_card_YYYYMMDD_HHMMSS.png`

### ソート順序
- **recent配列**: プレイ日時の新しい順
- **ranking_top配列**: スコアの高い順（同スコアの場合は順位で管理）

### データ管理
- 最近のプレイ結果は制限数で管理される可能性があります
- ランキングもトップN件で制限される可能性があります
- 各エントリは一意のタイムスタンプに基づいてディレクトリが作成されます

## 使用用途
- ゲーム結果の履歴表示
- ランキング表示
- 記念カード画像の表示
- 過去のプレイ記録の参照