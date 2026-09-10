# 携帯版 ImageMagick が「なぜ」コーダーを読めないのかを1回で名指しする。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File check-imagemagick.ps1 -Dir C:\kidspg\bin\ImageMagick
#   powershell -NoProfile -ExecutionPolicy Bypass -File check-imagemagick.ps1 -Dir ... -Fix
#
# ■ なぜ要るのか（当日PCで実測 2026-09-10）
# magick.exe は動くのにコーダーだけが読めず、こう出た:
#
#   unable to load module '...\modules\coders\IM_MOD_RL_png_.dll':
#     指定されたモジュールが見つかりません。
#
# 🔴 **「見つかりません」は嘘に見えるが本当。** DLL 自体は在る（ハッシュ照合も通る）。
# Windows は、その DLL が**依存している別の DLL**を読めないときも
# ERROR_MOD_NOT_FOUND(126) を返す。犯人は依存側。
#
# 🔴 **開発機では絶対に再現しない。** 開発機は ImageMagick がインストール済みで、
# 本体のフォルダが常に PATH に入っているため、どう壊しても通ってしまう。
# ここまで「PATH が原因では」「コーダーの置き場では」「SAC では」と
# 当てずっぽうを重ねて実機を何度も往復させてしまった。
# **推測をやめ、LoadLibrary を直に呼んで Win32 のエラー番号で切り分ける。**
#
# ■ 切り分けの考え方
#   magick.exe が要求するのは CORE_RL_MagickCore_ / CORE_RL_MagickWand_ / VCRUNTIME140 だけ。
#   magick.exe が動いている＝この3つは読めている。
#   png コーダーはさらに CORE_RL_png_ と CORE_RL_zlib_ を要る。
#   → **この2つを直に読んでみれば、原因が「依存の不在」か「探索の届かなさ」か
#      「セキュリティのブロック」かが確定する。**
#
# ■ 出力
# 末尾に機械が読む1行を出す:
#   RESULT=OK
#   RESULT=NG CAUSE=<blocked|missing-dep|search-path|no-file|unknown>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Dir,
    [switch]$Fix
)

$ErrorActionPreference = 'Continue'
function Say([string]$m) { Write-Output $m }

# 本体の隣にあるはずのもの。png コーダーが要る2つを含む
$rootDlls = @(
    'CORE_RL_MagickCore_.dll',
    'CORE_RL_MagickWand_.dll',
    'CORE_RL_png_.dll',
    'CORE_RL_zlib_.dll'
)

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class ImLoad {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr LoadLibraryExW(string lpFileName, IntPtr hFile, uint dwFlags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FreeLibrary(IntPtr hModule);
    public static int Try(string path, uint flags) {
        IntPtr h = LoadLibraryExW(path, IntPtr.Zero, flags);
        if (h == IntPtr.Zero) { return Marshal.GetLastWin32Error(); }
        FreeLibrary(h);
        return 0;
    }
}
'@
$canLoad = $true
try { Add-Type -TypeDefinition $sig -ErrorAction Stop } catch { $canLoad = $false }

function Describe([int]$code) {
    switch ($code) {
        0    { 'OK' }
        2    { '2 ファイルが見つかりません' }
        5    { '5 アクセスが拒否（Smart App Control / ウイルス対策）' }
        126  { '126 依存している DLL を読めません' }
        193  { '193 32/64 ビットが合っていません' }
        1114 { '1114 DLL の初期化に失敗' }
        default { "$code" }
    }
}

function TryLoad([string]$path, [uint32]$flags) {
    if (-not $canLoad) { return -1 }
    return [ImLoad]::Try($path, $flags)
}

$cause = ''

# ------------------------------------------------------------ 1. ファイルの有無
Say ''
Say '--- 1. ファイルがあるか ---'
$missing = @()
foreach ($name in $rootDlls + @('magick.exe')) {
    $p = Join-Path $Dir $name
    if (Test-Path -LiteralPath $p -PathType Leaf) {
        Say ("  OK  {0}  ({1:N0} バイト)" -f $name, (Get-Item -LiteralPath $p).Length)
    } else {
        Say "  NG  $name がありません"
        $missing += $name
    }
}
$coderDir = Join-Path $Dir 'modules\coders'
$coderPng = Join-Path $coderDir 'IM_MOD_RL_png_.dll'
if (Test-Path -LiteralPath $coderPng -PathType Leaf) {
    $n = @(Get-ChildItem -LiteralPath $coderDir -Filter 'IM_MOD_RL_*.dll' -ErrorAction SilentlyContinue).Count
    Say "  OK  modules\coders（$n 個）"
} else {
    Say "  NG  modules\coders\IM_MOD_RL_png_.dll がありません"
    $missing += 'IM_MOD_RL_png_.dll'
}
if ($missing.Count -gt 0) {
    Say ''
    Say '  ★ ファイルが足りません。パッケージを作り直してください。'
    Say ''
    Say 'RESULT=NG CAUSE=no-file'
    exit 0
}

# ------------------------------------------------------------ 2. 記録が取れる状態か
Say ''
Say '--- 2. Smart App Control の記録 ---'
# 🔴 **「0 件」と「そもそも記録が無い」を混ぜない。** ログが無効だと
# Get-WinEvent は「該当なし」で返るので、0 件と見分けが付かない。
$logOn = $false
try {
    $lg = Get-WinEvent -ListLog 'Microsoft-Windows-CodeIntegrity/Operational' -ErrorAction Stop
    $logOn = $lg.IsEnabled
    Say ("  ログ: {0} / 記録数 {1}" -f $(if ($lg.IsEnabled) { '有効' } else { '無効' }), $lg.RecordCount)
} catch {
    Say '  ログの状態を読めません（権限か、ログがありません）'
}
if (-not $logOn) {
    Say '  ⚠️ 記録が無効なので「ブロック 0 件」は当てになりません。下の番号で判断します。'
}

# ------------------------------------------------------------ 3. 直に読んでみる
Say ''
Say '--- 3. DLL を直に読む（ここで原因が決まる） ---'
if (-not $canLoad) {
    Say '  [注意] LoadLibrary を呼べませんでした。番号で切り分けられません。'
    Say ''
    Say 'RESULT=NG CAUSE=unknown'
    exit 0
}

$results = @{}
foreach ($name in $rootDlls) {
    $code = TryLoad (Join-Path $Dir $name) 0x8
    $results[$name] = $code
    Say ("  {0,-28} -> {1}" -f $name, (Describe $code))
}

$savedPath = $env:PATH
$plain    = TryLoad $coderPng 0
$altered  = TryLoad $coderPng 0x8
$env:PATH = "$Dir;$savedPath"
$withPath = TryLoad $coderPng 0
$env:PATH = $savedPath

Say ("  {0,-28} -> {1}" -f 'IM_MOD_RL_png_ (そのまま)', (Describe $plain))
Say ("  {0,-28} -> {1}" -f 'IM_MOD_RL_png_ (DLL基準)', (Describe $altered))
Say ("  {0,-28} -> {1}" -f 'IM_MOD_RL_png_ (PATH追加)', (Describe $withPath))

# ------------------------------------------------------------ 4. 原因を決める
Say ''
Say '--- 4. 判定 ---'
$anyDenied = ($results.Values + @($plain, $altered, $withPath)) -contains 5
$coreBad = @($rootDlls | Where-Object { $results[$_] -ne 0 })

if ($anyDenied) {
    $cause = 'blocked'
    Say '  ★ アクセスが拒否されています（Smart App Control かウイルス対策）。'
    Say '    インターネットに繋いでから、この点検をもう一度実行してください。'
} elseif ($coreBad.Count -gt 0) {
    $cause = 'missing-dep'
    Say ('  ★ 本体側の DLL が読めません: ' + ($coreBad -join ', '))
    Say '    VC++ 2015-2022 ランタイムを入れてください（USB の prereq\VC_redist.x64.exe）。'
} elseif ($plain -ne 0 -or $altered -ne 0) {
    $cause = 'search-path'
    Say '  ★ 本体側の DLL は読めるのに、コーダーからは見つけられていません。'
    Say '    依存の探索がコーダーのフォルダまで届いていません。'
    if ($withPath -eq 0) {
        Say '    （PATH に本体のフォルダを足すと読めます）'
    }
    Say '    → -Fix を付けて実行すると、必要な DLL をコーダーの隣へ複製して直します。'
} else {
    Say '  すべて読めました。'
}

# ------------------------------------------------------------ 5. 直せるものは直す
if ($Fix -and $cause -eq 'search-path') {
    Say ''
    Say '--- 5. 直す（コーダーの隣へ必要な DLL を複製） ---'
    # 🔴 コーダーが要求する CORE_RL_* をコーダーと同じフォルダへ置けば、
    #    どの探索規則でも見つかる。約 3MB の重複で確実になる。
    $copied = 0
    foreach ($name in $rootDlls) {
        $src = Join-Path $Dir $name
        $dst = Join-Path $coderDir $name
        if (Test-Path -LiteralPath $dst -PathType Leaf) { continue }
        try {
            Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop
            Say "  複製: $name"
            $copied++
        } catch {
            Say "  [NG] 複製できません: $name（$($_.Exception.Message)）"
        }
    }
    Say "  $copied 個を複製しました"
    $plain2 = TryLoad $coderPng 0
    Say ('  もう一度読む -> ' + (Describe $plain2))
    if ($plain2 -eq 0) { $cause = '' }
}

# ------------------------------------------------------------ 6. 実際に PNG を書く
Say ''
Say '--- 6. magick で実際に PNG を書く ---'
$out = Join-Path $env:TEMP 'kidspg-imcheck.png'
Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
$env:MAGICK_HOME = $Dir
$env:MAGICK_CODER_MODULE_PATH = $coderDir
if (Test-Path -LiteralPath (Join-Path $Dir 'modules\filters')) {
    $env:MAGICK_FILTER_MODULE_PATH = Join-Path $Dir 'modules\filters'
}
if (Test-Path -LiteralPath (Join-Path $Dir 'colors.xml')) { $env:MAGICK_CONFIGURE_PATH = $Dir }
$env:PATH = "$Dir;$savedPath"
$stderr = Join-Path $env:TEMP 'kidspg-imcheck-err.txt'
$proc = Start-Process -FilePath (Join-Path $Dir 'magick.exe') `
    -ArgumentList '-size', '4x4', 'xc:white', "PNG:$out" `
    -NoNewWindow -Wait -PassThru -RedirectStandardError $stderr
$env:PATH = $savedPath
if ($proc.ExitCode -eq 0 -and (Test-Path -LiteralPath $out)) {
    Say '  OK : PNG を書けました'
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
} else {
    Say "  NG : 書けませんでした（終了コード $($proc.ExitCode)）"
    # 🔴 エラー本文は magick が ANSI(CP932) で書く。既定で読むと化ける
    if (Test-Path -LiteralPath $stderr) {
        Get-Content -LiteralPath $stderr -Encoding Default | ForEach-Object { Say "    $_" }
    }
    if (-not $cause) { $cause = 'unknown' }
}

Say ''
if ($cause) { Say "RESULT=NG CAUSE=$cause" } else { Say 'RESULT=OK' }
exit 0
