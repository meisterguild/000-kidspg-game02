# Smart App Control / Code Integrity にブロックされたものを1行ずつ返す。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File check-sac-blocks.ps1 -Minutes 10
#   powershell -NoProfile -ExecutionPolicy Bypass -File check-sac-blocks.ps1 -Since "2026-09-12T09:00:00"
#
# 出力: ブロックされたファイル名を1行ずつ（何も無ければ何も出さない）。
#       末尾に "COUNT=<件数>" を1行出す。呼び出し側はこれだけ見ればよい。
#
# ■ なぜこれが要るのか
# SAC に止められたときの見え方が**あまりにも分かりにくい**。
# 2026-09-09 の実測では、ComfyUI が
#   ImportError: DLL load failed while importing cython_special:
#     アプリケーション制御ポリシーによってこのファイルはブロックされました。
# という1行を残して落ちただけだった。当日スタッフがこれを見て
# 「SAC が原因」と判断するのは無理がある。
#
# そこで起動バッチと暖機スクリプトからこれを呼び、
# **「SAC がブロックしています」と名前で言う**ようにした。
# 原因が見えれば、暖機のやり直しか AI 変換を切る判断につなげられる。
#
# ■ 読めなくても止めない
# イベントログの購読には権限が要る環境もある。読めなければ何も出さず
# COUNT=-1 を返す（呼び出し側は「確かめられなかった」と扱う）。

[CmdletBinding()]
param(
    # 直近何分を見るか
    [int]$Minutes = 10,
    # 起点を明示したいとき（暖機スクリプトが使う）。指定すれば -Minutes より優先
    [string]$Since = ''
)

$ErrorActionPreference = 'Stop'

$start = if ($Since) { [datetime]::Parse($Since) } else { (Get-Date).AddMinutes(-$Minutes) }

try {
    $events = Get-WinEvent -FilterHashtable @{
        LogName   = 'Microsoft-Windows-CodeIntegrity/Operational'
        # 3033 / 3077 = 署名要件を満たさないものの読み込み、3118 = SAC のブロック詳細
        Id        = 3033, 3077, 3118
        StartTime = $start
    } -ErrorAction Stop
} catch [System.Exception] {
    # 「該当なし」も例外で来るので、メッセージで見分ける
    if ($_.Exception.Message -match 'No events were found|一致するイベント') {
        Write-Output 'COUNT=0'
        exit 0
    }
    Write-Output 'COUNT=-1'
    exit 0
}

# 同じファイルについて 3033 と 3077 が両方出るので、ファイル名で寄せる
$files = @{}
foreach ($e in $events) {
    # メッセージから「attempted to load <パス>」を抜く
    if ($e.Message -match 'attempted to load\s+(\S+)') {
        $path = $Matches[1]
        # \Device\HarddiskVolumeN\... の形なので、見て分かる形に縮める
        $short = ($path -replace '^\\Device\\HarddiskVolume\d+', '')
        if (-not $files.ContainsKey($short)) { $files[$short] = $e.TimeCreated }
    }
}

foreach ($k in ($files.Keys | Sort-Object)) {
    "{0:HH:mm:ss}  {1}" -f $files[$k], $k
}
"COUNT=$($files.Count)"
