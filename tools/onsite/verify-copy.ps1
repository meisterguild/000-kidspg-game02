# コピー先が SHA256SUMS と合っているかを数えて、食い違いの件数だけを1行で返す。
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
# 出力: 食い違いの件数（数字1つだけ）。0 なら全部一致。
# 実行できなかった場合は何も出さない（bat 側がそれを「照合できなかった」と扱う）。

param(
    [Parameter(Mandatory = $true)][string]$SumFile,
    [Parameter(Mandatory = $true)][string]$Target
)

$ErrorActionPreference = 'Stop'

$bad = 0
foreach ($line in Get-Content -LiteralPath $SumFile -Encoding UTF8) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    # SHA256SUMS の1行は「<64桁のハッシュ><空白2つ><payload/ から始まる相対パス>」
    $parts = $line -split '  ', 2
    if ($parts.Count -ne 2) { $bad++; continue }
    $hash = $parts[0].Trim()
    $rel = $parts[1].Trim()

    # 目録は USB 側の payload/ を起点に書いてあるが、コピー先には payload/ が無い
    # （payload の中身をそのまま置くため）。そこだけ読み替える。
    $rel = $rel -replace '^payload/', ''
    $path = Join-Path $Target ($rel -replace '/', '\')

    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $bad++; continue }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $hash.ToUpper()) { $bad++ }
}

# 数字1つだけを返す。bat 側は for /f でこれを受ける
Write-Output $bad
