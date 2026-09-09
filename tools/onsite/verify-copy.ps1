# コピー先が SHA256SUMS と合っているかを数えて、食い違いの件数を返す。
#
# なぜ別ファイルにしてあるか:
# 0_setup.bat の中に長い PowerShell の1行を埋めると、cmd と PowerShell の
# 引用符が二重に絡み、「動いているのに何も返ってこない」壊れ方をする。
# そうなると当日「照合できていないのに OK に見える」ことが起きうるので、
# 引用符の入れ子が要らない形（-File）に分けている。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-copy.ps1 `
#       -SumFile D:\KidsPG2026_setup\SHA256SUMS -Target C:\kidspg
#
# 出力:
#   COPIED=<件数>  コピー先（C:\kidspg）で食い違った数。0 なら全部一致
#   MEDIA=<件数>   USB 側（payload の外＝prereq / bat / 手順書）で食い違った数
#
# ■ なぜ2つに分けるのか（敵対的レビュー 2026-09-09 の指摘）
# SHA256SUMS には payload の外のものも載る（prereq\VC_redist.x64.exe・
# 0_セットアップ.bat・手順書）。これらは**コピー先には置かれない**ので、
# コピー先で探すと必ず「食い違い」になる。かつ、
# USB 上でこれらが壊れている場合の対処は「コピーのやり直し」ではなく
# 「USB を作り直す」なので、数を分けないと当日の判断を誤らせる。
# とくに VC_redist は唯一インストール操作が要るもので、
# VC++ が無い機体で壊れたインストーラを渡されるのがいちばん困る。
#
# 実行できなかった場合は何も出さない（bat 側がそれを「照合できなかった」と扱う）。

param(
    [Parameter(Mandatory = $true)][string]$SumFile,
    [Parameter(Mandatory = $true)][string]$Target
)

$ErrorActionPreference = 'Stop'

# payload の外のものは USB のルート（SHA256SUMS のある場所）を起点に見る
$usbRoot = Split-Path -Parent (Resolve-Path -LiteralPath $SumFile)

$copiedBad = 0
$mediaBad = 0
foreach ($line in Get-Content -LiteralPath $SumFile -Encoding UTF8) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    # SHA256SUMS の1行は「<64桁のハッシュ><空白2つ><相対パス>」
    $parts = $line -split '  ', 2
    if ($parts.Count -ne 2) { $copiedBad++; continue }
    $hash = $parts[0].Trim()
    $rel = $parts[1].Trim()

    if ($rel -like 'payload/*') {
        # 目録は USB 側の payload/ を起点に書いてあるが、コピー先には payload/ が無い
        # （payload の中身をそのまま置くため）。そこだけ読み替える。
        $path = Join-Path $Target (($rel -replace '^payload/', '') -replace '/', '\')
        $isMedia = $false
    } else {
        # payload の外（prereq / bat / ps1 / 手順書 / manifest）は USB 側を見る
        $path = Join-Path $usbRoot ($rel -replace '/', '\')
        $isMedia = $true
    }

    $mismatch = $false
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $mismatch = $true
    } elseif ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $hash.ToUpper()) {
        $mismatch = $true
    }
    if ($mismatch) {
        if ($isMedia) { $mediaBad++ } else { $copiedBad++ }
    }
}

Write-Output "COPIED=$copiedBad"
Write-Output "MEDIA=$mediaBad"
