#!/usr/bin/env bash
set -euo pipefail

# macOS 未公证 DMG 构建：按当前构建机架构生成 ad-hoc 签名的 .app 与拖拽安装 DMG。
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
output="${1:?用法：build-macos-dmg.sh <新独占输出目录>}"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-macos-dmg.sh 必须在 macOS 构建机运行" >&2
  exit 1
fi
if [[ -e "$output" ]]; then
  echo "输出目录已存在：$output" >&2
  exit 1
fi
if [[ -e "$repo_root/apps/desktop/dist/resources" ]]; then
  echo "apps/desktop/dist/resources 已存在；请先确认并移除旧的装配产物" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/codeflow-dmg.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cd "$repo_root"

# 同一日期版本贯穿 Client 编译、资源清单和最终安装包，SEO 输出只写临时目录。
export CODEFLOWAI_DESKTOP_DMG_VERSION="${CODEFLOWAI_DESKTOP_DMG_VERSION:-$(date -u +%Y.%m.%d).01}"
export CODEFLOWAI_CLIENT_BUILD_VERSION="$CODEFLOWAI_DESKTOP_DMG_VERSION"
export CODEFLOWAI_CLIENT_BUILD_TARGET=prod
export VITE_CODEFLOWAI_SERVER_WS_ORIGIN=wss://codeflowai.cn
export CODEFLOWAI_SEO_OUTPUT_DIR="$work/seo"
export VITE_CODEFLOWAI_SEO_INDEXING_ENABLED=false

pnpm -C packages/shared build
pnpm -C apps/desktop/client build
pnpm -C apps/desktop build
pnpm -C apps/web build

# 临时安装固定 npm 运行时，prepare-resources 会把它打进桌面资源。
npm install --prefix "$work/npm12" --no-package-lock --no-fund --no-audit npm@12.2.2

# 生成带 node_modules 的 Client 归档；根目录必须是 package/。
# hoisted 布局避免 pnpm 默认 symlink 自引用导致系统 tar 报错。
mkdir -p "$work/client-pack"
pnpm --filter @codeflowai/client deploy --prod --legacy --node-linker=hoisted "$work/client-pack/package"
tar -chzf "$work/client.tgz" -C "$work/client-pack" package

node tools/ci/prepare-macos-resources.mjs "$work/client.tgz" "$work/npm12/node_modules/npm" "$work"

node apps/desktop/scripts/package-local-mac.mjs \
  "$repo_root/apps/desktop/dist/resources" "$output" --require-baseline-proof --target dmg
node tools/ci/record-desktop-package.mjs "$output"
