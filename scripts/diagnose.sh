#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# diagnose.sh — 一键诊断 cpp_refactory 环境
# 用法: bash diagnose.sh [<目标项目路径>]
#
# 检测项:
#   1. 必需工具链 (clang-tidy, cppcheck, bear, rg)
#   2. 可选工具链 (clang-format, cmake, ccache, clangd)
#   3. compile_commands.json 存在性 + 路径有效性
#   4. Docker 可用性 (可选)
#   5. MCP server 可用性 (可选)
#
# 输出: 结构化 JSON 报告 + 人类可读摘要
# =============================================================================

PROJECT_DIR="${1:-.}"
PROJECT_DIR="$(cd "$PROJECT_DIR" 2>/dev/null && pwd || echo "$PROJECT_DIR")"

# ---------- 颜色 ----------
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0; FAIL=0; WARN=0
RESULTS=()

banner() { echo -e "\n${CYAN}${BOLD}── $1 ──${NC}"; }

check_tool() {
    local name="$1"
    local required="${2:-false}"
    if command -v "$name" &>/dev/null 2>&1; then
        local ver
        ver=$("$name" --version 2>/dev/null | head -1 || echo "unknown")
        echo -e "  ${GREEN}✓${NC}  $name  ($ver)"
        RESULTS+=("{\"name\":\"$name\",\"available\":true,\"version\":\"$ver\"}")
        ((PASS++))
    elif [[ "$required" == "true" ]]; then
        echo -e "  ${RED}✗${NC}  $name  [必需] 未安装"
        RESULTS+=("{\"name\":\"$name\",\"available\":false}")
        ((FAIL++))
    else
        echo -e "  ${YELLOW}⚠${NC}  $name  [可选] 未安装"
        RESULTS+=("{\"name\":\"$name\",\"available\":false}")
        ((WARN++))
    fi
}

# =============================================================================
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════${NC}"
echo -e "${CYAN}${BOLD}  cpp_refactory 环境诊断报告${NC}"
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════${NC}"
echo ""
echo -e "项目目录: ${BOLD}$PROJECT_DIR${NC}"
echo -e "检测时间: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# =============================================================================
banner "L1 必需工具链"
# =============================================================================
check_tool "clang-tidy" true
check_tool "cppcheck" true
check_tool "bear" true
check_tool "rg" true

# =============================================================================
banner "L2 可选工具链"
# =============================================================================
check_tool "clang-format" false
check_tool "clangd" false
check_tool "cmake" false
check_tool "ccache" false
check_tool "ninja" false

# =============================================================================
banner "L3 compile_commands.json"
# =============================================================================
CC_FILE="$PROJECT_DIR/compile_commands.json"
CC_STATUS="not_found"
CC_ENTRIES=0
CC_VALID=0
CC_MISMATCH=0

if [[ -f "$CC_FILE" ]]; then
    # Check JSON validity
    if python3 -c "import json; json.load(open('$CC_FILE'))" 2>/dev/null; then
        CC_ENTRIES=$(python3 -c "import json; print(len(json.load(open('$CC_FILE'))))" 2>/dev/null || echo 0)

        if [[ "$CC_ENTRIES" -eq 0 ]]; then
            CC_STATUS="empty"
            echo -e "  ${YELLOW}⚠${NC}  compile_commands.json 存在但为空"
            ((WARN++))
        else
            # Validate paths
            PATH_CHECK=$(python3 -c "
import json, os
entries = json.load(open('$CC_FILE'))
valid = 0
invalid = 0
for e in entries:
    d = e.get('directory', '')
    f = e.get('file', '')
    full = os.path.join(d, f) if not os.path.isabs(f) else f
    if os.path.exists(full):
        valid += 1
    else:
        invalid += 1
print(f'{valid}:{invalid}')
" 2>/dev/null || echo "0:0")

            CC_VALID="${PATH_CHECK%%:*}"
            CC_MISMATCH="${PATH_CHECK##*:}"

            if [[ "$CC_MISMATCH" -eq 0 ]]; then
                CC_STATUS="valid"
                echo -e "  ${GREEN}✓${NC}  compile_commands.json 有效 ($CC_ENTRIES 条目, $CC_VALID 路径可用)"
                ((PASS++))
            elif [[ "$CC_VALID" -eq 0 ]]; then
                CC_STATUS="path_mismatch"
                echo -e "  ${RED}✗${NC}  compile_commands.json 所有路径无效 ($CC_ENTRIES 条目, $CC_MISMATCH 路径失效)"
                echo -e "      建议: 在当前环境重新生成 bear -- make"
                ((FAIL++))
            else
                CC_STATUS="path_mismatch"
                echo -e "  ${YELLOW}⚠${NC}  compile_commands.json 部分路径无效 ($CC_VALID 有效, $CC_MISMATCH 失效)"
                echo -e "      建议: 重新生成以获得完整路径覆盖"
                ((WARN++))
            fi
        fi
    else
        CC_STATUS="invalid_json"
        echo -e "  ${RED}✗${NC}  compile_commands.json 格式无效（非合法 JSON）"
        echo -e "      建议: 重新生成 bear -- make"
        ((FAIL++))
    fi
else
    echo -e "  ${YELLOW}⚠${NC}  compile_commands.json 不存在"
    echo -e "      建议生成方式:"
    echo -e "        bear -- make"
    echo -e "        bear -- cmake --build build/"
    ((WARN++))
fi

# =============================================================================
banner "L4 Docker (可选)"
# =============================================================================
if command -v docker &>/dev/null 2>&1; then
    if docker info &>/dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC}  Docker 可用"
        ((PASS++))
    else
        echo -e "  ${YELLOW}⚠${NC}  Docker 已安装但 daemon 未运行"
        ((WARN++))
    fi
else
    echo -e "  ${YELLOW}⚠${NC}  Docker 未安装 (可选)"
    ((WARN++))
fi

# =============================================================================
banner "L5 MCP Server (可选)"
# =============================================================================
if command -v clang-ast-mcp &>/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC}  clang-ast-mcp 已安装"
    ((PASS++))
elif python3 -c "import clang_ast_mcp" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC}  clang-ast-mcp Python 模块可用"
    ((PASS++))
else
    echo -e "  ${YELLOW}⚠${NC}  clang-ast-mcp 未安装 (可选, AST 分析将降级为正则)"
    ((WARN++))
fi

# =============================================================================
banner "总结"
# =============================================================================
TOTAL=$((PASS + FAIL + WARN))
echo -e "  ${GREEN}通过${NC}: ${PASS}  ${RED}失败${NC}: ${FAIL}  ${YELLOW}警告${NC}: ${WARN}  总计: ${TOTAL}"
echo ""

if [[ "$FAIL" -eq 0 ]]; then
    echo -e "  ${GREEN}${BOLD}✓ 环境就绪${NC}"
    OK="true"
else
    echo -e "  ${RED}${BOLD}✗ 需要修复 ${FAIL} 项问题${NC}"
    OK="false"
fi

echo ""
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════${NC}"

# =============================================================================
# JSON 报告输出 (供程序消费)
# =============================================================================
# 构建 JSON tools 数组
TOOLS_JSON=$(printf '%s,' "${RESULTS[@]}")
TOOLS_JSON="[${TOOLS_JSON%,}]"

# 输出 JSON 到 stderr (供程序解析，不影响终端显示)
cat >&2 <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "projectDir": "$PROJECT_DIR",
  "ok": $OK,
  "summary": {
    "totalChecks": $TOTAL,
    "passed": $PASS,
    "failed": $FAIL,
    "warnings": $WARN
  },
  "tools": $TOOLS_JSON,
  "compileCommands": {
    "status": "$CC_STATUS",
    "filePath": "$CC_FILE",
    "entryCount": $CC_ENTRIES,
    "validPaths": $CC_VALID,
    "mismatchedPaths": $CC_MISMATCH
  }
}
EOF

exit "$FAIL"
