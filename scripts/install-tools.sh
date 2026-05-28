#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# install-tools.sh — 封闭内网 Linux (Ubuntu 24.04) 一键安装全工具链
# =============================================================================

# ---------- 颜色 ----------
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

banner() { echo -e "\n${CYAN}${BOLD}══════════════════════════════════════════${NC}"; echo -e "${CYAN}${BOLD}  $1${NC}"; echo -e "${CYAN}${BOLD}══════════════════════════════════════════${NC}\n"; }
ok()     { echo -e "  ${GREEN}✓${NC} $1"; }
fail()   { echo -e "  ${RED}✗${NC} $1"; }
warn()   { echo -e "  ${YELLOW}⚠${NC} $1"; }

# ---------- root 检查 ----------
if [[ "${EUID}" -ne 0 ]]; then
  echo -e "${RED}错误：请以 root 运行此脚本（sudo bash $0）${NC}"
  exit 1
fi

PASS=0; FAIL=0

verify() {
  local name="$1"
  if command -v "$name" &>/dev/null; then
    ok "$name  →  $(command -v "$name")"
    ((PASS++))
  else
    fail "$name 未找到"
    ((FAIL++))
  fi
}

# =============================================================================
banner "L1 地基层 — 构建工具"
# =============================================================================

apt-get update -qq
apt-get install -y build-essential cmake ninja-build make ccache
apt-get install -y bear

for t in g++ cmake ninja make ccache bear; do verify "$t"; done

# =============================================================================
banner "L2 静态分析层"
# =============================================================================

apt-get install -y clang-18 clangd-18 clang-tidy-18 clang-format-18
apt-get install -y clang-tools-18   # scan-build
apt-get install -y iwyu cppcheck

# symlinks: 版本号后缀 → 无后缀
for tool in clang clangd clang-tidy clang-format; do
  src="/usr/bin/${tool}-18"
  dst="/usr/local/bin/${tool}"
  if [[ -x "$src" ]]; then
    ln -sf "$src" "$dst"
    ok "symlink ${src} → ${dst}"
  else
    warn "${src} 不存在，跳过 symlink"
  fi
done

for t in clang clangd clang-tidy clang-format cppcheck include-what-you-use scan-build; do verify "$t"; done

# =============================================================================
banner "测试网 — GTest / 覆盖率"
# =============================================================================

apt-get install -y libgtest-dev libgmock-dev catch2
apt-get install -y gcovr lcov

# NOTE: libgtest-dev 只提供源码，需要编译安装静态库。
# 请运行同目录下的 setup-gtest.sh 完成编译：
#   bash "$(dirname "$0")/setup-gtest.sh"

for t in gcovr lcov; do verify "$t"; done

# =============================================================================
banner "L3 知识层"
# =============================================================================

# --- codegraph (via npm) ---
npm install -g @anthropic/codegraph 2>/dev/null || warn "codegraph 安装失败，可能需要手动处理"
verify "codegraph"

# --- ast-grep ---
# 内网环境：需预先下载预编译二进制到本机，然后放到 /opt/rust-bins/ 或直接安装。
# URL 模板: https://github.com/ast-grep/ast-grep/releases/download/{version}/sg-x86_64-unknown-linux-gnu.tar.gz
AST_GREP_VERSION="${AST_GREP_VERSION:-0.31.1}"
AST_GREP_URL="https://github.com/ast-grep/ast-grep/releases/download/${AST_GREP_VERSION}/sg-x86_64-unknown-linux-gnu.tar.gz"
AST_GREP_LOCAL="/opt/rust-bins/sg-x86_64-unknown-linux-gnu.tar.gz"

if command -v ast-grep &>/dev/null; then
  ok "ast-grep 已安装，跳过"
elif [[ -f "$AST_GREP_LOCAL" ]]; then
  tar xzf "$AST_GREP_LOCAL" -C /tmp/
  install -m 755 /tmp/sg /usr/local/bin/ast-grep
  ok "ast-grep 从本地缓存安装"
else
  warn "ast-grep 预编译包未找到（内网需预先下载到 ${AST_GREP_LOCAL}）"
  warn "下载地址: ${AST_GREP_URL}"
fi
verify "ast-grep"

# --- ctags & global ---
apt-get install -y universal-ctags global

for t in ctags global; do verify "$t"; done

# =============================================================================
banner "L4 智能层 (RAG) — ChromaDB"
# =============================================================================

pipx install chromadb || warn "chromadb 安装失败，可能需要手动处理"
verify "chromadb"

# =============================================================================
banner "Rust CLI 工具集"
# =============================================================================

# 内网环境：以下工具如果 apt 无法安装，需预先下载预编译二进制到 /opt/rust-bins/ 目录。
# 工具清单:
#   rg (ripgrep), fd (fd-find), bat, eza, fzf, delta (git-delta),
#   tokei, sd, dust, procs, btm (bottom), xh, tldr (tealdeer)

# apt 可装的部分
apt-get install -y ripgrep fd-find bat fzf || warn "部分 Rust CLI 通过 apt 安装失败"

# symlinks: Ubuntu 打包名 → 通用名
for pair in "fdfind:fd" "batcat:bat"; do
  src="${pair%%:*}"
  dst="${pair##*:}"
  src_path="$(command -v "$src" 2>/dev/null || true)"
  if [[ -n "$src_path" ]] && ! command -v "$dst" &>/dev/null; then
    ln -sf "$src_path" "/usr/local/bin/${dst}"
    ok "symlink ${src} → ${dst}"
  fi
done

# 从 /opt/rust-bins/ 安装其余工具（如果存在预编译二进制）
RUST_BINS_DIR="/opt/rust-bins"
declare -A RUST_TOOLS=(
  [eza]=eza
  [delta]=delta
  [tokei]=tokei
  [sd]=sd
  [dust]=dust
  [procs]=procs
  [btm]=btm
  [xh]=xh
  [tldr]=tldr
)
for tool in "${!RUST_TOOLS[@]}"; do
  bin="${RUST_TOOLS[$tool]}"
  if command -v "$tool" &>/dev/null; then
    ok "$tool 已存在"
  elif [[ -f "${RUST_BINS_DIR}/${bin}" ]]; then
    install -m 755 "${RUST_BINS_DIR}/${bin}" "/usr/local/bin/${tool}"
    ok "$tool 从 ${RUST_BINS_DIR} 安装"
  else
    warn "$tool 未安装（可将预编译二进制放到 ${RUST_BINS_DIR}/${bin}）"
  fi
done

for t in rg fd bat fzf eza delta tokei sd dust procs btm xh tldr; do verify "$t"; done

# =============================================================================
banner "安装摘要"
# =============================================================================

echo -e "  ${GREEN}PASS${NC}: ${PASS}"
echo -e "  ${RED}FAIL${NC}: ${FAIL}"
echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}全部工具就绪！${NC}"
else
  echo -e "  ${YELLOW}${BOLD}有 ${FAIL} 个工具未就绪，请检查上方输出。${NC}"
fi
echo ""
