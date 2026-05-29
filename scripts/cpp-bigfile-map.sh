#!/usr/bin/env bash
# cpp-bigfile-map.sh — 大文件分块导航地图生成器（基于 Universal Ctags）
#
# 用途：给定一个 5万行级 C++ 文件，输出 markdown 地图，让 Agent 不用 Read 全文
# 就能理解结构。这是 Agent 在大文件上工作的必需品。
#
# 用法：
#   bash cpp-bigfile-map.sh <源文件> [--out <path>] [--section-lines N]
#
# 数据源：Universal Ctags（精度高、速度快、跨平台稳定）
# 可选增强：--ast 调用 clang_ast_list_functions 获取圈复杂度（需 MCP）
#
# 依赖：ctags (Universal Ctags 5.x+)、awk、wc、rg
#
# 输出：默认 .cpp_refactory/maps/<basename>.map.md

set -uo pipefail

# CRLF 自愈
if file "$0" 2>/dev/null | grep -q CRLF; then
    tr -d '\r' < "$0" > "$0.tmp" && mv "$0.tmp" "$0" && chmod +x "$0"
    exec bash "$0" "$@"
fi

# ── 参数解析 ──────────────────────────────────────────────
SOURCE=""
OUT=""
SECTION_LINES=500
USE_AST=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --ast) USE_AST=1; shift ;;
        --out) OUT="$2"; shift 2 ;;
        --section-lines) SECTION_LINES="$2"; shift 2 ;;
        -h|--help)
            sed -n '1,15p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            if [[ -z "$SOURCE" ]]; then
                SOURCE="$1"
            else
                echo "未知参数: $1" >&2; exit 1
            fi
            shift
            ;;
    esac
done

if [[ -z "$SOURCE" || ! -f "$SOURCE" ]]; then
    echo "用法：bash cpp-bigfile-map.sh <源文件> [--out <path>] [--section-lines N]" >&2
    exit 1
fi

# ── 依赖检查 ──────────────────────────────────────────────
if ! command -v ctags &>/dev/null; then
    echo "错误：需要 Universal Ctags。安装：apt install universal-ctags" >&2
    exit 1
fi

CTAGS_VERSION=$(ctags --version 2>&1 | head -1)
if ! echo "$CTAGS_VERSION" | grep -q "Universal Ctags"; then
    echo "警告：检测到的 ctags 不是 Universal Ctags，可能输出不兼容" >&2
    echo "  当前：$CTAGS_VERSION" >&2
fi

if ! command -v rg &>/dev/null; then
    echo "错误：需要 ripgrep (rg)" >&2
    exit 1
fi

SOURCE_ABS=$(readlink -f "$SOURCE")
BASENAME=$(basename "$SOURCE")
TOTAL_LINES=$(wc -l < "$SOURCE_ABS")

if [[ -z "$OUT" ]]; then
    OUT_DIR=".cpp_refactory/maps"
    mkdir -p "$OUT_DIR"
    OUT="$OUT_DIR/${BASENAME}.map.md"
fi

# ── 数据收集 ──────────────────────────────────────────────

# Ctags 输出格式（u-ctags / extended）：
#   <name>\t<file>\t<excmd>;"\t<kind>\tline:N\tlanguage:C++\t...\tend:M
#
# 只关心：
#   - kind = function 或 prototype（声明）
#   - kind = class / struct / union / namespace
#   - 字段 line:N、end:M、signature:(...)、class:Foo

run_ctags() {
    # --c++-kinds=+pl  : 包含 prototypes (p) 和 local (l) 用于完整识别
    # --fields=+nKsSlte: 输出 line/Kind/scope/signature/language/typeref/end
    # 不用 --extras=+q  : 否则会产出 qualified-name 重复条目
    ctags --c++-kinds=+pl \
          --fields=+nKsSlte \
          --output-format=u-ctags \
          -o - "$SOURCE_ABS" 2>/dev/null
}

# 提取函数（仅定义，不含 prototype）
# 从全局变量 CTAGS_RAW 读取，避免重复调用 ctags
collect_functions() {
    echo "$CTAGS_RAW" | awk -F'\t' '
    /\tfunction\t/ || /\tmethod\t/ {
        line = ""; endl = ""; sig = ""; class_name = ""; name = $1
        for (i = 4; i <= NF; i++) {
            if ($i ~ /^line:/)      { line = substr($i, 6) }
            else if ($i ~ /^end:/)  { endl = substr($i, 5) }
            else if ($i ~ /^signature:/) { sig = substr($i, 11) }
            else if ($i ~ /^class:/)     { class_name = substr($i, 7) }
            else if ($i ~ /^scope:/)     { class_name = substr($i, 7) }
        }
        if (line == "") next
        if (endl == "") endl = line   # 单行函数兜底
        len = endl - line + 1
        # 完整函数显示：[Class::]name(sig)
        full = name
        if (class_name != "") full = class_name "::" name
        if (sig != "") full = full sig
        if (length(full) > 110) full = substr(full, 1, 107) "..."
        printf "%d\t%d\t%s\n", line, len, full
    }
    ' | sort -n -t$'\t' -k1,1
}

# 提取类型定义
# 从全局变量 CTAGS_RAW 读取，避免重复调用 ctags
collect_types() {
    echo "$CTAGS_RAW" | awk -F'\t' '
    /\t(class|struct|union|namespace|enum)\t/ {
        line = ""; kind = ""
        for (i = 4; i <= NF; i++) {
            if ($i ~ /^line:/) line = substr($i, 6)
        }
        # kind 在第 4 列（u-ctags 格式）
        kind = $4
        if (line == "") next
        printf "%d\t%s\t%s\n", line, kind, $1
    }
    ' | sort -n -t$'\t' -k1,1
}

# 宏 / 条件编译
collect_macros() {
    rg -n '^\s*#\s*(ifdef|ifndef|if\s|elif|else|endif|define|undef)' "$SOURCE_ABS" 2>/dev/null \
        | awk -F: '{ line = $1; $1=""; sub(/^ /, ""); printf "%s\t%s\n", line, $0 }' \
        || true
}

# Includes
collect_includes() {
    rg -n '^\s*#\s*include' "$SOURCE_ABS" 2>/dev/null \
        | head -50 \
        | awk -F: '{ line = $1; $1=""; sub(/^ /, ""); printf "%s\t%s\n", line, $0 }' \
        || true
}

# ── 输出 markdown ─────────────────────────────────────────
generate_report() {
    # 缓存 ctags 输出，避免 collect_functions/collect_types 各自调用一次
    CTAGS_RAW=$(run_ctags)

    local fns_data types_data macros_data includes_data
    fns_data=$(collect_functions)
    types_data=$(collect_types)
    macros_data=$(collect_macros)
    includes_data=$(collect_includes)

    local fn_count type_count ifdef_count
    fn_count=$(printf '%s\n' "$fns_data" | grep -c '^[0-9]' 2>/dev/null) || fn_count=0
    type_count=$(printf '%s\n' "$types_data" | grep -c '^[0-9]' 2>/dev/null) || type_count=0
    ifdef_count=$(printf '%s\n' "$macros_data" | grep -cE '#\s*(ifdef|ifndef|if[[:space:]])' 2>/dev/null) || ifdef_count=0

    {
        echo "# Bigfile Map: \`$BASENAME\` ($TOTAL_LINES lines)"
        echo ""
        echo "> 自动生成于 $(date '+%Y-%m-%d %H:%M:%S')"
        echo "> 源文件: \`$SOURCE_ABS\`"
        echo "> 数据源: Universal Ctags (精确边界)$([ "$USE_AST" -eq 1 ] && echo ' + clang-ast (圈复杂度)')"
        echo ""
        echo "## 1. Quick Stats"
        echo ""
        echo "| 指标 | 数值 |"
        echo "|------|------|"
        echo "| 总行数 | $TOTAL_LINES |"
        echo "| 函数定义数 | $fn_count |"
        echo "| 类/结构/命名空间/枚举 | $type_count |"
        echo "| #ifdef/#if 区域 | $ifdef_count |"
        echo "| 估算 Read tokens | ~$((TOTAL_LINES * 40 / 1000))K |"
        echo ""

        # ── 2. Section Map ────────────────────────────
        echo "## 2. Section Map (每 ~$SECTION_LINES 行一段)"
        echo ""
        echo "> Agent 提示：用 \`Read offset=<start> limit=<size>\` 精准读取目标段，避免全文加载。"
        echo ""
        echo "| 段号 | 行范围 | 该段函数 (起始行@长度) | 该段类型 |"
        echo "|------|--------|------------------------|----------|"

        local section_idx=1
        local section_start=1
        while [[ $section_start -le $TOTAL_LINES ]]; do
            local section_end=$((section_start + SECTION_LINES - 1))
            [[ $section_end -gt $TOTAL_LINES ]] && section_end=$TOTAL_LINES

            local fns_in_section
            fns_in_section=$(printf '%s\n' "$fns_data" | awk -F'\t' -v s="$section_start" -v e="$section_end" '
                $1 >= s && $1 <= e {
                    name = $3
                    sub(/\(.*$/, "", name)
                    sub(/.*::/, "", name)
                    printf "%s@L%d(%dL), ", name, $1, $2
                }
            ' | sed 's/, $//')

            local types_in_section
            types_in_section=$(printf '%s\n' "$types_data" | awk -F'\t' -v s="$section_start" -v e="$section_end" '
                $1 >= s && $1 <= e {
                    printf "%s %s, ", $2, $3
                }
            ' | sed 's/, $//')

            [[ -z "$fns_in_section" ]] && fns_in_section="-"
            [[ -z "$types_in_section" ]] && types_in_section="-"

            printf "| §%d | L%d-%d | %s | %s |\n" \
                "$section_idx" "$section_start" "$section_end" "$fns_in_section" "$types_in_section"

            section_idx=$((section_idx + 1))
            section_start=$((section_end + 1))
        done
        echo ""

        # ── 3. 函数索引（按行排序） ──────────────────
        echo "## 3. Function Index (按行号)"
        echo ""
        echo "| Line | End | Length | Function |"
        echo "|------|-----|--------|----------|"
        printf '%s\n' "$fns_data" | awk -F'\t' '
            NF >= 3 { printf "| %d | %d | %d | `%s` |\n", $1, $1+$2-1, $2, $3 }
        '
        echo ""

        # ── 4. God Functions（按长度排序 TOP 20） ────
        echo "## 4. God Functions (按长度降序 TOP 20)"
        echo ""
        echo "> 长度 >50 应评估拆分；>100 几乎肯定需要切分；>300 是头号优先级。"
        echo ""
        echo "| Length | Line-End | Function |"
        echo "|--------|----------|----------|"
        printf '%s\n' "$fns_data" | awk -F'\t' 'NF >= 3 && $2 > 30' \
            | sort -k2,2 -rn -t$'\t' \
            | head -20 \
            | awk -F'\t' '{ printf "| %d | L%d-%d | `%s` |\n", $2, $1, $1+$2-1, $3 }'
        echo ""

        # ── 5. 类型索引 ─────────────────────────────
        echo "## 5. Type Definitions"
        echo ""
        if [[ "$type_count" -gt 0 ]]; then
            echo "| Line | Kind | Name |"
            echo "|------|------|------|"
            printf '%s\n' "$types_data" | awk -F'\t' '
                NF >= 3 { printf "| %d | %s | `%s` |\n", $1, $2, $3 }
            '
        else
            echo "（无类/命名空间/枚举定义；可能全部在头文件中）"
        fi
        echo ""

        # ── 6. 宏区域 ───────────────────────────────
        echo "## 6. Preprocessor Regions"
        echo ""
        if [[ "$ifdef_count" -gt 0 ]]; then
            echo "<details>"
            echo "<summary>条件编译指令清单（$ifdef_count 处 #ifdef/#if）</summary>"
            echo ""
            echo '```'
            printf '%s\n' "$macros_data" | head -100
            echo '```'
            echo "</details>"
        else
            echo "（无条件编译）"
        fi
        echo ""

        # ── 7. Includes ─────────────────────────────
        echo "## 7. Includes"
        echo ""
        echo '```cpp'
        printf '%s\n' "$includes_data" | awk -F'\t' 'NF >= 2 { printf "L%-4d  %s\n", $1, $2 }' | head -40
        echo '```'
        echo ""

        # ── 8. Suggested Cut Points ──────────────────
        echo "## 8. Suggested Cut Points (启发式建议)"
        echo ""
        echo "> 基于段落边界 + 函数边界。**最终决策**应结合 \`codegraph_codegraph_context\` 的依赖分析。"
        echo ""

        local cut_target=$((SECTION_LINES * 2))
        local next_cut=$cut_target
        local cuts=""
        while [[ $next_cut -lt $TOTAL_LINES ]]; do
            local nearest
            nearest=$(printf '%s\n' "$fns_data" | awk -F'\t' -v t="$next_cut" '
                BEGIN { best = 0; diff = 99999 }
                NF >= 3 {
                    d = $1 - t
                    if (d < 0) d = -d
                    if (d < diff) { diff = d; best = $1 }
                }
                END { print best }
            ')
            if [[ -n "$nearest" && "$nearest" -gt 0 ]]; then
                cuts="$cuts $nearest"
            fi
            next_cut=$((next_cut + cut_target))
        done

        if [[ -n "$cuts" ]]; then
            local i=1
            for c in $cuts; do
                local fn_at
                fn_at=$(printf '%s\n' "$fns_data" | awk -F'\t' -v l="$c" '$1 == l { print $3; exit }')
                echo "${i}. **L$c** — 在 \`${fn_at:-?}\` 之前切分（每段约 $cut_target 行）"
                i=$((i + 1))
            done
        else
            echo "（文件较小，无需切分）"
        fi
        echo ""

        # ── 9. CodeGraph 调用关系分析 ────────────────
        echo "## 9. CodeGraph 调用关系分析"
        echo ""

        if command -v codegraph &>/dev/null; then
            # 查找 .codegraph 索引
            local cg_found=0
            local search_dir
            search_dir=$(dirname "$SOURCE_ABS")
            while [[ "$search_dir" != "/" ]]; do
                if [[ -d "$search_dir/.codegraph" ]]; then
                    cg_found=1
                    break
                fi
                search_dir=$(dirname "$search_dir")
            done

            if [[ $cg_found -eq 1 ]]; then
                # 提取 Top 3 上帝函数进行调用关系分析
                local top_gods
                top_gods=$(printf '%s\n' "$fns_data" | awk -F'\t' 'NF >= 3 { print $3 }' | head -3)

                if [[ -n "$top_gods" ]]; then
                    echo "### Top 上帝函数调用关系"
                    echo ""

                    while IFS= read -r god_fn; do
                        [[ -z "$god_fn" ]] && continue
                        echo "#### \`$god_fn\`"
                        echo ""

                        # callers
                        echo "**调用者 (callers):**"
                        echo '```'
                        codegraph callers "$god_fn" "$search_dir" 2>/dev/null | head -10 || echo "  (无数据)"
                        echo '```'
                        echo ""

                        # callees
                        echo "**被调用者 (callees):**"
                        echo '```'
                        codegraph callees "$god_fn" "$search_dir" 2>/dev/null | head -10 || echo "  (无数据)"
                        echo '```'
                        echo ""
                    done <<< "$top_gods"
                else
                    echo "（未提取到可分析的函数）"
                fi
            else
                echo "⚠ 未找到 .codegraph 索引。运行 \`codegraph init\` 初始化。"
            fi
        else
            echo "⚠ codegraph 未安装。安装: \`npm install -g @anthropic/codegraph\`"
        fi
        echo ""

        # ── 10. Agent 操作指南 ──────────────────────
        echo "## 10. Agent 操作指南"
        echo ""
        echo "**禁止**：\`Read $SOURCE_ABS\`（消耗 ~$((TOTAL_LINES * 40 / 1000))K tokens，会爆上下文）"
        echo ""
        echo "**推荐工作流**："
        echo "1. **浏览结构**：直接看本 map（§2 段落表 + §4 上帝函数）"
        echo "2. **精读片段**：\`Read offset=<start> limit=<N>\`，从 §段号 取行号"
        echo "3. **精确边界 + 圈复杂度**：\`clang_ast_list_functions(file=\"$SOURCE_ABS\", min_lines=N)\`"
        echo "4. **依赖与影响**：\`codegraph_codegraph_context(task=\"<函数>\")\` + \`codegraph_codegraph_impact(symbol=\"<函数>\")\`"
        echo "5. **重构计划**：从 §8 切分点生成 \`PARTITION_LEDGER.md\` 的批次"
        echo ""

        echo "---"
        echo "_由 cpp-bigfile-map.sh (Universal Ctags) 生成。重新运行：\`bash $0 $SOURCE\`_"
    } > "$OUT"

    echo "✓ Map written: $OUT" >&2
    echo "  $TOTAL_LINES lines → $fn_count functions, $type_count types, $ifdef_count #ifdef regions" >&2
}

generate_report
