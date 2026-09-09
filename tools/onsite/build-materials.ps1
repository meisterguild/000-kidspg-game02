# 当日PC向けパッケージの「リポジトリの外の資材」を、開発機で1回だけ組む。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\onsite\build-materials.ps1
#
# 組んだあとは tools\make-onsite-package.cjs がここからコピーするだけになる。
# 何が要るかの一覧と期待サイズは tools\onsite-materials.json。
#
# ■ 冪等
# すでに出来ているものは飛ばす。途中で失敗したら、直して同じコマンドをもう一度。
#
# ■ 2026-09-09 に実際に組んで踏んだ落とし穴（すべてこの中で対処している）
#   1. python312._pth の `import site` を有効にしないと、pip で入れたものを
#      一切 import できない（pip は成功するので気づきにくい）
#   2. さらに `..\ComfyUI` の行が要る。**_pth を使うと sys.path はその中身だけ**に
#      なり、スクリプトのフォルダも cwd も入らないため、main.py の 1 行目
#      `import comfy.options` が ModuleNotFoundError になる
#   3. robocopy の /XD は**名前一致**なので、`/XD input` は深い階層の
#      `comfy_api\input` まで消す。実際にそれで ComfyUI が起動しなくなった。
#      **フルパスで指定する**
#   4. ComfyUI の requirements.txt（版が緩い）ではなく requirements.lock.txt
#      （86 パッケージ・版固定）を使う。しかも **torch より後に**入れる
#   5. ImageMagick の携帯版 zip はもう配布されていない（インストーラのみ）。
#      開発機にインストール済みのフォルダを複製する
#
# ■ 🔴 顔写真を持ち出さないこと
# 開発機の ComfyUI の input/ には検証で使った実際の子どもの顔写真が溜まる。
# output/ にはそこから作った絵が残る。**どちらも複製しない。**
# 万一の混入は make-onsite-package.cjs 側でも機械的に止めている。

[CmdletBinding()]
param(
    [string]$Materials = 'C:\WORK\AI\onsite-materials',
    [string]$ComfyUISource = 'C:\WORK\AI\ComfyUI_20260902_0.34.0\ComfyUI',
    [string]$ModelsSource = 'C:\WORK\AI\models',
    [string]$ImageMagickSource = 'C:\Program Files\ImageMagick-7.1.2-Q16',
    [string]$LockFile = 'C:\WORK\AI\requirements.lock.txt',
    [string]$PythonVersion = '3.12.10',
    [string]$NodeVersion = '24.16.0'
)

$ErrorActionPreference = 'Stop'

function Say([string]$m) { Write-Host $m }
function Step([string]$m) { Write-Host ''; Write-Host "=== $m ===" }
function Die([string]$m) { Write-Host ''; Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

# 期待サイズは目録（onsite-materials.json）を正とする。2箇所に書かない
$manifestPath = Join-Path $PSScriptRoot '..\onsite-materials.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { Die "目録がありません: $manifestPath" }
$manifest = Get-Content -Raw -Encoding UTF8 $manifestPath | ConvertFrom-Json

$PY = Join-Path $Materials 'ai\python_embeded'
$COMFY = Join-Path $Materials 'ai\ComfyUI'
$MODELS = Join-Path $Materials 'ai\models'
$MAGICK = Join-Path $Materials 'bin\ImageMagick'
$NODE = Join-Path $Materials 'ops\node'

foreach ($d in @($Materials, (Join-Path $Materials 'ai'), (Join-Path $Materials 'bin'), (Join-Path $Materials 'ops'), (Join-Path $Materials 'prereq'))) {
    New-Item -ItemType Directory -Force $d | Out-Null
}

# ------------------------------------------------------------------ ComfyUI 本体
Step 'ComfyUI 本体を複製する（venv と顔写真は除く）'
if (-not (Test-Path -LiteralPath (Join-Path $ComfyUISource 'main.py'))) {
    Die "ComfyUI が見つかりません: $ComfyUISource"
}
# 🔴 /XD は名前一致なのでフルパスで指定する（落とし穴3）。
#    __pycache__ だけはどこにあっても不要なので名前指定でよい。
$xd = @(
    (Join-Path $ComfyUISource 'venv'),    # 別PCでは壊れる（pyvenv.cfg の home）
    (Join-Path $ComfyUISource '.git'),    # 82MB。コミットは PINNED.md に記録
    (Join-Path $ComfyUISource 'input'),   # 🔴 実際の顔写真
    (Join-Path $ComfyUISource 'output'),  # 🔴 そこから作った絵
    (Join-Path $ComfyUISource 'user'),    # 開発機の画面設定
    (Join-Path $ComfyUISource 'logs'),
    (Join-Path $ComfyUISource 'temp')
) + @('__pycache__')
robocopy $ComfyUISource $COMFY /MIR /XD $xd /NFL /NDL /NJH /NJS /R:2 /W:2 | Out-Null
if ($LASTEXITCODE -ge 8) { Die "robocopy が失敗しました ($LASTEXITCODE)" }
# ComfyUI は input / output を使うので、空のフォルダだけ用意する
foreach ($d in @('input', 'output')) { New-Item -ItemType Directory -Force (Join-Path $COMFY $d) | Out-Null }
# 落とし穴3 の再発を検出する。comfy_api\input が消えていたら起動しない
if (-not (Test-Path -LiteralPath (Join-Path $COMFY 'comfy_api\input'))) {
    Die 'comfy_api\input が複製されていません（/XD の名前一致で消えた可能性。フルパス指定を確認）'
}
$s = Get-ChildItem -Recurse -File $COMFY | Measure-Object Length -Sum
Say ('       {0:N1} MB / {1} ファイル' -f ($s.Sum / 1MB), $s.Count)

# ------------------------------------------------------------------ 埋め込み Python
Step "埋め込み Python $PythonVersion を組む"
if (Test-Path -LiteralPath (Join-Path $PY 'Lib\site-packages\torch')) {
    Say '       すでに出来ているので飛ばします'
} else {
    $zipName = "python-$PythonVersion-embed-amd64.zip"
    $zipPath = Join-Path $Materials $zipName
    if (-not (Test-Path -LiteralPath $zipPath)) {
        Say "       取得中: $zipName"
        Invoke-WebRequest "https://www.python.org/ftp/python/$PythonVersion/$zipName" -OutFile $zipPath -UseBasicParsing
    }
    Say ('       zip : {0:N0} バイト' -f (Get-Item $zipPath).Length)
    Expand-Archive $zipPath -DestinationPath $PY -Force

    # 落とし穴1・2 をまとめて直す
    $pth = Join-Path $PY ('python' + ($PythonVersion -replace '^(\d+)\.(\d+).*$', '$1$2') + '._pth')
    if (-not (Test-Path -LiteralPath $pth)) { Die "_pth が見つかりません: $pth" }
    $fixed = @()
    foreach ($line in Get-Content $pth) {
        if ($line -eq '.') {
            $fixed += $line
            # 🔴 _pth を使うと sys.path はこの中身だけ。ComfyUI の場所を明示しないと
            #    import comfy が失敗する。python.exe のあるフォルダ基準の相対指定なので、
            #    丸ごとコピーしても壊れない
            $fixed += '..\ComfyUI'
        } elseif ($line -match '^#\s*import site') {
            # 🔴 これを有効にしないと pip で入れたものを一切 import できない
            $fixed += 'import site'
        } else {
            $fixed += $line
        }
    }
    $fixed | Set-Content $pth -Encoding ASCII
    Say '       _pth を直しました（import site と ..\ComfyUI）'

    Say '       pip を入れます'
    $getPip = Join-Path $PY 'get-pip.py'
    Invoke-WebRequest 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getPip -UseBasicParsing
    & (Join-Path $PY 'python.exe') $getPip --no-warn-script-location | Out-Null
    if ($LASTEXITCODE -ne 0) { Die 'pip を入れられませんでした' }

    # 落とし穴4: torch を先に、CPU 版インデックスを明示して入れる
    Say '       torch（CPU 版・約1.9GB）を入れます。数分かかります'
    & (Join-Path $PY 'python.exe') -m pip install --no-warn-script-location --progress-bar off `
        torch==2.13.0+cpu torchvision==0.28.0+cpu torchaudio==2.11.0+cpu `
        --index-url https://download.pytorch.org/whl/cpu
    if ($LASTEXITCODE -ne 0) { Die 'torch を入れられませんでした' }

    if (-not (Test-Path -LiteralPath $LockFile)) { Die "版の固定ファイルがありません: $LockFile" }
    Say '       ComfyUI の依存（86 パッケージ・版固定）を入れます'
    & (Join-Path $PY 'python.exe') -m pip install --no-warn-script-location --progress-bar off -r $LockFile
    if ($LASTEXITCODE -ne 0) { Die '依存を入れられませんでした' }
}

# ------------------------------------------------------------------ モデル
Step 'モデルを複製する（local プロファイル用の4本だけ）'
$modelDef = $manifest.materials | Where-Object { $_.key -eq 'models' }
foreach ($f in $modelDef.files) {
    $src = Join-Path $ModelsSource $f.path
    $dst = Join-Path $MODELS $f.path
    if (-not (Test-Path -LiteralPath $src)) { Die "モデルがありません: $src`n      取得は bash tools/dl-models-local.sh $ModelsSource" }
    New-Item -ItemType Directory -Force (Split-Path -Parent $dst) | Out-Null
    if (-not (Test-Path -LiteralPath $dst)) { Copy-Item -LiteralPath $src -Destination $dst }
    # サイズ照合。途中で切れたファイルを掴んだまま当日を迎えないため
    $n = (Get-Item -LiteralPath $dst).Length
    if ($n -ne $f.expectedBytes) { Die "$($f.path) のサイズが違います（期待 $($f.expectedBytes) / 実際 $n）" }
    Say ('       OK : {0}' -f $f.path)
}

# ------------------------------------------------------------------ ImageMagick
Step 'ImageMagick を複製する'
# 落とし穴5: 携帯版 zip の配布はもう無い。インストール済みのフォルダを複製する。
# カード合成が検証されている版（開発機と同じもの）を使えるので、そのほうが安全。
if (-not (Test-Path -LiteralPath (Join-Path $ImageMagickSource 'magick.exe'))) {
    Die "ImageMagick が見つかりません: $ImageMagickSource"
}
robocopy $ImageMagickSource $MAGICK /MIR /XF unins000.exe unins000.dat /NFL /NDL /NJH /NJS /R:2 /W:2 | Out-Null
if ($LASTEXITCODE -ge 8) { Die "robocopy が失敗しました ($LASTEXITCODE)" }
$s = Get-ChildItem -Recurse -File $MAGICK | Measure-Object Length -Sum
Say ('       {0:N1} MB / {1} ファイル' -f ($s.Sum / 1MB), $s.Count)

# ------------------------------------------------------------------ Node
Step "Node $NodeVersion（携帯版）を用意する"
if (Test-Path -LiteralPath (Join-Path $NODE 'node.exe')) {
    Say '       すでにあるので飛ばします'
} else {
    $zipName = "node-v$NodeVersion-win-x64.zip"
    $zipPath = Join-Path $Materials $zipName
    if (-not (Test-Path -LiteralPath $zipPath)) {
        Say "       取得中: $zipName"
        Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/$zipName" -OutFile $zipPath -UseBasicParsing
    }
    # 公式の一覧と SHA256 を突き合わせる
    $sums = (Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
    $want = ($sums -split "`n" | Where-Object { $_ -like "*$zipName" } | Select-Object -First 1) -split '\s+' | Select-Object -First 1
    $got = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
    if ($want -ne $got) { Die "Node の SHA256 が合いません（公式 $want / 実際 $got）" }
    Say "       SHA256 一致 : $got"
    $tmp = Join-Path $Materials '_node_tmp'
    Expand-Archive $zipPath -DestinationPath $tmp -Force
    $inner = Get-ChildItem -Directory $tmp | Select-Object -First 1
    robocopy $inner.FullName $NODE /MIR /NFL /NDL /NJH /NJS /R:2 /W:2 | Out-Null
    Remove-Item -LiteralPath $tmp -Recurse -Force
}

# ------------------------------------------------------------------ 仕上げの確認
Step '仕上げの確認'
$pyExe = Join-Path $PY 'python.exe'

Push-Location $COMFY
try {
    & $pyExe -c "import comfy.options; import torch, scipy.stats; print('       OK : import comfy / torch / scipy', torch.__version__)"
    if ($LASTEXITCODE -ne 0) { Die 'ComfyUI の import が通りません（_pth の ..\ComfyUI を確認）' }
} finally { Pop-Location }

& (Join-Path $MAGICK 'magick.exe') -version | Select-Object -First 1 | ForEach-Object { Say "       OK : $_" }
& (Join-Path $NODE 'node.exe') -v | ForEach-Object { Say "       OK : node $_" }

# 🔴 顔写真が混じっていないかを、ここでも見る
$bad = Get-ChildItem -Recurse -File $Materials -Include 'photo_*.png', 'photo_anime_*', 'compare_*', 'memorial_card_*' -ErrorAction SilentlyContinue
if ($bad) {
    Say ''
    Say '🔴 持ち出してはいけないものが混じっています:'
    $bad | Select-Object -First 10 | ForEach-Object { Say ('       ' + $_.FullName) }
    Die '取り除いてから作り直してください'
}
Say '       OK : 顔写真・生成画像は入っていません'

$s = Get-ChildItem -Recurse -File $Materials -ErrorAction SilentlyContinue | Measure-Object Length -Sum
Say ''
Say ('✓ 資材が揃いました : {0}  合計 {1:N1} GB' -f $Materials, ($s.Sum / 1GB))
Say ''
Say '  ⚠️ このあと ComfyUI を一度起こして、1枚生成できることを必ず確かめること。'
Say '     Smart App Control が有効な機体では、**初回だけ**未署名の .pyd が'
Say '     ブロックされて落ちることがある（2026-09-09 に実測。再実行で通った）。'
Say ''
Say '  次: node tools\make-onsite-package.cjs --out <USB のドライブ>'
