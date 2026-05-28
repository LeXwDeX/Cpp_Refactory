#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# quality-gate.sh — 增量质量门禁
# 用法: bash quality-gate.sh <action> [<项目路径>]
#
# Actions:
#   baseline  — 记录当前质量 baseline
#   check     — 对比当前状态与 baseline，报告增量
#   status    — 显示当前 baseline 信息
#
# 输出: JSON 结构化结果 (stderr) + 人类可读摘要 (stdout)
# =============================================================================

ACTION="${1:-status}"
PROJECT_DIR="${2:-.}"
PROJECT_DIR="$(cd "$PROJECT_DIR" 2>/dev/null && pwd || echo "$PROJECT_DIR")"

STATE_DIR="$PROJECT_DIR/.cpp_refactory/state"
BASELINE_FILE="$STATE_DIR/QUALITY_BASELINE.json"

# ---------- 颜色 ----------
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

mkdir -p "$STATE_DIR"

# =============================================================================
# Helper: 收集当前质量指标
# =============================================================================
collect_metrics() {
    local clang_tidy_warnings=0
    local cppcheck_errors=0
    local compile_errors=0
    local compile_warnings=0
    local test_total=0
    local test_passed=0
    local test_failed=0

    # clang-tidy (if available and compile_commands.json exists)
    if command -v clang-tidy &>/dev/null && [[ -f "$PROJECT_DIR/compile_commands.json" ]]; then
        clang_tidy_warnings=$(find "$PROJECT_DIR" -name '*.cpp' -o -name '*.cc' -o -name '*.h' 2>/dev/null | head -20 | while read f; do
            clang-tidy -p "$PROJECT_DIR" "$f" 2>/dev/null | grep -c "warning:" || echo 0
        done | paste -sd+ | bc 2>/dev/null || echo 0)
    fi

    # cppcheck (if available)
    if command -v cppcheck &>/dev/null; then
        cppcheck_errors=$(cppcheck --quiet --error-exitcode=0 "$PROJECT_DIR" 2>&1 | grep -c "error:" || echo 0)
    fi

    # Tests (ctest if build dir exists)
    if [[ -d "$PROJECT_DIR/build" ]] && command -v ctest &>/dev/null; then
        local ctest_output
        ctest_output=$(cd "$PROJECT_DIR/build" && ctest --output-on-failure 2>&1 || true)
        test_total=$(echo "$ctest_output" | grep -E '[0-9]+ tests passed' | sed 's/[^0-9]//g' || echo 0)
        test_failed=$(echo "$ctest_output" | grep -E '[0-9]+ tests failed' | sed 's/[^0-9]//g' || echo 0)
        test_passed=$((test_total - test_failed))
    fi

    echo "{\"clangTidy\":${clang_tidy_warnings:-0},\"cppcheck\":${cppcheck_errors:-0},\"compileErrors\":${compile_errors:-0},\"compileWarnings\":${compile_warnings:-0},\"testTotal\":${test_total:-0},\"testPassed\":${test_passed:-0},\"testFailed\":${test_failed:-0}}"
}

# =============================================================================
case "$ACTION" in
    baseline)
        echo -e "${CYAN}${BOLD}记录质量 Baseline${NC}"
        echo -e "项目目录: ${BOLD}$PROJECT_DIR${NC}"
        echo ""

        METRICS=$(collect_metrics)

        BASELINE_FILE_PATH="$BASELINE_FILE" METRICS_JSON="$METRICS" PROJECT_DIR_ENV="$PROJECT_DIR" BASELINE_ID="$(date +%s)-$$" BASELINE_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)" python3 -c "
import json, os
config_path = os.environ['BASELINE_FILE_PATH']
m = json.loads(os.environ['METRICS_JSON'])
baseline = {
    'id': os.environ['BASELINE_ID'],
    'projectDir': os.environ['PROJECT_DIR_ENV'],
    'timestamp': os.environ['BASELINE_TS'],
    'metrics': {
        'warnings': {'clangTidy': m['clangTidy'], 'cppcheck': m['cppcheck']},
        'tests': {'total': m['testTotal'], 'passed': m['testPassed'], 'failed': m['testFailed']},
        'compilation': {'errors': m['compileErrors'], 'warnings': m['compileWarnings']}
    }
}
json.dump(baseline, open(config_path, 'w'), indent=2, ensure_ascii=False)
"

        echo -e "  ${GREEN}✓${NC} Baseline 已记录: $BASELINE_FILE"
        echo -e "  时间: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        cat "$BASELINE_FILE" >&2
        ;;

    check)
        echo -e "${CYAN}${BOLD}增量质量门禁检查${NC}"
        echo -e "项目目录: ${BOLD}$PROJECT_DIR${NC}"
        echo ""

        if [[ ! -f "$BASELINE_FILE" ]]; then
            echo -e "  ${YELLOW}⚠${NC} 无 baseline 记录，请先运行: cpp-quality-gate baseline"
            echo '{"hasBaseline":false,"passed":true}' >&2
            exit 0
        fi

        CURRENT=$(collect_metrics)
        BASELINE_TS=$(BASELINE_FILE_PATH="$BASELINE_FILE" python3 -c "import json, os; print(json.load(open(os.environ['BASELINE_FILE_PATH']))['timestamp'])" 2>/dev/null || echo "unknown")

        echo -e "  Baseline 时间: $BASELINE_TS"
        echo ""

        # Compare using Python (single execution: JSON to stderr, human-readable to stdout)
        BASELINE_FILE_PATH="$BASELINE_FILE" CURRENT_JSON="$CURRENT" python3 -c "
import json, sys, os

baseline = json.load(open(os.environ['BASELINE_FILE_PATH']))
current = json.loads(os.environ['CURRENT_JSON'])

bw = baseline['metrics']['warnings']
bt = baseline['metrics']['tests']

cw = {'clangTidy': current['clangTidy'], 'cppcheck': current['cppcheck']}
ct = {'total': current['testTotal'], 'passed': current['testPassed'], 'failed': current['testFailed']}

delta_w = {k: cw.get(k, 0) - bw.get(k, 0) for k in set(list(bw.keys()) + list(cw.keys()))}
new_errors = max(0, current['compileErrors'] - baseline['metrics']['compilation']['errors'])
test_reg = max(0, ct['failed'] - bt['failed'])

total_new_w = sum(max(0, v) for v in delta_w.values())
passed = total_new_w == 0 and new_errors == 0 and test_reg == 0

result = {
    'hasBaseline': True,
    'baselineTimestamp': baseline['timestamp'],
    'warningsDelta': delta_w,
    'newErrors': new_errors,
    'testRegressions': test_reg,
    'passed': passed
}

# Human-readable to stdout
for k, v in delta_w.items():
    icon = '✓' if v <= 0 else '✗'
    print(f'  {icon} {k}: {v:+d} (baseline: {bw.get(k, 0)} → current: {cw.get(k, 0)})')

if new_errors > 0:
    print(f'  ✗ 新增编译错误: +{new_errors}')
if test_reg > 0:
    print(f'  ✗ 测试回归: +{test_reg}')

print()
if passed:
    print('  ✓ 增量门禁通过')
else:
    print('  ✗ 增量门禁未通过')

# JSON to stderr
json.dump(result, sys.stderr)
"
        ;;

    status)
        echo -e "${CYAN}${BOLD}质量 Baseline 状态${NC}"
        echo -e "项目目录: ${BOLD}$PROJECT_DIR${NC}"
        echo ""

        if [[ -f "$BASELINE_FILE" ]]; then
            echo -e "  ${GREEN}✓${NC} Baseline 存在"
            BASELINE_FILE_PATH="$BASELINE_FILE" python3 -c "
import json, os
b = json.load(open(os.environ['BASELINE_FILE_PATH']))
print(f\"  时间: {b['timestamp']}\")
print(f\"  ID: {b['id']}\")
w = b['metrics']['warnings']
t = b['metrics']['tests']
print(f\"  警告: clang-tidy={w.get('clangTidy',0)}, cppcheck={w.get('cppcheck',0)}\")
print(f\"  测试: {t.get('passed',0)}/{t.get('total',0)} 通过\")
"
        else
            echo -e "  ${YELLOW}⚠${NC} 无 baseline 记录"
            echo -e "  运行 cpp-quality-gate baseline 创建"
        fi
        ;;

    *)
        echo "用法: $0 <baseline|check|status> [<项目路径>]"
        exit 1
        ;;
esac
