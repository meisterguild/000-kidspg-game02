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
#   UNREAD=<件数>  読めなかった数（排他・スキャン中）。0 でなければ「確かめられなかった」
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

# 🔴 **Stop のまま Get-FileHash を回してはいけない。** 排他で掴まれた／
# スキャン中の**1ファイル**でスクリプトが停止し、COPIED= も MEDIA= も
# 1行も出さずに終わる（実測 exit=1・無出力）。呼び出し側は
# 「[注意] 照合を実行できませんでした」＋警告1件で先へ進むので、
# **コピー破損も USB 破損もまとめて見逃す**（敵対的レビュー 2026-09-09 の指摘）。
# ファイルごとに受け止め、読めなかった数を別に返す。
$ErrorActionPreference = 'Stop'

# payload の外のものは USB のルート（SHA256SUMS のある場所）を起点に見る
$usbRoot = Split-Path -Parent (Resolve-Path -LiteralPath $SumFile)

$copiedBad = 0
$mediaBad = 0
$unread = 0

# 🔴 **目録そのものが壊れていることも見る。** SHA256SUMS は自分自身を
# 載せられないので、0バイト／途中で切れていても「すべて一致」になる。
# 行数がゼロなら照合していないのと同じ。
$lines = @(Get-Content -LiteralPath $SumFile -Encoding UTF8 | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($lines.Count -eq 0) {
    Write-Output 'COPIED=-1'
    Write-Output 'MEDIA=-1'
    Write-Output 'UNREAD=-1'
    exit 0
}
foreach ($line in $lines) {
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
    } else {
        # ファイルごとに受け止める（1つ読めないだけで全体を落とさない）
        try {
            $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash
            if ($actual -ne $hash.ToUpper()) { $mismatch = $true }
        } catch {
            $unread++
            continue
        }
    }
    if ($mismatch) {
        if ($isMedia) { $mediaBad++ } else { $copiedBad++ }
    }
}

Write-Output "COPIED=$copiedBad"
Write-Output "MEDIA=$mediaBad"
Write-Output "UNREAD=$unread"
