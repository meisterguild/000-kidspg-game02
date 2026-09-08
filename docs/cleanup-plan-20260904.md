# 2025年版の残骸クリーニング計画（2026-09-04）

昨年（2025「よけまくり中」）のプラットフォームを流用しているため、2026年版では使わない資材が
リポジトリに残っています。その棚卸しと、削除の可否・順序をまとめます。

- 対象ブランチ: `review/full-code-review`
- 前提: **すべて git 追跡下**にあり、削除しても履歴から取り出せます
  （`git log --diff-filter=D -- <path>` で削除コミットを特定 → `git show <commit>^:<path>`）
- 2025年版リポジトリ（`000-kidspg-game01`）にも同じ資材が残っています

---

## 目次

- [いちばん効く指摘](#いちばん効く指摘)
- [フェーズ1: 配布物を軽くする（推奨・即実行可）](#フェーズ1-配布物を軽くする推奨即実行可)
- [フェーズ2: 動かないコードを消す](#フェーズ2-動かないコードを消す)
- [フェーズ3: 古い手順書とワークフロー](#フェーズ3-古い手順書とワークフロー)
- [削除しないもの（残す判断）](#削除しないもの残す判断)
- [各フェーズの検証手順](#各フェーズの検証手順)

---

## いちばん効く指摘

**未参照の2025年素材 19MB が、毎回のビルドと配布パッケージに入っています。**
`dist/renderer/` は 24MB ありますが、そのうち **19MB（約79%）が誰も読まない画像**です。

原因は `src/renderer/utils/assets.ts` のこの1行です。

```ts
return new URL(`../assets/images/${relativePath}`, import.meta.url).href;
```

Vite は `new URL(..., import.meta.url)` を静的に解析しますが、**パスが変数を含む場合は
そのディレクトリの中身を丸ごとバンドルへ含めます**。つまり
`src/renderer/assets/images/` に置いてあるだけで、コードから一切参照されていなくても
配布物に入ります。GIMP の原本（`sprite_items.xcf` 4.4MB）まで同梱されています。

実験で確認済みです。`title_image_02.png` を一時的に退避してビルドすると、
`dist/renderer/assets/` からも消えました。**ファイルを消せば配布物からも消えます。**

---

## フェーズ1: 配布物を軽くする（推奨・即実行可）

未参照かつ2025年専用の画像素材です。削除するとビルドと配布物が 19MB 軽くなります。

| 対象 | 内容 | サイズ | 参照 |
|---|---|---:|---|
| `src/renderer/assets/images/title_image_01〜04.png` | 2025「よけまくり中」のタイトル画像4枚 | 12.9 MB | コードからの参照なし（`assets.ts` に「参照しない」と明記済み） |
| `src/renderer/assets/images/sprite_items.png` | 2025 の2Dゲーム用スプライトシート | 1.6 MB | PixiJS 版とともに役目を終えている |
| `src/renderer/assets/images/sprite_items.xcf` | 上記の GIMP 原本 | 4.4 MB | 同上。**原本を配布物に入れる必要はない** |

**リスク: 低。** いずれもコードからの参照がありません。
TOP 画面のタイトルは `title_gummy_01.png`（2026年版）を使っており、これは残します。

あわせて `CREDITS.md` の該当行（「**未使用**（2025年…）」と書かれている2行）を削除します。

---

## フェーズ2: 動かないコードを消す

| 対象 | 状態 |
|---|---|
| `src/renderer/test/SpriteViewerTest.tsx` | **コンパイルが通らない**ため `tsconfig.json` の `exclude` で型検査から外されている。存在しないアセットキー `'spriteItems'` を参照している。どこからも import されていない |
| `README_SPRITE_TEST.md` | 上記の手順書 |
| `src/renderer/components/ranking/StatusBar.tsx` | どこからも import されていない |
| `src/main/services/memorial-card-test.ts` | 呼び出し元なし。`package.json` のスクリプトにも無い |
| `test-memorial-card.js`（ルート） | 2025年の結果フォルダ（`results/20250816_172248`）を例示する手動テスト。参照なし |

削除にあわせて `tsconfig.json` の `exclude` から `SpriteViewerTest.tsx` の行も外します
（除外する対象が無くなるため）。

**リスク: 低。** ただし `memorial-card-test.ts` は「1件のカードだけ手で作り直して確かめる」
用途に使える可能性があります。残すなら **README に実行方法を書く**のが条件です
（書かれていない道具は当日使われません）。

---

## フェーズ3: 古い手順書とワークフロー

| 対象 | 判断 |
|---|---|
| `web-app-instructions.md` | **削除推奨。** 冒頭が「KidsPGよけまくり中ゲーム - Web版配布」。2026年版は Electron 前提で、Web 版配布の予定はない |
| `windows-build-instructions.md` | **統合推奨。** 内容は 2026 でも通用する（`npm run dist:win`）。ただし README の「開発」節と重複している。README へ吸収して1本化 |
| `assets/ComfyUI_KidsPG_01〜03.json` | **保留を推奨。** 2025年版のワークフロー3種。`WD14Tagger` `HEDPreprocessor` など 2026年版では使っていないノードを含む。`docs/comfyui_integration_design.md` から参照されている（設計の経緯として意味がある）。合計 24KB と小さいので、急いで消す利得はない |

---

## 削除しないもの（残す判断）

| 対象 | 理由 |
|---|---|
| `docs/memorial_site_src/`（18.5 MB） | **2025年のカード公開サイト一式。2026年も同じ方式で公開する方針なので、これは「昨年の残骸」ではなく今年の雛形です。** HTML・OGP画像・説明資料（pptx/pdf）が揃っており、作り直すより流用するほうが早い |
| `card_base_images/superseded_*/` | 差し替え前のカード背景。`package.json` の `extraFiles` で配布物からは除外済みなので、残しても配布サイズに影響しない |
| `docs/bug_report_*.md`（14件） | 過去の不具合と対処の記録。同じ踏み方を繰り返さないための資産 |
| `src/renderer/assets/images/title_gummy_01.png` | 2026年版の TOP タイトル画像（現役） |

---

## 各フェーズの検証手順

各フェーズの後に必ず実行します。

```bash
npm run build            # main(tsc) と renderer(vite)
npx tsc --noEmit         # src/test を含む全体の型検査
npm run lint
npm test                 # 単体テスト 107 件

# 実アプリの通し（ComfyUI を止めた状態で可）
node tools/e2e-local-play.cjs --no-ai --plays 2
```

フェーズ1のあとは、**配布物が実際に軽くなったか**も確認します。

```bash
du -sh dist/renderer      # 24MB → 5MB 程度になる見込み
ls dist/renderer/assets/  # title_image_* と sprite_items.* が消えていること
```

TOP 画面のタイトル画像が出ることは、アプリを起動して目視で確認してください
（`title_gummy_01.png` は残すので出るはずですが、画像まわりを触るため）。

---

## まとめ

| フェーズ | 削減 | リスク | 実行の可否 |
|---|---:|---|---|
| 1. 未参照の2025画像 | **19 MB**（配布物） | 低 | すぐ実行できます |
| 2. 動かないコード | 37 KB | 低 | すぐ実行できます |
| 3. 古い手順書 | 8 KB | 低〜中（統合作業を伴う） | 内容の確認後 |

削減量ではフェーズ1が突出しています。**配布パッケージのサイズと、当日のPCへコピーする
時間に直接効く**ので、ここだけでも先に実行することをお勧めします。
