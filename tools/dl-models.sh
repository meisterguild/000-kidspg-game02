#!/usr/bin/env bash
# server プロファイル（GPU機・SDXL）用のモデルを HuggingFace から取得する。
#
# 2026-09-08 に C:\WORK\AI\dl-models.sh からリポジトリへ取り込んだ。
# それまで docs/comfyui-local-setup.md がリポジトリ外のこのスクリプトを
# 参照していて、**clone しただけでは環境を作り直せなかった**。
#
# local プロファイル（CPU実行・SD1.5）用は tools/dl-models-local.sh のほう。
# 当日使うのは activeProfile=local なので、通常はそちらが必要。
# KidsPG 2026: ComfyUI 用モデルを HuggingFace から直接取得する。
#   使い方: bash dl-models.sh [モデル置き場]  ... 既定 C:/WORK/AI/models
#
# AIサーバー(rag-poc)へ到達できない場所向けで、kidspg-game-2026/tools/fetch-models.sh の代替。
# 回線が細い（単一ストリームで実測 0.8MB/s 程度、合計 10.6GB）ため各ファイルを並列に落とす。
# **前夜から流しておくこと。** 有線接続推奨。
#
# レジューム(curl -C -)は使わない。HF の CDN が Range を無視して本体を丸ごと
# 追記してくることがあり、期待より大きい壊れたファイルができる（実際に踏んだ）。
# 取得中は .part に書き、サイズと sha256 が一致したときだけ本来の名前へ移すので、
# 壊れたものが models/ に残ることはない。
set -uo pipefail
ROOT="${1:-/c/WORK/AI/models}"
ATTEMPTS="${ATTEMPTS:-3}"

# サブディレクトリ | 配置後の名前 | URL
ITEMS=(
  "vae|sdxl_vae.safetensors|https://huggingface.co/madebyollin/sdxl-vae-fp16-fix/resolve/main/sdxl_vae.safetensors"
  "loras|Hyper-SDXL-8steps-CFG-lora.safetensors|https://huggingface.co/ByteDance/Hyper-SD/resolve/main/Hyper-SDXL-8steps-CFG-lora.safetensors"
  "loras|Hyper-SDXL-4steps-lora.safetensors|https://huggingface.co/ByteDance/Hyper-SD/resolve/main/Hyper-SDXL-4steps-lora.safetensors"
  "controlnet|controlnet-union-sdxl-promax.safetensors|https://huggingface.co/xinsir/controlnet-union-sdxl-1.0/resolve/main/diffusion_pytorch_model_promax.safetensors"
  "checkpoints|animagine-xl-4.0.safetensors|https://huggingface.co/cagliostrolab/animagine-xl-4.0/resolve/main/animagine-xl-4.0.safetensors"
)

size_of() { stat -c %s "$1" 2>/dev/null || echo 0; }

# HF は LFS 実体の sha256 を X-Linked-ETag ヘッダで返す。
# サイズ一致だけだと途中で壊れた場合に気づけないので、取得後にハッシュも照合する。
remote_head() { curl -sIL "$1" | tr -d '\r'; }
head_size()   { printf '%s\n' "$1" | grep -i '^content-length:' | tail -1 | awk '{print $2}'; }
head_sha256() { printf '%s\n' "$1" | grep -i '^x-linked-etag:' | tail -1 | grep -oE '[0-9a-f]{64}'; }
local_sha256(){ sha256sum "$1" 2>/dev/null | awk '{print $1}'; }

one() {
  local subdir asname url dest part head expect sha got actual attempt
  IFS='|' read -r subdir asname url <<< "$1"
  dest="${ROOT}/${subdir}/${asname}"
  part="${dest}.part"
  mkdir -p "$(dirname "$dest")"

  head="$(remote_head "$url")"
  expect="$(head_size "$head")"
  sha="$(head_sha256 "$head")"
  if [ -z "$expect" ]; then
    echo "FAIL ${asname} サイズを取得できません（gated repo で 401 の可能性。ブラウザで規約同意が要るか確認）"
    return 1
  fi

  if [ -f "$dest" ] && [ "$(size_of "$dest")" = "$expect" ]; then
    echo "SKIP ${asname} (取得済み ${expect})"; return 0
  fi

  for attempt in $(seq 1 "$ATTEMPTS"); do
    rm -f "$part"
    curl -sSL --retry 5 --retry-delay 5 --retry-all-errors -o "$part" "$url"
    got="$(size_of "$part")"
    if [ "$got" != "$expect" ]; then
      echo "RETRY ${asname} (${attempt}/${ATTEMPTS}) サイズ不一致 期待=${expect} 取得=${got}"
      continue
    fi
    if [ -n "$sha" ]; then
      actual="$(local_sha256 "$part")"
      if [ "$actual" != "$sha" ]; then
        echo "RETRY ${asname} (${attempt}/${ATTEMPTS}) sha256 不一致 期待=${sha} 取得=${actual}"
        continue
      fi
    fi
    mv -f "$part" "$dest"
    echo "OK   ${asname} ${got}${sha:+ (sha256 一致)}"
    return 0
  done

  rm -f "$part"
  echo "FAIL ${asname} 期待=${expect}"
  return 1
}

pids=()
for item in "${ITEMS[@]}"; do one "$item" & pids+=($!); done
fail=0
for p in "${pids[@]}"; do wait "$p" || fail=1; done
echo "DONE fail=${fail}"
exit "$fail"
