#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# verify-tools.sh — 工具链冒烟测试
# 用法: bash verify-tools.sh [<目标项目路径>]
# =============================================================================

PROJECT_DIR="${1:-}"

# ---------- 颜色 ----------
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0; FAIL=0; SKIP=0

banner() { echo -e "\n${CYAN}${BOLD}── $1 ──${NC}"; }

check() {
  local label="$1"
  shift
  if ! command -v "${1}" &>/dev/null 2>&1; then
    echo -e "  ${YELLOW}SKIP${NC}  ${label}  (未安装)"
    SKIP=$((SKIP + 1))
    return
  fi
  if "$@" &>/dev/null 2>&1; then
    echo -e "  ${GREEN}PASS${NC}  ${label}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC}  ${label}"
    FAIL=$((FAIL + 1))
  fi
}

check_file() {
  local label="$1"
  local path="$2"
  if [[ -f "$path" ]]; then
    echo -e "  ${GREEN}PASS${NC}  ${label}  (${path})"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC}  ${label}  (${path} 不存在)"
    FAIL=$((FAIL + 1))
  fi
}

check_python() {
  local label="$1"
  local code="$2"
  if python3 -c "$code" &>/dev/null 2>&1; then
    echo -e "  ${GREEN}PASS${NC}  ${label}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${YELLOW}SKIP${NC}  ${label}  (Python 模块不可用)"
    SKIP=$((SKIP + 1))
  fi
}

# =============================================================================
banner "L1 地基层"
# =============================================================================
check "g++"           g++ --version
check "cmake"         cmake --version
check "ninja"         ninja --version
check "make"          make --version
check "bear"          bear --version
check "ccache"        ccache --version

# =============================================================================
banner "L2 静态分析层"
# =============================================================================
check "clang-tidy"    clang-tidy --version
check "clang-format"  clang-format --version
check "clangd"        clangd --version
check "cppcheck"      cppcheck --version
check "iwyu"          include-what-you-use --version
check "scan-build"    scan-build --help

# =============================================================================
banner "L3 知识层"
# =============================================================================
check "codegraph"     codegraph --help
check "ast-grep"      ast-grep --version
check "ctags"         ctags --version
check "global"        global --version

# =============================================================================
banner "L4 智能层 (RAG)"
# =============================================================================
check_python "chromadb" "import chromadb; print(chromadb.__version__)"

# =============================================================================
banner "测试网"
# =============================================================================
# gtest: 搜索系统标准路径
GTEST_LIB=$(find /usr/lib /usr/local/lib -name 'libgtest.a' 2>/dev/null | head -1)
if [[ -n "$GTEST_LIB" ]]; then
  echo -e "  ${GREEN}PASS${NC}  libgtest.a  (${GTEST_LIB})"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${NC}  libgtest.a  (未找到)"
  FAIL=$((FAIL + 1))
fi
check "gcovr"         gcovr --version
check "lcov"          lcov --version

# =============================================================================
banner "Rust CLI 工具集"
# =============================================================================
check "rg"            rg --version
check "fd"            fd --version
check "bat"           bat --version
check "eza"           eza --version
check "fzf"           fzf --version
check "delta"         delta --version
check "tokei"         tokei --version
check "sd"            sd --version
check "dust"          dust --version
check "procs"         procs --version
check "btm"           btm --version
check "xh"            xh --version
check "tldr"          tldr --version

# =============================================================================
# 项目级验证（可选）
# =============================================================================
if [[ -n "$PROJECT_DIR" ]]; then
  banner "项目级验证 — ${PROJECT_DIR}"
  check_file "compile_commands.json"  "${PROJECT_DIR}/compile_commands.json"
  check_file "REFACTOR_STATE.md"      "${PROJECT_DIR}/state/REFACTOR_STATE.md"
  check_file "PARTITION_LEDGER.md"    "${PROJECT_DIR}/state/PARTITION_LEDGER.md"
  check_file "TOOL_GAPS.md"           "${PROJECT_DIR}/state/TOOL_GAPS.md"
fi

# =============================================================================
banner "总结"
# =============================================================================
TOTAL=$((PASS + FAIL + SKIP))
echo -e "  ${GREEN}PASS${NC}: ${PASS}  ${RED}FAIL${NC}: ${FAIL}  ${YELLOW}SKIP${NC}: ${SKIP}  总计: ${TOTAL}"
echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}全部通过！${NC}"
else
  echo -e "  ${YELLOW}${BOLD}有 ${FAIL} 项失败，请检查上方输出。${NC}"
fi
echo ""
exit "$FAIL"
