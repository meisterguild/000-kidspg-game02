# Smart App Control / Code Integrity にブロックされたものを1行ずつ返す。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File check-sac-blocks.ps1 -Minutes 10
#   powershell -NoProfile -ExecutionPolicy Bypass -File check-sac-blocks.ps1 -Since "2026-09-12T09:00:00"
#
# 出力: ブロックされた「自分たちのファイル」を1行ずつ。末尾に3つの数を出す。
#         COUNT=<自分たちのファイルの件数>   ← 暖機の判定に使うのはこれ
#         OTHER=<無関係なソフトの件数>       ← 参考。0 にならなくても構わない
#         UNKNOWN=<誰のものか分からない件数> ← 0 でなければ「確かめられなかった」扱い
#
# ■ なぜ3つに分けるのか（敵対的レビュー 2026-09-09 の指摘）
#   ・無関係なブロックまで数えると、暖機の「0 件になるまで繰り返す」が
#     **永久に終わらない**。実例: bash.exe が pip.exe を読もうとしてブロック
#     （この企画とは無関係）
#   ・ID 3118（SAC のブロック詳細）はメッセージにパスが載らないため、
#     以前は1件も数えられず、**3118 だけが出た場合に「0 件」＝偽の成功**になっていた
#
# ■ なぜこれが要るのか
# SAC に止められたときの見え方が**あまりにも分かりにくい**。
# 2026-09-09 の実測では、ComfyUI が
#   ImportError: DLL load failed while importing cython_special:
#     アプリケーション制御ポリシーによってこのファイルはブロックされました。
# という1行を残して落ちただけだった。当日スタッフがこれを見て
# 「SAC が原因」と判断するのは無理がある。
#
# ■ 読めなくても止めない
# イベントログの購読には権限が要る環境もある。読めなければ -1 を返す
# （呼び出し側は「確かめられなかった」と扱う）。

[CmdletBinding()]
param(
    # 直近何分を見るか
    [int]$Minutes = 10,
    # 起点を明示したいとき（暖機スクリプトが使う）。指定すれば -Minutes より優先
    [string]$Since = '',
    # 「自分たちのファイル」と見なす目印。ここに当たったものだけを COUNT に数える
    [string]$Ours = 'python_embeded|ComfyUI|kidspg|electron|magick'
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
        Write-Output 'OTHER=0'
        Write-Output 'UNKNOWN=0'
        exit 0
    }
    Write-Output 'COUNT=-1'
    Write-Output 'OTHER=-1'
    Write-Output 'UNKNOWN=-1'
    exit 0
}

# 同じファイルについて 3033 と 3077 が両方出るので、ファイル名で寄せる。
# 🔴 変数名を $oursHits にしているのは、**PowerShell が変数名の大文字小文字を
# 区別しない**ため。$ours にすると引数の $Ours（判定用の正規表現）を上書きし、
# 一致判定が全部外れる（2026-09-09 に実際にそうなり、一覧が空になった）。
$oursHits = @{}
$otherHits = @{}
$unknown = 0

foreach ($e in $events) {
    $matched = $false
    if ($e.Message -match 'attempted to load\s+(\S+)') {
        $raw = $Matches[1]
        # \Device\HarddiskVolumeN\... の形なので、見て分かる形に縮める
        $short = $raw -replace '^\\Device\\HarddiskVolume\d+', ''
        if ($short -match $Ours) {
            if (-not $oursHits.ContainsKey($short)) { $oursHits[$short] = $e.TimeCreated }
        } else {
            if (-not $otherHits.ContainsKey($short)) { $otherHits[$short] = $e.TimeCreated }
        }
        $matched = $true
    }
    if (-not $matched -and $e.Id -eq 3118) {
        # SAC のブロック詳細。パスが載らないので誰のものか分からない。
        # 🔴 これを黙って捨てると「0 件＝暖機できた」と誤判定する
        $unknown++
    }
}

foreach ($k in ($oursHits.Keys | Sort-Object)) {
    '{0:HH:mm:ss}  {1}' -f $oursHits[$k], $k
}

Write-Output "COUNT=$($oursHits.Count)"
Write-Output "OTHER=$($otherHits.Count)"
Write-Output "UNKNOWN=$unknown"
