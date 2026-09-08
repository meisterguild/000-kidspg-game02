#!/usr/bin/env bash
# AIサーバー（rag-poc）の共有ストアから、2026年版ワークフローに必要なモデルを
# ローカルの ComfyUI へ取り込む。
#
#   使い方:  bash tools/fetch-models.sh [ComfyUIのルート]
#   既定の取り込み先: C:/WORK/MGWork/05_kidspg/202609/ComfyUI
#
# 前提:
#   - `ssh rag-poc` で AI サーバーへ入れること
#   - llm-catalog のダウンロードキューが完了していること
#     （状態確認: curl -s http://192.168.1.10:50050/api/queue）
#
# 注意（Windows / Git Bash）:
#   scp は "C:/..." の `:` をホスト名の区切りと解釈して失敗する。
#   そのため転送には scp ではなく `ssh ... cat > file` を使っている。
set -uo pipefail

REMOTE="${REMOTE:-rag-poc}"
HF_ROOT="${HF_ROOT:-/srv/llm/hf/hub}"
COMFY_DIR="${1:-C:/WORK/MGWork/05_kidspg/202609/ComfyUI}"

# repo_id : ファイル名 : 配置先サブディレクトリ : 配置後の名前
ITEMS=(
  "cagliostrolab/animagine-xl-4.0:animagine-xl-4.0.safetensors:checkpoints:animagine-xl-4.0.safetensors"
  "xinsir/controlnet-union-sdxl-1.0:diffusion_pytorch_model_promax.safetensors:controlnet:controlnet-union-sdxl-promax.safetensors"
  "ByteDance/Hyper-SD:Hyper-SDXL-8steps-CFG-lora.safetensors:loras:Hyper-SDXL-8steps-CFG-lora.safetensors"
  "ByteDance/Hyper-SD:Hyper-SDXL-8steps-lora.safetensors:loras:Hyper-SDXL-8steps-lora.safetensors"
  "ByteDance/Hyper-SD:Hyper-SDXL-4steps-lora.safetensors:loras:Hyper-SDXL-4steps-lora.safetensors"
  "madebyollin/sdxl-vae-fp16-fix:sdxl_vae.safetensors:vae:sdxl_vae.safetensors"
)

local_size() {
  # Git Bash / Linux は stat -c、macOS は stat -f
  stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || echo 0
}

fail=0
for item in "${ITEMS[@]}"; do
  IFS=':' read -r repo file subdir asname <<< "$item"
  cache_dir="${HF_ROOT}/models--${repo//\//--}"

  echo "=== ${repo} / ${file}"

  # snapshots 配下は revision ハッシュで切られているため実体を探す。
  # -type f と -type l を明示的に括弧でまとめる（-o の優先順位対策）。
  remote_path="$(ssh "$REMOTE" "find '${cache_dir}/snapshots' \\( -type f -o -type l \\) -name '${file}' 2>/dev/null | head -1")"
  if [ -z "$remote_path" ]; then
    echo "  !! 見つかりません（ダウンロード未完了の可能性）: ${cache_dir}"
    fail=1
    continue
  fi
  # シンボリックリンクなら実体へ解決する
  remote_path="$(ssh "$REMOTE" "readlink -f '${remote_path}'")"
  size="$(ssh "$REMOTE" "stat -c %s '${remote_path}'")"
  echo "  remote: ${remote_path} ($((size / 1024 / 1024)) MB)"

  dest_dir="${COMFY_DIR}/models/${subdir}"
  mkdir -p "$dest_dir"
  dest="${dest_dir}/${asname}"

  if [ -f "$dest" ] && [ "$(local_size "$dest")" = "$size" ]; then
    echo "  すでに取得済み（サイズ一致）: ${dest}"
    continue
  fi

  echo "  -> ${dest}"
  # scp は Windows のドライブレター付きパスを扱えないので使わない
  if ssh "$REMOTE" "cat '${remote_path}'" > "${dest}.part"; then
    got="$(local_size "${dest}.part")"
    if [ "$got" = "$size" ]; then
      mv -f "${dest}.part" "$dest"
      echo "  OK (${got} bytes)"
    else
      echo "  !! サイズ不一致: 期待 ${size} / 取得 ${got}。${dest}.part を残します"
      fail=1
    fi
  else
    echo "  !! 転送に失敗しました"
    fail=1
  fi
done

echo
if [ "$fail" = 0 ]; then
  echo "すべて取得しました。ComfyUI を再起動して assets/ComfyUI_KidsPG_2026_01.json を読み込んでください。"
else
  echo "未取得のものがあります。キューの状態を確認してください:"
  echo "  curl -s http://192.168.1.10:50050/api/queue"
fi
exit "$fail"
