#!/usr/bin/env bash
# AIサーバーの共有ストアから、2026年版ワークフローに必要なモデルを
# ローカルへ取り込む。**社内 LAN にいるなら HuggingFace から落とすより速い。**
#
#   使い方:  bash tools/fetch-models.sh [モデル置き場] [profile]
#   例:      bash tools/fetch-models.sh C:/WORK/AI/models local
#            bash tools/fetch-models.sh C:/WORK/AI/models all
#
#   profile: local（既定・当日使う SD1.5 の4本）/ server（SDXL の6本）/ all
#
# ■ 接続先の指定
# REMOTE は **各自の ~/.ssh/config で定義した Host 名**を渡す。
# 既定値は置いていない（個人の設定名をリポジトリへ持ち込まないため）。
#
#   ~/.ssh/config の例:
#     Host ai-server
#         HostName 192.168.1.10
#         User <自分のアカウント>
#         IdentityFile ~/.ssh/id_ed25519
#
#   REMOTE=ai-server bash tools/fetch-models.sh C:/WORK/AI/models local
#
# ■ サーバー上のモデルの在り処
# HuggingFace の hub キャッシュがそのまま共有ストアになっている。
#
#   /srv/llm/hf/hub/models--<org>--<repo>/snapshots/<revision>/<ファイル名>   ← シンボリックリンク
#   /srv/llm/hf/hub/models--<org>--<repo>/blobs/<sha256>                      ← 実体
#
# revision は落とした時期で変わるので、パスを決め打ちせず snapshots 配下を
# find して readlink -f で実体へ解決している。
# 直接見たいときは:
#   ssh "$REMOTE" 'ls /srv/llm/hf/hub | grep models--'
#   ssh "$REMOTE" 'du -sh /srv/llm/hf/hub/models--Lykon--DreamShaper'
#
# キャッシュに無いものは、サーバー側の llm-catalog へダウンロードを積む:
#   curl -s http://192.168.1.10:50050/api/queue
#
# 前提:
#   - `ssh "$REMOTE"` で AI サーバーへ入れること
#   - llm-catalog のダウンロードキューが完了していること
#     （状態確認: curl -s http://192.168.1.10:50050/api/queue）
#
# 注意（Windows / Git Bash）:
#   scp は "C:/..." の `:` をホスト名の区切りと解釈して失敗する。
#   そのため転送には scp ではなく `ssh ... cat > file` を使っている。
set -uo pipefail

REMOTE="${REMOTE:-}"
if [ -z "$REMOTE" ]; then
  echo "REMOTE が未設定です。AI サーバーへの ssh Host 名を渡してください。"
  echo "  例: REMOTE=ai-server bash tools/fetch-models.sh C:/WORK/AI/models local"
  echo "  ~/.ssh/config での定義例はこのファイルの冒頭にあります。"
  exit 1
fi
HF_ROOT="${HF_ROOT:-/srv/llm/hf/hub}"

# 第1引数はモデル置き場（dl-models.sh / dl-models-local.sh と同じ意味）。
# ComfyUI のルートを渡されても動くよう、main.py があれば models を足す
# （以前の使い方が手順書に残っているため）。
MODELS_ROOT="${1:-C:/WORK/AI/models}"
if [ -f "${MODELS_ROOT}/main.py" ]; then
  MODELS_ROOT="${MODELS_ROOT}/models"
fi
PROFILE="${2:-local}"

# repo_id : サーバー上のファイル名 : 配置先サブディレクトリ : 配置後の名前
#
# 🔴 **配置後の名前はワークフロー JSON が参照する名前**。
# assets/ComfyUI_KidsPG_2026_local.json（local）と
# assets/ComfyUI_KidsPG_2026_01.json（server）に合わせてある。
# ずれると ComfyUI が「モデルが無い」で落ち、全員のカードがプレースホルダになる。

# local プロファイル（CPU実行・SD1.5）。**当日使うのはこちら**。合計 約4.1GB
LOCAL_ITEMS=(
  "Lykon/DreamShaper:DreamShaper_8_pruned.safetensors:checkpoints:DreamShaper_8_pruned.safetensors"
  "stabilityai/sd-vae-ft-mse:diffusion_pytorch_model.safetensors:vae:sd-vae-ft-mse.safetensors"
  "lllyasviel/sd-controlnet-canny:diffusion_pytorch_model.safetensors:controlnet:control_v11p_sd15_canny.safetensors"
  "ByteDance/Hyper-SD:Hyper-SD15-8steps-CFG-lora.safetensors:loras:Hyper-SD15-8steps-CFG-lora.safetensors"
)

# server プロファイル（GPU機・SDXL）。合計 約10.6GB
SERVER_ITEMS=(
  "cagliostrolab/animagine-xl-4.0:animagine-xl-4.0.safetensors:checkpoints:animagine-xl-4.0.safetensors"
  "xinsir/controlnet-union-sdxl-1.0:diffusion_pytorch_model_promax.safetensors:controlnet:controlnet-union-sdxl-promax.safetensors"
  "ByteDance/Hyper-SD:Hyper-SDXL-8steps-CFG-lora.safetensors:loras:Hyper-SDXL-8steps-CFG-lora.safetensors"
  "ByteDance/Hyper-SD:Hyper-SDXL-8steps-lora.safetensors:loras:Hyper-SDXL-8steps-lora.safetensors"
  "ByteDance/Hyper-SD:Hyper-SDXL-4steps-lora.safetensors:loras:Hyper-SDXL-4steps-lora.safetensors"
  "madebyollin/sdxl-vae-fp16-fix:sdxl_vae.safetensors:vae:sdxl_vae.safetensors"
)

case "$PROFILE" in
  local)  ITEMS=("${LOCAL_ITEMS[@]}") ;;
  server) ITEMS=("${SERVER_ITEMS[@]}") ;;
  all)    ITEMS=("${LOCAL_ITEMS[@]}" "${SERVER_ITEMS[@]}") ;;
  *)
    echo "profile は local / server / all のいずれかです（指定: $PROFILE）"
    exit 1
    ;;
esac

echo "取り込み先: ${MODELS_ROOT}"
echo "プロファイル: ${PROFILE}（${#ITEMS[@]} 件）"
echo

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

  dest_dir="${MODELS_ROOT}/${subdir}"
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
  echo "すべて取得しました。ComfyUI を再起動して確認してください:"
  echo "  curl -s http://127.0.0.1:8188/system_stats"
  echo "  node tools/comfyui-smoke.cjs"
else
  echo "未取得のものがあります。キューの状態を確認してください:"
  echo "  curl -s http://192.168.1.10:50050/api/queue"
fi
exit "$fail"
