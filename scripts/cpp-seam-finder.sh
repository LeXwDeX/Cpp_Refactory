#!/usr/bin/env bash
# cpp-seam-finder.sh — C++ 接缝发现脚本
# 用途：扫描指定文件/目录中的"接缝"（Seams），即可以安全切入重构的边界点
# 依赖：rg (ripgrep)、awk — 不依赖 clang 或其他重量级工具
#
# 用法：
#   bash cpp-seam-finder.sh <文件或目录>
#   bash cpp-seam-finder.sh <文件> <起始行> <结束行>    # 扫描指定行范围
#
# 输出：分类的接缝报告

set -euo pipefail

# CRLF 自愈
if file "$0" | grep -q CRLF; then
    tr -d '\r' < "$0" > "$0.tmp" && mv "$0.tmp" "$0" && chmod +x "$0"
    exec bash "$0" "$@"
fi

# ── 参数解析 ──────────────────────────────────────────────
TARGET="${1:-.}"
LINE_START="${2:-}"
LINE_END="${3:-}"

if [[ ! -e "$TARGET" ]]; then
    echo "错误：目标 '$TARGET' 不存在" >&2
    exit 1
fi

if ! command -v rg &>/dev/null; then
    echo "错误：需要 ripgrep (rg)，请先安装" >&2
    exit 1
fi

# 判断目标是文件还是目录
IS_FILE=false
if [[ -f "$TARGET" ]]; then
    IS_FILE=true
fi

# rg 通用参数（使用数组避免引用问题）
RG_GLOB_ARGS=()
if [[ "$IS_FILE" == "false" ]]; then
    RG_GLOB_ARGS=(--glob '*.cpp' --glob '*.cxx' --glob '*.cc' --glob '*.h' --glob '*.hpp' --glob '*.hxx')
fi

# ── 工具函数 ──────────────────────────────────────────────
separator() {
    echo ""
    echo "────────────────────────────────────────────────────────────"
    echo "  $1"
    echo "────────────────────────────────────────────────────────────"
}

# 如果指定了行范围，用 sed 提取后再分析
get_target_content() {
    if [[ "$IS_FILE" == "true" && -n "$LINE_START" && -n "$LINE_END" ]]; then
        sed -n "${LINE_START},${LINE_END}p" "$TARGET"
    elif [[ "$IS_FILE" == "true" ]]; then
        cat "$TARGET"
    fi
}

# 在文件/目录中搜索（自动处理行范围）
search_pattern() {
    local pattern="$1"
    local extra_args="${2:-}"

    if [[ "$IS_FILE" == "true" && -n "$LINE_START" && -n "$LINE_END" ]]; then
        # 行范围模式：先提取行，再搜索，手动重算行号
        sed -n "${LINE_START},${LINE_END}p" "$TARGET" | \
            rg -n $extra_args "$pattern" 2>/dev/null | \
            awk -F: -v offset="$((LINE_START - 1))" '{ $1 = $1 + offset; print }' OFS=: || true
    elif [[ "$IS_FILE" == "true" ]]; then
        rg -n $extra_args "$pattern" "$TARGET" 2>/dev/null || true
    else
        rg -n "${RG_GLOB_ARGS[@]}" $extra_args "$pattern" "$TARGET" 2>/dev/null || true
    fi
}

# ── 1. 全局变量扫描 ──────────────────────────────────────
scan_globals() {
    separator "1. 全局变量（非 const 的文件/命名空间级变量）"

    echo ""
    echo "  === 非 const 全局变量 ==="
    # 匹配文件顶层的变量声明（启发式：行首非空白开头、不是函数定义、不是 class/struct/enum）
    if [[ "$IS_FILE" == "true" ]]; then
        awk '
        # 跳过函数体内部
        /^\{/ { depth++ }
        /^\}/ { if (depth > 0) depth-- }
        depth > 0 { next }

        # 跳过注释、空行、预处理指令、类定义、函数定义
        /^\s*$/ || /^\s*\/\// || /^\s*\/\*/ || /^\s*\*/ || /^#/ { next }
        /^\s*(class|struct|enum|namespace|template|typedef|using|return|if|else|for|while|switch|case)/ { next }
        /\)\s*\{?\s*$/ { next }  # 函数定义

        # 可能是全局变量
        /^(static\s+)?[a-zA-Z_][\w:<>*& ]+\s+[a-zA-Z_]\w*\s*[=;]/ {
            if ($0 !~ /\bconst\b/ && $0 !~ /\bconstexpr\b/) {
                printf "  L%d: %s\n", NR, $0
            }
        }
        ' "$TARGET" 2>/dev/null | head -30
    else
        # 目录模式：用 rg 搜索
        rg -n '^(static\s+)?(?!.*\bconst\b)(?!.*\bconstexpr\b)[a-zA-Z_][\w:<>*& ]+\s+[a-zA-Z_]\w*\s*[=;]' \
            "${RG_GLOB_ARGS[@]}" "$TARGET" 2>/dev/null | \
            rg -v '(class|struct|enum|namespace|template|typedef|using|return)\b' | head -30 || true
    fi

    echo ""
    echo "  === extern 声明（跨文件共享状态） ==="
    search_pattern '\bextern\s+(?!.*"C")' | head -20

    echo ""
    echo "  === static 文件级变量 ==="
    search_pattern '^\s*static\s+(?!.*\bconst\b)(?!.*inline\b)\w' | head -20
}

# ── 2. 宏丛林扫描 ────────────────────────────────────────
scan_macros() {
    separator "2. 宏丛林（条件编译 #ifdef 分析）"

    echo ""
    echo "  === #ifdef / #ifndef / #if defined 块 ==="
    search_pattern '#\s*(ifdef|ifndef|if\s+defined|if\s+!)' | head -30

    echo ""
    echo "  === 使用的宏名称统计 ==="
    search_pattern '#\s*(ifdef|ifndef)\s+(\w+)' | \
        rg -oI '#\s*(ifdef|ifndef)\s+(\w+)' --replace '$2' 2>/dev/null | \
        sort | uniq -c | sort -rn | head -15 || true

    echo ""
    echo "  === 功能性宏定义（非头文件守卫） ==="
    search_pattern '#\s*define\s+\w+\(' | head -20

    echo ""
    echo "  === #if 嵌套深度 ==="
    if [[ "$IS_FILE" == "true" ]]; then
        awk '
        /#\s*if/ { depth++; if (depth > max) { max = depth; max_line = NR } }
        /#\s*endif/ { depth-- }
        END { printf "  最大嵌套深度：%d（位于 L%d 附近）\n", max, max_line }
        ' "$TARGET" 2>/dev/null
    else
        echo "  （目录模式下跳过嵌套深度分析，请指定具体文件）"
    fi
}

# ── 3. 单例模式扫描 ──────────────────────────────────────
scan_singletons() {
    separator "3. 单例模式"

    echo ""
    echo "  === getInstance() 类模式 ==="
    search_pattern '\bgetInstance\s*\(' | head -15

    echo ""
    echo "  === 静态局部对象（Meyer's Singleton） ==="
    search_pattern 'static\s+\w[\w:<>]+\s*&?\s+\w+\s*\(' | head -10

    echo ""
    echo "  === 全局单例指针 ==="
    search_pattern '(static\s+)?\w[\w:<>*]+\s*\*\s*\w*(instance|Instance|singleton|Singleton|s_|g_)' | head -10
}

# ── 4. 裸指针与手动内存管理 ──────────────────────────────
scan_raw_pointers() {
    separator "4. 裸指针与手动内存管理"

    echo ""
    echo "  === 裸 new 调用 ==="
    search_pattern '\bnew\s+\w' | head -20

    echo ""
    echo "  === 裸 delete 调用 ==="
    search_pattern '\bdelete\s*(\[\])?\s*\w' | head -20

    echo ""
    echo "  === malloc/calloc/realloc/free ==="
    search_pattern '\b(malloc|calloc|realloc|free)\s*\(' | head -15

    echo ""
    echo "  === void* 使用 ==="
    search_pattern '\bvoid\s*\*' | head -10

    # new 与 delete 平衡检查
    local new_count delete_count
    new_count=$(search_pattern '\bnew\s+\w' | wc -l)
    delete_count=$(search_pattern '\bdelete' | wc -l)
    echo ""
    echo "  new/delete 平衡：new=$new_count，delete=$delete_count"
    if [[ "$new_count" -gt "$((delete_count + delete_count / 3))" ]]; then
        echo "  ⚠ 警告：new 明显多于 delete，可能存在内存泄漏或混合使用智能指针"
    fi
}

# ── 5. 函数指针与回调 ────────────────────────────────────
scan_callbacks() {
    separator "5. 函数指针与回调"

    echo ""
    echo "  === C 风格函数指针 ==="
    search_pattern '\(\s*\*\s*\w+\s*\)\s*\(' | head -15

    echo ""
    echo "  === typedef 函数指针 ==="
    search_pattern 'typedef\s+\w[\w*&:<> ]+\s*\(\s*\*' | head -10

    echo ""
    echo "  === std::function / std::bind ==="
    search_pattern '\bstd::(function|bind)\b' | head -10

    echo ""
    echo "  === 回调注册模式（Register/Set/Add + Callback/Handler/Listener） ==="
    search_pattern '\b(Register|Set|Add|On)\w*(Callback|Handler|Listener|Hook|Observer)\b' | head -15
}

# ── 6. friend 与封装破坏 ─────────────────────────────────
scan_encapsulation() {
    separator "6. 封装破坏"

    echo ""
    echo "  === friend 声明 ==="
    search_pattern '\bfriend\s+(class|struct|void|int|bool|auto|unsigned|const)' | head -15

    echo ""
    echo "  === public 数据成员（结构暴露） ==="
    # 检测 public: 之后的非函数成员
    if [[ "$IS_FILE" == "true" ]]; then
        awk '
        /public\s*:/ { in_public = 1; next }
        /private\s*:/ || /protected\s*:/ { in_public = 0; next }
        /^\s*\}/ { in_public = 0 }
        in_public && /^\s+\w[\w:<>*& ]+\s+\w+\s*;/ && !/\(/ {
            printf "  L%d: %s\n", NR, $0
        }
        ' "$TARGET" 2>/dev/null | head -15
    else
        echo "  （目录模式下跳过，请指定具体文件）"
    fi
}

# ── 7. 类型转换风险 ──────────────────────────────────────
scan_casts() {
    separator "7. 类型转换风险"

    echo ""
    echo "  === const_cast（可能破坏 const 正确性） ==="
    search_pattern '\bconst_cast\s*<' | head -10

    echo ""
    echo "  === reinterpret_cast（底层内存重新解读） ==="
    search_pattern '\breinterpret_cast\s*<' | head -10

    echo ""
    echo "  === C 风格类型转换 ==="
    search_pattern '\(\s*(int|char|void|long|short|unsigned|float|double|size_t|uint\w+|int\w+)\s*\*?\s*\)' | head -15

    echo ""
    echo "  === dynamic_cast（运行时类型检查，RTTI 依赖） ==="
    search_pattern '\bdynamic_cast\s*<' | head -10
}

# ── 8. 潜在 UB 风险点 ────────────────────────────────────
scan_ub_risks() {
    separator "8. 潜在未定义行为 (UB) 风险点"

    echo ""
    echo "  === 迭代器失效风险（循环内修改容器） ==="
    search_pattern '\b(erase|insert|push_back|emplace|resize)\s*\(' | head -15

    echo ""
    echo "  === 悬空引用风险（返回局部变量引用/指针） ==="
    search_pattern 'return\s+&\w+\s*;' | head -10

    echo ""
    echo "  === 未初始化变量风险（声明但不初始化） ==="
    if [[ "$IS_FILE" == "true" ]]; then
        rg -n '^\s+(int|char|long|short|unsigned|float|double|bool|size_t)\s+\w+\s*;' "$TARGET" 2>/dev/null | head -10 || true
    fi

    echo ""
    echo "  === 潜在整数溢出（无保护的算术运算） ==="
    search_pattern '\b(INT_MAX|UINT_MAX|SIZE_MAX|LLONG_MAX)' | head -5
    echo "  （存在边界常量引用说明可能有边界处理，但也需要验证）"
}

# ── 9. CodeGraph 影响分析 ────────────────────────────────
scan_codegraph_impact() {
    separator "9. CodeGraph 影响分析"

    if ! command -v codegraph &>/dev/null; then
        echo "  ⚠ codegraph 未安装，跳过影响分析"
        return
    fi

    # 检测 .codegraph 索引
    local project_root="$TARGET"
    if [[ "$IS_FILE" == "true" ]]; then
        project_root=$(dirname "$TARGET")
    fi

    # 向上查找 .codegraph 目录
    local cg_dir=""
    local search_dir="$project_root"
    while [[ "$search_dir" != "/" ]]; do
        if [[ -d "$search_dir/.codegraph" ]]; then
            cg_dir="$search_dir/.codegraph"
            break
        fi
        search_dir=$(dirname "$search_dir")
    done

    if [[ -z "$cg_dir" ]]; then
        echo "  ⚠ 未找到 .codegraph 索引"
        echo "  初始化: codegraph init $project_root"
        return
    fi

    echo "  索引位置: $cg_dir"
    echo ""

    # 提取关键符号（类、函数）进行分析
    local symbols=()

    if [[ "$IS_FILE" == "true" ]]; then
        # 从文件中提取类名和函数名
        while IFS= read -r sym; do
            [[ -n "$sym" ]] && symbols+=("$sym")
        done < <(rg -oN '(class|struct)\s+\K\w+' "$TARGET" 2>/dev/null | head -5 || true)

        while IFS= read -r sym; do
            [[ -n "$sym" ]] && symbols+=("$sym")
        done < <(rg -oN '^\w[\w:<>*& ]+\s+\K\w+(?=\s*\()' "$TARGET" 2>/dev/null | head -5 || true)
    else
        # 从目录中提取 Top 符号
        while IFS= read -r sym; do
            [[ -n "$sym" ]] && symbols+=("$sym")
        done < <(rg -oN '(class|struct)\s+\K\w+' "${RG_GLOB_ARGS[@]}" "$TARGET" 2>/dev/null | sort | uniq -c | sort -rn | head -5 | awk '{print $2}' || true)
    fi

    if [[ ${#symbols[@]} -eq 0 ]]; then
        echo "  未提取到可分析的符号"
        return
    fi

    echo "  分析 ${#symbols[@]} 个关键符号的影响范围:"
    echo ""

    for sym in "${symbols[@]}"; do
        local impact_output
        impact_output=$(codegraph impact "$sym" "$project_root" 2>/dev/null || true)

        if [[ -n "$impact_output" ]]; then
            # 提取受影响数量
            local affected_count
            affected_count=$(echo "$impact_output" | grep -c "→" || echo "0")
            echo "  [$sym] 影响 $affected_count 个符号"
            echo "$impact_output" | head -5 | sed 's/^/    /' || true
            echo ""
        else
            echo "  [$sym] 无影响数据（可能是新符号或索引未更新）"
        fi
    done
}

# ── 主流程 ────────────────────────────────────────────────
main() {
    local target_desc
    if [[ "$IS_FILE" == "true" ]]; then
        target_desc="$(basename "$TARGET")"
        if [[ -n "$LINE_START" && -n "$LINE_END" ]]; then
            target_desc="${target_desc}:L${LINE_START}-L${LINE_END}"
        fi
    else
        target_desc="$(basename "$TARGET")/"
    fi

    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║         C++ 接缝发现报告 (cpp-seam-finder)             ║"
    echo "║         目标：$target_desc"
    echo "║         时间：$(date '+%Y-%m-%d %H:%M:%S')             "
    echo "╚══════════════════════════════════════════════════════════╝"

    scan_globals
    scan_macros
    scan_singletons
    scan_raw_pointers
    scan_callbacks
    scan_encapsulation
    scan_casts
    scan_ub_risks
    scan_codegraph_impact

    separator "接缝扫描完成"
    echo ""
    echo "  发现的接缝分类汇总："
    echo "  - 全局变量：参见第 1 节"
    echo "  - 宏丛林：参见第 2 节"
    echo "  - 单例：参见第 3 节"
    echo "  - 裸指针：参见第 4 节"
    echo "  - 回调/函数指针：参见第 5 节"
    echo "  - 封装破坏：参见第 6 节"
    echo "  - 危险类型转换：参见第 7 节"
    echo "  - UB 风险点：参见第 8 节"
    echo "  - CodeGraph 影响分析：参见第 9 节"
    echo ""
    echo "  后续步骤："
    echo "  1. 根据接缝位置划定分区边界"
    echo "  2. 对高风险接缝（全局变量、裸指针）优先制定隔离策略"
    echo "  3. 使用分区规划模板编排重构顺序"
    echo ""
    echo "  建议将本报告重定向到文件："
    echo "  bash cpp-seam-finder.sh {目标路径} > state/seam-report.txt"
}

main "$@"
