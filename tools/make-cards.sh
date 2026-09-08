#!/usr/bin/env bash
# 2026年版 カード背景8種の生成。
#   bash tools/make-cards.sh
#
# 出力: assets_2026_draft/cards/bg-card-rank-0N-*.png（1017x1512）
# **既存の card_base_images_2026/ には触らない。**
#
# ■ 設計方針
# 8種は「ランクの高さ」を一目で伝えるためのもの。次の3軸を同時に上げていく。
#   1) 色      … 下位4段は色相で区別（ミント→スカイ→パープル→マゼンタ）、
#                 上位4段は誰でも順位と分かる金属階層（銅→銀→金→虹）
#   2) 装飾量  … キラキラの重ね枚数を段階的に増やす
#   3) 縁の強さ… 外周の光沢を段階的に強くする
#
# ■ ブランド資産は作らない
#   MEISTER GUILD / KidsPG! のロゴ、統計ラベルは card_base_images/kp_frame_sparkle.xcf
#   から透過のまま取り出したものを使う（parts/ 配下）。作字・再現はしない。
#
# ■ 座標の約束（変えると image-composition-config.ts と食い違う）
#   前景（AI画像）: (180,190) に 650x650
#   値テキスト    : gravity Center / x=140 の y=190,295,400,510
set -euo pipefail
cd "$(dirname "$0")/.."
P=assets_2026_draft/parts
OUT=assets_2026_draft/cards
mkdir -p "$OUT"
W=1017; H=1512

# ランクごとの配色:  名前|内側の主色|内側の副色|外周(枠)の色|バッジ地|キラキラ層|光沢の強さ(0-100)
RANKS=(
  "01-beginner|#7FD6C0|#A9E7DA|#BFEFE4|#FFFFFF|0|18"
  "02-amateur|#6FB6F0|#9CD2F7|#B8E0FA|#FFFFFF|0|26"
  "03-advanced|#A87BE0|#C6A4EE|#D9C2F5|#FFFFFF|3|34"
  "04-expert|#EE5FA0|#F792C0|#FBB8D6|#FFFFFF|4|42"
  "05-veteran|#C87438|#E29B5E|#F0BE8E|#FFF3E6|2|52"
  "06-elite|#98A6B4|#C3CDD7|#E2E8EE|#F7FAFC|0|64"
  "07-master|#D9A21B|#F0C64A|#F8DE8E|#FFF8E1|5|78"
  "08-legend|#8E6BD8|#E85FA0|#FFD429|#FFFFFF|6|92"
)

for spec in "${RANKS[@]}"; do
  IFS='|' read -r name c1 c2 edge badge sparkle gloss <<< "$spec"
  f="$OUT/bg-card-rank-${name}.png"
  echo "  生成: bg-card-rank-${name}.png"

  # 1) 外周（カードの縁）。上位ほど明るく光らせる
  if [ "$name" = "08-legend" ]; then
    # レジェンドだけ虹（ホログラム）。最上位だと一目で分かるようにする。
    # 原色のまま帯にすると縁がぎらついて安っぽくなるので、
    # 彩度を抑えたパステル虹を2枚ブレンドし、ぼかして光沢に馴染ませる。
    magick -size "${H}x${W}" gradient:'#FF9EC7-#9EE8FF' \
      -rotate 90 -resize "${W}x${H}!" \
      \( -size "${W}x${H}" gradient:'#FFE07A-#C9A8FF' -rotate 180 \) \
      -compose blend -define compose:args=50 -composite \
      -blur 0x18 "$f"
  else
    magick -size "${W}x${H}" radial-gradient:"${edge}"-"${c1}" -resize "${W}x${H}!" "$f"
  fi

  # 2) 内側パネル（角丸）。ここが「カードの地」になる
  magick "$f" \
    \( -size "$((W-64))x$((H-64))" radial-gradient:"${c2}"-"${c1}" -resize "$((W-64))x$((H-64))!" \
       \( -size "$((W-64))x$((H-64))" xc:black -fill white -draw "roundrectangle 0,0 $((W-65)),$((H-65)) 46,46" -alpha off \) \
       -compose CopyOpacity -composite \) \
    -geometry +32+32 -compose over -composite "$f"

  # 3) キラキラ。元データの層は「色地＋星」の不透明画像なので地の色を潰してしまう。
  #    星だけを透過で抜いた sparkles_only.png を使い、上位ほど濃く重ねる。
  op=$(awk "BEGIN{printf \"%.2f\", 0.35 + $gloss/100*0.65}")
  magick "$f"     \( "$P/sparkles_only.png" -channel A -evaluate multiply "$op" +channel \)     -compose over -composite "$f"
  # 上位ランクは星を二重にして密度を上げる（少しずらして重ねる）
  if [ "$gloss" -ge 50 ]; then
    magick "$f"       \( "$P/sparkles_only.png" -rotate 180 -channel A -evaluate multiply 0.55 +channel \)       -compose over -composite "$f"
  fi

  # 4) 外周の光沢リング（銅・銀・金・虹の格上げ表現）
  if [ "$gloss" -ge 50 ]; then
    magick "$f"       \( -size "${W}x${H}" xc:none -stroke "rgba(255,255,255,0.$((gloss)))"          -strokewidth 10 -fill none -draw "roundrectangle 44,44 $((W-45)),$((H-45)) 40,40"          -blur 0x3 \) -compose over -composite "$f"
  fi

  # 5) 統計パネル（半透明の角丸）→ 元データの plate をそのまま使う
  magick "$f" "$P/plate_stats.png" -compose over -composite "$f"

  # 6) ブランドロゴとラベル（作字せず元データを配置）
  magick "$f" \
    "$P/logo_meisterguild.png" -geometry +44+68   -compose over -composite \
    "$P/labels_stats.png"      -geometry +124+888 -compose over -composite \
    "$P/label_datetime.png"    -geometry +262+1231 -compose over -composite \
    "$P/logo_kidspg.png"       -geometry +277+1359 -compose over -composite \
    "$f"

  # 7) 右上バッジ「AIグミパク！」（2026-09-02 に名称確定）
  magick "$f" \
    \( -size 400x120 xc:none -fill "$badge" \
       -draw "roundrectangle 0,0 399,119 26,26" \
       -channel A -evaluate multiply 0.72 +channel \) \
    -geometry +556+64 -compose over -composite \
    -font "C:/Windows/Fonts/meiryob.ttc" -gravity NorthWest \
    -pointsize 62 -stroke '#FFFFFF' -strokewidth 10 -fill '#FFFFFF' \
    -annotate +578+90 'AIグミパク！' \
    -stroke none -fill '#D3593A' -annotate +578+90 'AIグミパク！' \
    "$f"
done

echo "完了: $OUT"
ls -1 "$OUT"
