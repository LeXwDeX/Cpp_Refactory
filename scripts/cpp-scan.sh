#!/usr/bin/env bash
# cpp-scan.sh — C++ 项目预扫描脚本
# 用途：检测 C++ 标准版本、统计文件行数热点、分析 include 依赖、定位上帝函数
# 依赖：rg (ripgrep)、awk、sort — 不依赖 clang 或其他重量级工具
#
# 用法：bash cpp-scan.sh <目标目录> [--json]
# 输出：结构化文本报告（默认）或 JSON（--json）

set -euo pipefail

# CRLF 自愈
if file "$0" | grep -q CRLF; then
    tr -d '\r' < "$0" > "$0.tmp" && mv "$0.tmp" "$0" && chmod +x "$0"
    exec bash "$0" "$@"
fi

# ── 参数解析 ──────────────────────────────────────────────
TARGET="${1:-.}"
OUTPUT_FORMAT="text"
[[ "${2:-}" == "--json" ]] && OUTPUT_FORMAT="json"

if [[ ! -d "$TARGET" ]]; then
    echo "错误：目标目录 '$TARGET' 不存在" >&2
    exit 1
fi

# 确认 rg 可用
if ! command -v rg &>/dev/null; then
    echo "错误：需要 ripgrep (rg)，请先安装" >&2
    exit 1
fi

# ── 工具函数 ──────────────────────────────────────────────
separator() {
    echo ""
    echo "════════════════════════════════════════════════════════════"
    echo "  $1"
    echo "════════════════════════════════════════════════════════════"
}

# ── 1. C++ 标准版本检测 ──────────────────────────────────
detect_cpp_standard() {
    separator "1. C++ 标准版本检测"

    local detected=""
    local source=""

    # 方法 A：从 CMakeLists.txt 检测
    local cmake_files
    cmake_files=$(find "$TARGET" -name "CMakeLists.txt" -not -path "*/build/*" -not -path "*/.git/*" 2>/dev/null || true)

    if [[ -n "$cmake_files" ]]; then
        # 检测 CMAKE_CXX_STANDARD
        local std_val
        std_val=$(rg -oIN 'CMAKE_CXX_STANDARD\s+(\d+)' --replace '$1' $cmake_files 2>/dev/null | head -1 || true)
        if [[ -n "$std_val" ]]; then
            detected="C++${std_val}"
            source="CMakeLists.txt (CMAKE_CXX_STANDARD)"
        fi

        # 检测 set(CMAKE_CXX_STANDARD ...)
        if [[ -z "$detected" ]]; then
            std_val=$(rg -oIN 'set\s*\(\s*CMAKE_CXX_STANDARD\s+(\d+)' --replace '$1' $cmake_files 2>/dev/null | head -1 || true)
            if [[ -n "$std_val" ]]; then
                detected="C++${std_val}"
                source="CMakeLists.txt (set CMAKE_CXX_STANDARD)"
            fi
        fi

        # 检测 CXX_STANDARD 属性
        if [[ -z "$detected" ]]; then
            std_val=$(rg -oIN 'CXX_STANDARD\s+(\d+)' --replace '$1' $cmake_files 2>/dev/null | head -1 || true)
            if [[ -n "$std_val" ]]; then
                detected="C++${std_val}"
                source="CMakeLists.txt (CXX_STANDARD property)"
            fi
        fi

        # 检测 -std=c++XX 编译选项
        if [[ -z "$detected" ]]; then
            std_val=$(rg -oIN '\-std=c\+\+(\d+)' --replace '$1' $cmake_files 2>/dev/null | head -1 || true)
            if [[ -n "$std_val" ]]; then
                detected="C++${std_val}"
                source="CMakeLists.txt (-std=c++ flag)"
            fi
        fi
    fi

    # 方法 B：从 Makefile 检测
    if [[ -z "$detected" ]]; then
        local makefiles
        makefiles=$(find "$TARGET" -maxdepth 3 \( -name "Makefile" -o -name "*.mk" -o -name "GNUmakefile" \) -not -path "*/build/*" -not -path "*/.git/*" 2>/dev/null || true)
        if [[ -n "$makefiles" ]]; then
            local std_val
            std_val=$(rg -oIN '\-std=c\+\+(\d+)' --replace '$1' $makefiles 2>/dev/null | head -1 || true)
            if [[ -n "$std_val" ]]; then
                detected="C++${std_val}"
                source="Makefile (-std=c++ flag)"
            fi
        fi
    fi

    # 方法 C：从 .pro (Qt) 检测
    if [[ -z "$detected" ]]; then
        local pro_files
        pro_files=$(find "$TARGET" -maxdepth 3 -name "*.pro" -not -path "*/.git/*" 2>/dev/null || true)
        if [[ -n "$pro_files" ]]; then
            local std_val
            std_val=$(rg -oIN 'CONFIG\s*\+=.*c\+\+(\d+)' --replace '$1' $pro_files 2>/dev/null | head -1 || true)
            if [[ -n "$std_val" ]]; then
                detected="C++${std_val}"
                source=".pro (Qt CONFIG)"
            fi
        fi
    fi

    # 方法 D：从 compile_commands.json 检测
    if [[ -z "$detected" ]]; then
        local cc_json
        cc_json=$(find "$TARGET" -maxdepth 3 -name "compile_commands.json" -not -path "*/.git/*" 2>/dev/null | head -1 || true)
        if [[ -n "$cc_json" ]]; then
            local std_val
            std_val=$(rg -oIN '\-std=c\+\+(\d+)' --replace '$1' "$cc_json" 2>/dev/null | head -1 || true)
            if [[ -n "$std_val" ]]; then
                detected="C++${std_val}"
                source="compile_commands.json"
            fi
        fi
    fi

    # 方法 E：从代码特征推断
    if [[ -z "$detected" ]]; then
        local cpp_files_sample
        cpp_files_sample=$(find "$TARGET" \( -name "*.cpp" -o -name "*.cxx" -o -name "*.cc" -o -name "*.h" -o -name "*.hpp" \) -not -path "*/build/*" -not -path "*/.git/*" -not -path "*/third_party/*" -not -path "*/vendor/*" 2>/dev/null | head -50 || true)

        if [[ -n "$cpp_files_sample" ]]; then
            # 检测 C++20 特征
            if echo "$cpp_files_sample" | xargs rg -l 'concept\s+\w+|requires\s*\(|co_await|co_yield|std::span|std::format' 2>/dev/null | head -1 | grep -q .; then
                detected="C++20（推断）"
                source="代码特征推断（concepts/coroutines/span）"
            # 检测 C++17 特征
            elif echo "$cpp_files_sample" | xargs rg -l 'std::optional|std::variant|std::any|std::string_view|if\s+constexpr|auto\s*\[' 2>/dev/null | head -1 | grep -q .; then
                detected="C++17（推断）"
                source="代码特征推断（optional/variant/string_view）"
            # 检测 C++14 特征
            elif echo "$cpp_files_sample" | xargs rg -l 'std::make_unique|decltype\(auto\)|0b[01]+' 2>/dev/null | head -1 | grep -q .; then
                detected="C++14（推断）"
                source="代码特征推断（make_unique/decltype(auto)）"
            # 检测 C++11 特征
            elif echo "$cpp_files_sample" | xargs rg -l 'nullptr|std::unique_ptr|std::shared_ptr|std::move|auto\s+\w+\s*=|\[\s*\]|enum\s+class|static_assert' 2>/dev/null | head -1 | grep -q .; then
                detected="C++11（推断）"
                source="代码特征推断（nullptr/unique_ptr/lambda/enum class）"
            else
                detected="C++03 或更早（推断）"
                source="代码特征推断（无现代 C++ 特征）"
            fi
        fi
    fi

    if [[ -z "$detected" ]]; then
        detected="未能检测"
        source="无构建系统文件且无代码特征"
    fi

    echo "  检测结果：$detected"
    echo "  检测来源：$source"
    echo ""
    echo "  CPP_STANDARD=$detected"

    # 导出供其他脚本使用
    export CPP_STANDARD="$detected"
    export CPP_STANDARD_SOURCE="$source"
}

# ── 2. 文件行数统计 ──────────────────────────────────────
file_line_stats() {
    separator "2. 文件行数排行（TOP 20 巨型文件）"

    find "$TARGET" \( -name "*.cpp" -o -name "*.cxx" -o -name "*.cc" -o -name "*.h" -o -name "*.hpp" -o -name "*.hxx" \) \
        -not -path "*/build/*" -not -path "*/.git/*" -not -path "*/third_party/*" -not -path "*/vendor/*" -not -path "*/node_modules/*" \
        2>/dev/null | while read -r f; do
        wc -l "$f"
    done | sort -rn | head -20 || true

    echo ""

    # 总计
    local total_files total_lines
    total_files=$(find "$TARGET" \( -name "*.cpp" -o -name "*.cxx" -o -name "*.cc" -o -name "*.h" -o -name "*.hpp" -o -name "*.hxx" \) \
        -not -path "*/build/*" -not -path "*/.git/*" -not -path "*/third_party/*" -not -path "*/vendor/*" 2>/dev/null | wc -l)
    total_lines=$(find "$TARGET" \( -name "*.cpp" -o -name "*.cxx" -o -name "*.cc" -o -name "*.h" -o -name "*.hpp" -o -name "*.hxx" \) \
        -not -path "*/build/*" -not -path "*/.git/*" -not -path "*/third_party/*" -not -path "*/vendor/*" 2>/dev/null -exec cat {} + 2>/dev/null | wc -l)

    echo "  总计：$total_files 个 C++ 文件，$total_lines 行代码"
}

# ── 3. 函数长度排行 ──────────────────────────────────────
function_length_stats() {
    separator "3. 上帝函数排行（超过 100 行的函数）"

    # 使用 rg 查找函数定义的起始行（启发式：返回类型 + 函数名 + 参数列表 + {）
    # 这是一个近似方法，不依赖 AST 解析
    find "$TARGET" \( -name "*.cpp" -o -name "*.cxx" -o -name "*.cc" \) \
        -not -path "*/build/*" -not -path "*/.git/*" -not -path "*/third_party/*" -not -path "*/vendor/*" \
        2>/dev/null | while read -r f; do
        awk '
        # 跟踪大括号深度来估算函数长度
        /^[[:alpha:]_].*\(.*\)\s*\{?\s*$/ || /^[[:alpha:]_].*\(.*\)$/ {
            if (func_name != "" && func_length > 100) {
                printf "%6d  %s:%d  %s\n", func_length, FILENAME, func_start, func_name
            }
            func_name = $0
            gsub(/\s*\{.*/, "", func_name)
            # 截断过长的签名
            if (length(func_name) > 80) func_name = substr(func_name, 1, 77) "..."
            func_start = NR
            func_length = 0
            brace_depth = 0
            in_func = 0
        }
        /\{/ {
            n = gsub(/\{/, "{")
            brace_depth += n
            if (brace_depth > 0) in_func = 1
        }
        /\}/ {
            n = gsub(/\}/, "}")
            brace_depth -= n
            if (brace_depth <= 0 && in_func) {
                func_length = NR - func_start + 1
                if (func_length > 100) {
                    printf "%6d  %s:%d  %s\n", func_length, FILENAME, func_start, func_name
                }
                func_name = ""
                func_length = 0
                in_func = 0
            }
        }
        { if (in_func) func_length++ }
        ' "$f" 2>/dev/null
    done | sort -rn | head -20 || true

    echo ""
    echo "  （仅显示超过 100 行的函数，按长度降序排列）"
}

# ── 4. include 依赖热度 ──────────────────────────────────
include_dependency_stats() {
    separator "4. include 依赖热度（被引用最多的头文件 TOP 20）"

    rg -oIN '#include\s*[<"]([^>"]+)[>"]' --replace '$1' \
        --glob '*.cpp' --glob '*.cxx' --glob '*.cc' --glob '*.h' --glob '*.hpp' --glob '*.hxx' \
        "$TARGET" 2>/dev/null | sort | uniq -c | sort -rn | head -20 || true

    echo ""
    echo "  （数字为被 #include 的次数）"
}

# ── 5. 条件编译密度 ──────────────────────────────────────
conditional_compilation_stats() {
    separator "5. 条件编译密度（#ifdef 丛林指数）"

    local total_ifdef=0
    local total_lines=0
    local file_count=0

    echo "  每文件 #ifdef/#ifndef/#if defined 密度 TOP 15："
    echo ""

    find "$TARGET" \( -name "*.cpp" -o -name "*.cxx" -o -name "*.cc" -o -name "*.h" -o -name "*.hpp" -o -name "*.hxx" \) \
        -not -path "*/build/*" -not -path "*/.git/*" -not -path "*/third_party/*" -not -path "*/vendor/*" \
        2>/dev/null | while read -r f; do
        local ifdefs lines
        ifdefs=$(rg -c '#\s*(ifdef|ifndef|if\s+defined|if\s+!)' "$f" 2>/dev/null || echo "0")
        lines=$(wc -l < "$f" | tr -d ' ')
        if [[ "$ifdefs" -gt 0 && "$lines" -gt 0 ]]; then
            local density
            density=$(awk "BEGIN { printf \"%.1f\", ($ifdefs / $lines) * 100 }")
            echo "$ifdefs $density% $lines $f"
        fi
    done | sort -rn | head -15 | awk '{ printf "  %4d 条件编译指令  密度 %s  (%s 行)  %s\n", $1, $2, $3, $4 }' || true

    echo ""

    # 总计
    local total
    total=$(rg -c '#\s*(ifdef|ifndef|if\s+defined|if\s+!)' \
        --glob '*.cpp' --glob '*.cxx' --glob '*.cc' --glob '*.h' --glob '*.hpp' --glob '*.hxx' \
        "$TARGET" 2>/dev/null | awk -F: '{sum+=$2} END {print sum+0}')
    echo "  全项目条件编译指令总数：$total"
}

# ── 6. 快速异味指标 ─────────────────────────────────────
smell_indicators() {
    separator "6. 代码异味快速指标"

    echo "  全局变量（非 const 命名空间级）："
    local globals
    globals=$( { rg -P -c '^\s*(static\s+)?(?!const\b)(?!constexpr\b)\w[\w:<>*&\s]+\s+\w+\s*[=;]' \
        --glob '*.cpp' --glob '*.cxx' --glob '*.cc' \
        "$TARGET" 2>/dev/null || true; } | awk -F: '{sum+=$2} END {print sum+0}' )
    echo "    约 $globals 处（启发式估算，可能包含误报）"

    echo ""
    echo "  裸 new/delete："
    local raw_new raw_delete
    raw_new=$( { rg -c '\bnew\s+\w' --glob '*.cpp' --glob '*.cxx' --glob '*.cc' "$TARGET" 2>/dev/null || true; } | awk -F: '{sum+=$2} END {print sum+0}' )
    raw_delete=$( { rg -c '\bdelete\s' --glob '*.cpp' --glob '*.cxx' --glob '*.cc' "$TARGET" 2>/dev/null || true; } | awk -F: '{sum+=$2} END {print sum+0}' )
    echo "    new: $raw_new 处，delete: $raw_delete 处"

    echo ""
    echo "  goto 语句："
    local gotos
    gotos=$( { rg -c '\bgoto\s+\w' --glob '*.cpp' --glob '*.cxx' --glob '*.cc' "$TARGET" 2>/dev/null || true; } | awk -F: '{sum+=$2} END {print sum+0}' )
    echo "    $gotos 处"

    echo ""
    echo "  friend 声明："
    local friends
    friends=$( { rg -c '\bfriend\s+(class|struct|void|int|bool|auto)' \
        --glob '*.h' --glob '*.hpp' --glob '*.hxx' \
        "$TARGET" 2>/dev/null || true; } | awk -F: '{sum+=$2} END {print sum+0}' )
    echo "    $friends 处"

    echo ""
    echo "  C 风格类型转换（潜在）："
    local c_casts
    c_casts=$( { rg -c '\(\s*(int|char|void|long|short|unsigned|float|double)\s*\*?\s*\)' \
        --glob '*.cpp' --glob '*.cxx' --glob '*.cc' \
        "$TARGET" 2>/dev/null || true; } | awk -F: '{sum+=$2} END {print sum+0}' )
    echo "    约 $c_casts 处"
}

# ── 7. CodeGraph 索引状态 ────────────────────────────────
codegraph_status() {
    separator "7. CodeGraph 索引状态"

    if ! command -v codegraph &>/dev/null; then
        echo "  ⚠ codegraph 未安装，跳过索引状态检查"
        echo "  安装: npm install -g @anthropic/codegraph"
        return
    fi

    local cg_dir="$TARGET/.codegraph"
    if [[ ! -d "$cg_dir" ]]; then
        echo "  ⚠ 项目未初始化 codegraph 索引"
        echo "  初始化: codegraph init $TARGET"
        return
    fi

    echo "  索引位置: $cg_dir"
    echo ""

    # 调用 codegraph status 获取索引信息
    local status_output
    status_output=$(codegraph status "$TARGET" 2>/dev/null || true)

    if [[ -n "$status_output" ]]; then
        # 提取关键指标
        local files nodes edges
        files=$(echo "$status_output" | grep -oP 'Files:\s+\K[\d,]+' | head -1 | tr -d ',' || echo "?")
        nodes=$(echo "$status_output" | grep -oP 'Nodes:\s+\K[\d,]+' | head -1 | tr -d ',' || echo "?")
        edges=$(echo "$status_output" | grep -oP 'Edges:\s+\K[\d,]+' | head -1 | tr -d ',' || echo "?")

        echo "  文件数: $files"
        echo "  节点数: $nodes"
        echo "  边数:   $edges"
        echo ""

        # 显示节点类型分布
        echo "  节点类型分布:"
        echo "$status_output" | grep -E '^\s+(method|class|struct|function|variable|import|type_alias|constant|interface|enum|route|component)' | head -10 | sed 's/^/    /' || true
    else
        echo "  ⚠ 无法获取 codegraph 状态"
    fi
}

# ── 主流程 ────────────────────────────────────────────────
main() {
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║         C++ 项目预扫描报告 (cpp-scan)                  ║"
    echo "║         目标：$(basename "$TARGET")                     "
    echo "║         时间：$(date '+%Y-%m-%d %H:%M:%S')             "
    echo "╚══════════════════════════════════════════════════════════╝"

    detect_cpp_standard
    file_line_stats
    function_length_stats
    include_dependency_stats
    conditional_compilation_stats
    smell_indicators
    codegraph_status

    separator "扫描完成"
    echo "  后续步骤："
    echo "  1. 根据 CPP_STANDARD 确认版本兼容性约束"
    echo "  2. 对 TOP 巨型文件执行 cpp-seam-finder.sh 进行接缝分析"
    echo "  3. 使用 codegraph 获取架构级依赖图 (codegraph_context / codegraph_impact)"
    echo ""
    echo "  建议将本报告重定向到文件："
    echo "  bash cpp-scan.sh {项目路径} > state/scan-report.txt"
}

main "$@"
