#!/usr/bin/env bash
# 2026年版ビジュアル素材の生成。
#   bash tools/make-assets.sh
#
# 参照デザイン（docs/asset-replacement-plan.md）の配色と質感を、
# ImageMagick だけで再現する。外部サービスも生成AIも使わないので、
# 何度でも同じものが出る＝当日までに微調整を繰り返せる。
#
# 出力先は assets_2026_draft/。**既存の素材には触らない。**
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=assets_2026_draft
mkdir -p "$OUT/parts"

# --- 参照デザインから抽出したパレット ---
BG_MAIN='#FFD429'; BG_SUB='#FFE87A'
P_PINK='#F0417E'; P_GREEN='#7BC62D'; P_ORANGE='#F5901E'
P_BLUE='#3AA0E8'; P_PURPLE='#A855C8'; P_YELLOW='#FFC820'
INK='#D3593A'

# ---------------------------------------------------------------------------
# グミの立方体。半透明のゼリーらしさを「面ごとの明度差＋上面のハイライト」で出す。
#   gummy <色> <出力> [サイズ]
# ---------------------------------------------------------------------------
gummy() {
  local col="$1" out="$2" s="${3:-256}"
  local top side front
  # 面ごとの明度差でゼリーらしい厚みを出す（上面=明るい/側面=暗い）
  top="$(magick xc:"$col" -modulate 132,102 -format '%[hex:u.p{0,0}]' info:)"
  side="$(magick xc:"$col" -modulate 76,112 -format '%[hex:u.p{0,0}]' info:)"
  front="$(magick xc:"$col" -modulate 102,108 -format '%[hex:u.p{0,0}]' info:)"

  # 4倍で描いてから縮小する（角の丸めとアンチエイリアスをきれいに出すため）
  local S=$((s*4))
  local a=$((S*14/100)) b=$((S*34/100)) c=$((S*60/100)) d=$((S*88/100))
  local e=$((S*18/100)) g=$((S*70/100)) f=$((S*40/100)) h=$((S*12/100))
  local r=$((S*7/100))

  magick -size "${S}x${S}" xc:none     -fill "#${front}" -stroke none -draw "polygon $a,$b $c,$b $c,$d $a,$d"     -fill "#${side}"            -draw "polygon $c,$b $d,$e $d,$g $c,$d"     -fill "#${top}"             -draw "polygon $a,$b $f,$h $d,$e $c,$b"     -channel A -blur 0x${r} -level 45%,55% +channel     \( -clone 0 -alpha extract -morphology EdgeIn Octagon:1        -fill white -colorize 0 \) -delete 1     \( -size "${S}x${S}" xc:none -fill 'rgba(255,255,255,0.70)'        -draw "roundrectangle $((S*20/100)),$((S*40/100)) $((S*34/100)),$((S*60/100)) $((S*6/100)),$((S*6/100))"        -blur 0x$((S/70)) \) -compose over -composite     \( -size "${S}x${S}" xc:none -fill 'rgba(255,255,255,0.45)'        -draw "ellipse $((S*46/100)),$((S*24/100)) $((S*16/100)),$((S*6/100)) 0,360"        -blur 0x$((S/60)) \) -compose over -composite     -resize "${s}x${s}"     "$out"
}

echo "[1/6] グミの立方体を作成"
gummy "$P_PINK"   "$OUT/parts/gummy_pink.png"
gummy "$P_GREEN"  "$OUT/parts/gummy_green.png"
gummy "$P_ORANGE" "$OUT/parts/gummy_orange.png"
gummy "$P_BLUE"   "$OUT/parts/gummy_blue.png"
gummy "$P_PURPLE" "$OUT/parts/gummy_purple.png"
gummy "$P_YELLOW" "$OUT/parts/gummy_yellow.png"

# ---------------------------------------------------------------------------
# マスコット。参照デザインの白いおばけを、円＋目＋頬＋口で近似する。
#   mascot <出力> <サイズ>
# ---------------------------------------------------------------------------
echo "[2/6] マスコットを作成"
mascot() {
  local out="$1" s="${2:-512}"
  local cx=$((s/2)) cy=$((s*46/100)) r=$((s*33/100))
  magick -size "${s}x${s}" xc:none \
    -fill '#FFFFFF' -stroke none -draw "circle $cx,$cy $cx,$((cy-r))" \
    -draw "roundrectangle $((cx-r)),$((cy)) $((cx+r)),$((cy+r*9/10)) $((r/3)),$((r/3))" \
    -fill '#F1EAE2' -draw "ellipse $cx,$((cy+r*85/100)) $((r*95/100)),$((r*16/100)) 0,360" \
    -fill '#FFFFFF' -draw "ellipse $cx,$((cy+r*72/100)) $((r*98/100)),$((r*30/100)) 0,360" \
    -fill '#2A1330' \
    -draw "ellipse $((cx-r*36/100)),$((cy-r*6/100)) $((r*15/100)),$((r*19/100)) 0,360" \
    -draw "ellipse $((cx+r*36/100)),$((cy-r*6/100)) $((r*15/100)),$((r*19/100)) 0,360" \
    -fill '#FFFFFF' \
    -draw "circle $((cx-r*31/100)),$((cy-r*13/100)) $((cx-r*31/100)),$((cy-r*19/100))" \
    -draw "circle $((cx+r*41/100)),$((cy-r*13/100)) $((cx+r*41/100)),$((cy-r*19/100))" \
    -fill '#FF9DBB' \
    -draw "ellipse $((cx-r*58/100)),$((cy+r*22/100)) $((r*17/100)),$((r*11/100)) 0,360" \
    -draw "ellipse $((cx+r*58/100)),$((cy+r*22/100)) $((r*17/100)),$((r*11/100)) 0,360" \
    -fill '#C0392B' -draw "ellipse $cx,$((cy+r*30/100)) $((r*17/100)),$((r*13/100)) 0,180" \
    "$out"
}
mascot "$OUT/parts/mascot.png" 512

echo "[3/6] キラキラを作成"
magick -size 128x128 xc:none -fill white \
  -draw "polygon 64,4 74,54 124,64 74,74 64,124 54,74 4,64 54,54" \
  -channel A -blur 0x1 +channel "$OUT/parts/sparkle.png"

echo "[4/6] パレット見本を作成"
magick -size 900x140 xc:'#FFFFFF' \
  \( -size 120x100 xc:"$BG_MAIN" \) -geometry +20+20 -composite \
  \( -size 120x100 xc:"$P_PINK" \)   -geometry +150+20 -composite \
  \( -size 120x100 xc:"$P_GREEN" \)  -geometry +280+20 -composite \
  \( -size 120x100 xc:"$P_ORANGE" \) -geometry +410+20 -composite \
  \( -size 120x100 xc:"$P_BLUE" \)   -geometry +540+20 -composite \
  \( -size 120x100 xc:"$P_PURPLE" \) -geometry +670+20 -composite \
  \( -size 120x100 xc:"$INK" \)      -geometry +800+20 -composite \
  "$OUT/palette.png"
echo "部品の生成が完了しました: $OUT/parts/"

# ---------------------------------------------------------------------------
# 背景（放射状の光 + キラキラ）。明るい版と、黒画面になじむ暗い版の2種を作る。
#   backdrop <出力> <W> <H> <bright|dark>
# ---------------------------------------------------------------------------
backdrop() {
  local out="$1" w="$2" h="$3" mode="$4"
  local c1 c2
  if [ "$mode" = bright ]; then c1="$BG_SUB"; c2="$BG_MAIN"; else c1='#2E1B4D'; c2='#150C24'; fi
  # 中心から外へのグラデーション
  magick -size "${w}x${h}" radial-gradient:"${c1}"-"${c2}" -resize "${w}x${h}!" "$out"
  # 放射状の光条を薄く重ねる
  local cx=$((w*62/100)) cy=$((h*45/100)) i ang x2 y2
  local ray='rgba(255,255,255,0.10)'
  [ "$mode" = bright ] || ray='rgba(160,120,255,0.10)'
  local args=()
  for i in $(seq 0 23); do
    ang=$((i*15))
    x2=$(( cx + (w*12/10) * $(awk "BEGIN{printf \"%d\", cos($ang*3.14159/180)*100}") / 100 ))
    y2=$(( cy + (w*12/10) * $(awk "BEGIN{printf \"%d\", sin($ang*3.14159/180)*100}") / 100 ))
    args+=( -draw "stroke $ray stroke-width $((w/90)) line $cx,$cy $x2,$y2" )
  done
  magick "$out" -fill none "${args[@]}" "$out"
  # キラキラを散らす
  local n sx sy ss
  for n in $(seq 1 14); do
    sx=$(( (n*137) % (w-80) + 20 ))
    sy=$(( (n*211) % (h-80) + 20 ))
    ss=$(( 26 + (n*37) % 46 ))
    magick "$out" \( "$OUT/parts/sparkle.png" -resize "${ss}x${ss}" \) \
      -geometry "+${sx}+${sy}" -compose over -composite "$out"
  done
}

# ---------------------------------------------------------------------------
# タイトル画像。1536x1024（表示は 3:2 で object-cover）
#   title <出力> <bright|dark>
# ---------------------------------------------------------------------------
title() {
  local out="$1" mode="$2"
  local W=1536 H=1024
  local sub2='#FFFFFF' subcol="$INK"
  [ "$mode" = dark ] && { subcol='#FFD429'; sub2='#E8D8FF'; }

  backdrop "$out" "$W" "$H" "$mode"

  # 右側にグミを積む（参照デザインの立体パズルに相当）
  local col order=(pink green orange blue purple yellow green pink blue)
  local i=0 gx gy gs r c
  for r in 0 1 2; do
    for c in 0 1 2; do
      col="${order[$i]}"; i=$((i+1))
      gs=$((250 - r*10))
      gx=$(( 880 + c*190 - r*70 ))
      gy=$(( 300 + r*175 - c*40 ))
      magick "$out" \( "$OUT/parts/gummy_${col}.png" -resize "${gs}x${gs}" \)         -geometry "+${gx}+${gy}" -compose over -composite "$out"
    done
  done
  magick "$out" \( "$OUT/parts/mascot.png" -resize 300x300 \)     -geometry "+1010+430" -compose over -composite "$out"

  # 見出し。参照デザインに合わせ「AI」＋「グミパク！」の2行、
  # 2行目は1文字ずつ色を変える（原色の面塗り＋白フチ＋落ち影）。
  local FONT="C:/Windows/Fonts/meiryob.ttc"
  magick "$out" -font "$FONT" -gravity NorthWest     -pointsize 200 -stroke '#FFFFFF' -strokewidth 28 -fill '#FFFFFF' -annotate +96+120 'AI'     -stroke none -fill '#A02BC8' -annotate +96+120 'AI'     "$out"

  # 2行目を1文字ずつ。全角なので pointsize と同じ幅で送る
  local chars=('グ' 'ミ' 'パ' 'ク' '！')
  local cols=("$P_PINK" "$P_GREEN" "$P_ORANGE" "$P_PINK" "$P_BLUE")
  local ps=170 x=96 y=350 k
  for k in 0 1 2 3 4; do
    magick "$out" -font "$FONT" -gravity NorthWest -pointsize "$ps"       -stroke '#FFFFFF' -strokewidth 26 -fill '#FFFFFF' -annotate "+${x}+${y}" "${chars[$k]}"       -stroke none -fill "${cols[$k]}" -annotate "+${x}+${y}" "${chars[$k]}"       "$out"
    x=$(( x + ps + 6 ))
  done

  # 帯（キャッチコピー）
  magick "$out"     \( -size 820x92 xc:none -fill "$INK" -draw "roundrectangle 0,0 819,91 46,46" \)     -geometry +100+590 -compose over -composite     -font "$FONT" -gravity NorthWest     -pointsize 50 -stroke none -fill '#FFFFFF' -annotate +140+612 'ぜんぶ食べてカードをゲット！'     -pointsize 44 -fill "$sub2" -annotate +104+730 'KidsPG フェスいたみ 2026'     "$out"
}

echo "[5/6] タイトル画像を作成"
title "$OUT/title_bright.png" bright
title "$OUT/title_dark.png"   dark

# ---------------------------------------------------------------------------
# アイコン。512x512。小さくても何のアプリか分かるよう、グミ3個＋マスコットに絞る。
# ---------------------------------------------------------------------------
echo "[6/6] アイコンを作成"
magick -size 512x512 radial-gradient:"$BG_SUB"-"$BG_MAIN" -resize '512x512!' \
  \( "$OUT/parts/gummy_pink.png"   -resize 250x250 \) -geometry +30+130  -composite \
  \( "$OUT/parts/gummy_blue.png"   -resize 250x250 \) -geometry +240+130 -composite \
  \( "$OUT/parts/gummy_green.png"  -resize 250x250 \) -geometry +135+250 -composite \
  \( "$OUT/parts/mascot.png"       -resize 250x250 \) -geometry +230+30  -composite \
  "$OUT/icon_512.png"
magick "$OUT/icon_512.png" -define icon:auto-resize=256,128,64,48,32,24,16 "$OUT/icon.ico"

# 写真プレースホルダ。人物ではないこと（顔写真を使わない方針）を明示する絵にする。
magick -size 380x380 radial-gradient:"$BG_SUB"-"$BG_MAIN" -resize '380x380!' \
  \( "$OUT/parts/mascot.png" -resize 250x250 \) -geometry +65+70 -composite \
  "$OUT/placeholder_photo.png"

echo "完了: $OUT/"
ls -1 "$OUT"
