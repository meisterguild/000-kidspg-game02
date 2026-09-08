
---

## 2026年版での実測メモ（2026-09-01）

### `npm run dist:win` はこのPCでは失敗する（インストーラが作れない）

```
ERROR: Cannot create symbolic link : クライアントは要求された特権を保有していません。 :
  ...\electron-builder\Cache\winCodeSign\...\darwin\10.12\lib\libcrypto.dylib
→ npm run dist:win は exit 1
```

electron-builder が署名用ツール（winCodeSign）を展開する際、アーカイブ内の
**macOS 用シンボリックリンクを作れず**に失敗する。Windows では既定で
シンボリックリンクの作成に特権が要るため。

**対処（いずれか）**
1. Windows の「開発者モード」を ON にする（非管理者でもシンボリックリンクを作れるようになる）
2. 管理者権限のシェルで1度だけ `npm run dist:win` を実行し、キャッシュを展開させる

### ただし `release/win-unpacked/` は正常に生成される

**昨年の配布形態（`KidsPGよけまくり中ゲーム-1.0.0-win` フォルダ）と同じもの**なので、
インストーラが作れなくても当日の配布・実行はこのフォルダで足りる。

実測で確認済み（2026-09-01）:

- `release/win-unpacked/KidsPG AIグミパク.exe` が起動する
- exe と同階層に `results/` が作られる
- `index.html` は `resources/app.asar/dist/renderer/` から読まれる
- RankingService が exe 横の `results/` を監視する
- `extraFiles` が exe 横に展開される
  （`config.json` / `assets` / `card_base_images` / `ranking.html` / `CREDITS.md` / `LICENSE`）
- `app.asar` に `node_modules/form-data` が含まれる
  （ComfyUI へのアップロードに必要。欠けると画像生成が全滅する）
