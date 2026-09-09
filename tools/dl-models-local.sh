#!/usr/bin/env bash
# local プロファイル（CPU実行・SD1.5）用のモデルを HuggingFace から取得する。
#
#   使い方: bash tools/dl-models-local.sh <ComfyUIのモデル置き場>
#   例:     bash tools/dl-models-local.sh C:/WORK/AI/models
#
# ■ なぜ要るか
# これまで手順書（docs/comfyui-local-setup.md）には **server プロファイル用の
# SDXL モデルしか書かれていなかった**。ところが config.json の activeProfile は
# `local` で、当日実際に使うのはこちらの SD1.5 の4本。
# 入手元がどこにも記録されていないため、環境を作り直せない状態だった（2026-09-08）。
#
# ■ サイズは実測値と一致することを確認済み（2026-09-08）
# 4本すべて、この URL の Content-Length が手元のファイルとバイト単位で一致する。
# ダウンロード後に検証するので、途中で切れたファイルを掴んだままにならない。
#
# ■ レジュームは使わない
# HF の CDN が Range を無視して全体を追記してくることがあり、
# **サイズ超過の壊れたファイル**ができた（dl-models.sh で実際に踏んだ）。
# 中断したら .part を消して取り直すこと。
set -uo pipefail

DEST_ROOT="${1:-}"
if [ -z "$DEST_ROOT" ]; then
  echo "使い方: bash tools/dl-models-local.sh <ComfyUIのモデル置き場>"
  echo "例:     bash tools/dl-models-local.sh C:/WORK/AI/models"
  exit 1
fi

# 配置先サブディレクトリ | 置いたあとの名前 | 期待バイト数 | URL
#
# 置いたあとの名前は **assets/ComfyUI_KidsPG_2026_local.json が指す名前** に
# そろえること。ここがずれると ComfyUI が「モデルが無い」で失敗し、
# 当日は全員のカードがプレースホルダのままになる。
ITEMS=(
  "checkpoints|DreamShaper_8_pruned.safetensors|2132625894|https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors"
  "vae|sd-vae-ft-mse.safetensors|334643276|https://huggingface.co/stabilityai/sd-vae-ft-mse/resolve/main/diffusion_pytorch_model.safetensors"
  "controlnet|control_v11p_sd15_canny.safetensors|1445157124|https://huggingface.co/lllyasviel/sd-controlnet-canny/resolve/main/diffusion_pytorch_model.safetensors"
  "loras|Hyper-SD15-8steps-CFG-lora.safetensors|269127064|https://huggingface.co/ByteDance/Hyper-SD/resolve/main/Hyper-SD15-8steps-CFG-lora.safetensors"
)

local_size() {
  stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || echo 0
}

fail=0
total=0
for item in "${ITEMS[@]}"; do
  IFS='|' read -r subdir asname expect url <<< "$item"
  dest_dir="${DEST_ROOT}/${subdir}"
  dest="${dest_dir}/${asname}"
  total=$((total + expect))

  echo "=== ${subdir}/${asname}  ($((expect / 1024 / 1024)) MB)"

  if [ -f "$dest" ] && [ "$(local_size "$dest")" = "$expect" ]; then
    echo "  すでに取得済み（サイズ一致）"
    continue
  fi

  mkdir -p "$dest_dir"
  echo "  <- ${url}"
  if curl -fL --retry 3 --retry-delay 5 -o "${dest}.part" "$url"; then
    got="$(local_size "${dest}.part")"
    if [ "$got" = "$expect" ]; then
      mv -f "${dest}.part" "$dest"
      echo "  OK (${got} bytes)"
    else
      echo "  !! サイズ不一致: 期待 ${expect} / 取得 ${got}"
      echo "     ${dest}.part を残します。消してから取り直してください"
      fail=1
    fi
  else
    echo "  !! ダウンロードに失敗しました"
    fail=1
  fi
done

echo
echo "合計 $((total / 1024 / 1024)) MB"
if [ "$fail" = 0 ]; then
  echo "すべて揃いました。ComfyUI を起動して確認してください:"
  echo "  curl -s http://127.0.0.1:8188/system_stats"
  echo "  node tools/comfyui-smoke.cjs"
else
  echo "未取得のものがあります。上のメッセージを確認してください。"
fi
exit "$fail"
