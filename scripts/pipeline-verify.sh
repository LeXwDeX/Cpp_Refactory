#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# pipeline-verify.sh — 重构流水线验证阶段
# 用法: bash pipeline-verify.sh [<项目路径>] [<stage>]
#
# 验证项:
#   1. 编译检查 (cmake/make/ninja)
#   2. 测试执行 (ctest/googletest)
#   3. 静态分析 (clang-tidy, cppcheck)
#   4. 增量验证 (只检查变更文件)
#
# 输出: JSON 结构化结果 (stderr) + 人类可读摘要 (stdout)
# =============================================================================

PROJECT_DIR="${1:-.}"
STAGE="${2:-verify}"
PROJECT_DIR="$(cd "$PROJECT_DIR" 2>/dev/null && pwd || echo "$PROJECT_DIR")"

# ---------- 颜色 ----------
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0; FAIL=0; WARN=0
ERRORS=()

banner() { echo -e "\n${CYAN}${BOLD}── $1 ──${NC}"; }

# =============================================================================
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════${NC}"
echo -e "${CYAN}${BOLD}  重构流水线验证 — ${STAGE}${NC}"
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════${NC}"
echo ""
echo -e "项目目录: ${BOLD}$PROJECT_DIR${NC}"

# =============================================================================
banner "1. 编译检查"
# =============================================================================

BUILD_OK=true
BUILD_SYSTEM=""

if [[ -f "$PROJECT_DIR/CMakeLists.txt" ]]; then
    BUILD_SYSTEM="cmake"
    if [[ -d "$PROJECT_DIR/build" ]]; then
        echo -e "  检测到 CMake 项目 + build 目录"
        if (cd "$PROJECT_DIR/build" && cmake --build . --target all 2>&1 | tail -5); then
            echo -e "  ${GREEN}✓${NC} 编译成功"
            ((PASS++))
        else
            echo -e "  ${RED}✗${NC} 编译失败"
            ERRORS+=("compilation_failed")
            BUILD_OK=false
            ((FAIL++))
        fi
    else
        echo -e "  ${YELLOW}⚠${NC} 无 build 目录，跳过编译"
        ((WARN++))
    fi
elif [[ -f "$PROJECT_DIR/Makefile" ]]; then
    BUILD_SYSTEM="make"
    echo -e "  检测到 Makefile"
    if (cd "$PROJECT_DIR" && make -j$(nproc) 2>&1 | tail -5); then
        echo -e "  ${GREEN}✓${NC} 编译成功"
        ((PASS++))
    else
        echo -e "  ${RED}✗${NC} 编译失败"
        ERRORS+=("compilation_failed")
        BUILD_OK=false
        ((FAIL++))
    fi
else
    echo -e "  ${YELLOW}⚠${NC} 未检测到构建系统 (CMakeLists.txt / Makefile)"
    ((WARN++))
fi

# =============================================================================
banner "2. 测试执行"
# =============================================================================

TEST_OK=true

if [[ -d "$PROJECT_DIR/build" ]] && command -v ctest &>/dev/null; then
    echo -e "  尝试 ctest..."
    if (cd "$PROJECT_DIR/build" && ctest --output-on-failure 2>&1 | tail -10); then
        echo -e "  ${GREEN}✓${NC} 测试通过"
        ((PASS++))
    else
        echo -e "  ${RED}✗${NC} 测试失败"
        ERRORS+=("test_failed")
        TEST_OK=false
        ((FAIL++))
    fi
elif [[ -f "$PROJECT_DIR/Makefile" ]] && grep -q "test" "$PROJECT_DIR/Makefile" 2>/dev/null; then
    echo -e "  尝试 make test..."
    if (cd "$PROJECT_DIR" && make test 2>&1 | tail -10); then
        echo -e "  ${GREEN}✓${NC} 测试通过"
        ((PASS++))
    else
        echo -e "  ${RED}✗${NC} 测试失败"
        ERRORS+=("test_failed")
        TEST_OK=false
        ((FAIL++))
    fi
else
    echo -e "  ${YELLOW}⚠${NC} 未检测到测试框架"
    ((WARN++))
fi

# =============================================================================
banner "3. 静态分析"
# =============================================================================

ANALYSIS_OK=true

# clang-tidy
if command -v clang-tidy &>/dev/null && [[ -f "$PROJECT_DIR/compile_commands.json" ]]; then
    echo -e "  运行 clang-tidy (增量: 变更文件)..."

    # Get changed files (git diff or all .cpp/.h files)
    CHANGED_FILES=""
    if command -v git &>/dev/null && (cd "$PROJECT_DIR" && git rev-parse --git-dir &>/dev/null); then
        CHANGED_FILES=$(cd "$PROJECT_DIR" && git diff --name-only HEAD 2>/dev/null | grep -E '\.(cpp|cc|cxx|h|hpp)$' || true)
    fi

    if [[ -z "$CHANGED_FILES" ]]; then
        echo -e "  ${YELLOW}⚠${NC} 无变更文件或不在 git 仓库中，跳过 clang-tidy"
        ((WARN++))
    else
        TIDY_ERRORS=0
        for f in $CHANGED_FILES; do
            FULL_PATH="$PROJECT_DIR/$f"
            if [[ -f "$FULL_PATH" ]]; then
                if ! clang-tidy -p "$PROJECT_DIR" "$FULL_PATH" 2>&1 | grep -q "error:"; then
                    echo -e "  ${GREEN}✓${NC} $f"
                else
                    echo -e "  ${RED}✗${NC} $f (clang-tidy errors)"
                    ((TIDY_ERRORS++))
                fi
            fi
        done

        if [[ $TIDY_ERRORS -gt 0 ]]; then
            ERRORS+=("clang_tidy_errors:$TIDY_ERRORS")
            ANALYSIS_OK=false
            ((FAIL++))
        else
            ((PASS++))
        fi
    fi
else
    echo -e "  ${YELLOW}⚠${NC} clang-tidy 不可用或无 compile_commands.json"
    ((WARN++))
fi

# cppcheck
if command -v cppcheck &>/dev/null; then
    echo -e "  运行 cppcheck..."
    if cppcheck --quiet --error-exitcode=1 "$PROJECT_DIR" 2>&1 | tail -5; then
        echo -e "  ${GREEN}✓${NC} cppcheck 通过"
        ((PASS++))
    else
        echo -e "  ${RED}✗${NC} cppcheck 发现错误"
        ERRORS+=("cppcheck_errors")
        ANALYSIS_OK=false
        ((FAIL++))
    fi
else
    echo -e "  ${YELLOW}⚠${NC} cppcheck 未安装"
    ((WARN++))
fi

# =============================================================================
banner "验证总结"
# =============================================================================

TOTAL=$((PASS + FAIL + WARN))
echo -e "  ${GREEN}通过${NC}: ${PASS}  ${RED}失败${NC}: ${FAIL}  ${YELLOW}警告${NC}: ${WARN}  总计: ${TOTAL}"
echo ""

VERIFY_OK=true
if [[ $FAIL -gt 0 ]]; then
    echo -e "  ${RED}${BOLD}✗ 验证失败${NC}"
    VERIFY_OK=false
else
    echo -e "  ${GREEN}${BOLD}✓ 验证通过${NC}"
fi

echo ""
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════${NC}"

# =============================================================================
# JSON 报告输出 (供流水线状态机消费)
# =============================================================================
ERRORS_JSON=$(printf '"%s",' "${ERRORS[@]}" 2>/dev/null || echo "")
ERRORS_JSON="[${ERRORS_JSON%,}]"

cat >&2 <<EOF
{
  "stage": "$STAGE",
  "ok": $VERIFY_OK,
  "buildSystem": "$BUILD_SYSTEM",
  "summary": {
    "passed": $PASS,
    "failed": $FAIL,
    "warnings": $WARN
  },
  "errors": $ERRORS_JSON,
  "checks": {
    "compilation": $BUILD_OK,
    "tests": $TEST_OK,
    "staticAnalysis": $ANALYSIS_OK
  }
}
EOF

exit "$FAIL"
