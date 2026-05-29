#!/usr/bin/env bash
# cpp-extract.sh — 函数抽取工具
# 用法: bash cpp-extract.sh <源文件> <函数名> [--to <目标文件>] [--apply]
#
# 功能:
#   1. 用 ctags 定位函数精确边界
#   2. 提取函数代码
#   3. 生成 patch 预览（默认 dry-run）
#   4. --apply 时实际应用变更
#
# 输出:
#   - 函数代码片段
#   - 建议的 #include 更新
#   - patch 预览（diff 格式）

set -euo pipefail

# CRLF 自愈
if file "$0" | grep -q CRLF 2>/dev/null; then
    tr -d '\r' < "$0" > "$0.tmp" && mv "$0.tmp" "$0" && chmod +x "$0"
    exec bash "$0" "$@"
fi

SOURCE=""
FUNC_NAME=""
TARGET=""
APPLY=0

# 参数解析
while [[ $# -gt 0 ]]; do
    case "$1" in
        --to)
            if [[ $# -lt 2 ]]; then
                echo "错误: --to 需要一个目标文件参数" >&2
                exit 1
            fi
            TARGET="$2"; shift 2 ;;
        --apply) APPLY=1; shift ;;
        -h|--help)
            sed -n '1,15p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            if [[ -z "$SOURCE" ]]; then
                SOURCE="$1"
            elif [[ -z "$FUNC_NAME" ]]; then
                FUNC_NAME="$1"
            fi
            shift
            ;;
    esac
done

if [[ -z "$SOURCE" || -z "$FUNC_NAME" ]]; then
    echo "用法: bash cpp-extract.sh <源文件> <函数名> [--to <目标文件>] [--apply]" >&2
    exit 1
fi

if [[ ! -f "$SOURCE" ]]; then
    echo "错误: 源文件不存在: $SOURCE" >&2
    exit 1
fi

# 依赖检查
if ! command -v ctags &>/dev/null; then
    echo "错误: 需要 Universal Ctags" >&2
    exit 1
fi

SOURCE_ABS=$(readlink -f "$SOURCE")
# 去掉任意扩展名（.cpp/.cc/.cxx/.h...），而非只剥离 .cpp
BASENAME="${SOURCE##*/}"
BASENAME="${BASENAME%.*}"

# 默认目标文件
if [[ -z "$TARGET" ]]; then
    TARGET="${BASENAME}_extracted.cpp"
fi

# 用 ctags 查找函数
# 注意: 不再在缺少 end: 时回退为 line（那会导致只抽取/删除签名行而把函数体留在原处，
# 损坏源文件）。end: 缺失时输出空的第二列，由下方 bash 显式报错。
FUNC_INFO=$(ctags --c++-kinds=f --fields=+ne -o - "$SOURCE_ABS" 2>/dev/null | \
    awk -F'\t' -v name="$FUNC_NAME" '
    $1 == name && /\tfunction\t/ {
        line = ""; endl = ""
        for (i = 4; i <= NF; i++) {
            if ($i ~ /^line:/) line = substr($i, 6)
            else if ($i ~ /^end:/) endl = substr($i, 5)
        }
        if (line != "") printf "%s\t%s\n", line, endl
    }')

if [[ -z "$FUNC_INFO" ]]; then
    echo "错误: 未找到函数 '$FUNC_NAME' in $SOURCE" >&2
    echo "提示: 函数名必须精确匹配（不含类名前缀）" >&2
    exit 1
fi

# 名称冲突检测：重载或跨类同名方法会产生多条匹配，head -1 会静默选错。
MATCH_COUNT=$(printf '%s\n' "$FUNC_INFO" | grep -c .)
if [[ "$MATCH_COUNT" -gt 1 ]]; then
    echo "错误: 函数名 '$FUNC_NAME' 有 $MATCH_COUNT 处匹配（重载或同名方法），无法确定要抽取哪一个。" >&2
    echo "候选位置 (起始行\t结束行):" >&2
    printf '%s\n' "$FUNC_INFO" | sed 's/^/  L/' >&2
    echo "请缩小范围或手动处理。" >&2
    exit 1
fi

START_LINE=$(echo "$FUNC_INFO" | head -1 | cut -f1)
END_LINE=$(echo "$FUNC_INFO" | head -1 | cut -f2)

# end: 缺失保护：旧版 ctags 或未启用 --fields=+ne 时无法提供函数结束行。
# 此时绝不能继续（否则 --apply 会破坏源文件）。
if [[ -z "$END_LINE" ]]; then
    echo "错误: ctags 未提供函数 '$FUNC_NAME' 的结束行 (end:)。" >&2
    echo "需要 Universal Ctags 且支持 --fields=+ne。无法安全抽取，已中止。" >&2
    exit 1
fi

if [[ "$END_LINE" -lt "$START_LINE" ]]; then
    echo "错误: 解析到的结束行 ($END_LINE) 早于起始行 ($START_LINE)，已中止。" >&2
    exit 1
fi

LINE_COUNT=$((END_LINE - START_LINE + 1))

echo "═══════════════════════════════════════════"
echo "  函数抽取预览"
echo "═══════════════════════════════════════════"
echo ""
echo "源文件: $SOURCE_ABS"
echo "函数: $FUNC_NAME (L${START_LINE}-L${END_LINE}, ${LINE_COUNT} 行)"
echo "目标文件: $TARGET"
echo ""

# 提取函数代码
echo "── 函数代码 ──"
echo '```cpp'
sed -n "${START_LINE},${END_LINE}p" "$SOURCE_ABS"
echo '```'
echo ""

# 分析依赖（简单的 #include 检测）
echo "── 依赖分析 ──"
DEPS=$(sed -n "${START_LINE},${END_LINE}p" "$SOURCE_ABS" | \
    grep -oE '\b[A-Za-z_][A-Za-z0-9_]*\b' | \
    sort -u | head -20)
echo "函数中使用的标识符（前 20 个）:"
echo "$DEPS" | tr '\n' ', '
echo ""
echo ""

# 建议的 #include
echo "── 建议的 #include（目标文件） ──"
echo "从源文件复制相关 #include，或根据需要添加:"
head -30 "$SOURCE_ABS" | grep '#include' | head -10
echo ""

# 生成 patch
echo "── Patch 预览 ──"
echo '```diff'
echo "--- a/$(basename "$SOURCE")"
echo "+++ b/$(basename "$SOURCE")"
echo "@@ -${START_LINE},${LINE_COUNT} +0,0 @@"
sed -n "${START_LINE},${END_LINE}p" "$SOURCE_ABS" | sed 's/^/-/'
echo ""
echo "--- /dev/null"
echo "+++ b/$TARGET"
echo "@@ -0,0 +1,${LINE_COUNT} @@"
sed -n "${START_LINE},${END_LINE}p" "$SOURCE_ABS" | sed 's/^/+/'
echo '```'
echo ""

if [[ $APPLY -eq 1 ]]; then
    echo "── 应用变更 ──"

    # 创建目标文件（如果不存在）
    if [[ ! -f "$TARGET" ]]; then
        echo "// Extracted from $SOURCE" > "$TARGET"
        echo "" >> "$TARGET"
        # 复制源文件的 includes
        head -30 "$SOURCE_ABS" | grep '#include' >> "$TARGET"
        echo "" >> "$TARGET"
    fi

    # 追加函数到目标文件
    sed -n "${START_LINE},${END_LINE}p" "$SOURCE_ABS" >> "$TARGET"
    echo "✓ 函数已追加到 $TARGET"

    # 从源文件删除函数
    sed -i "${START_LINE},${END_LINE}d" "$SOURCE_ABS"
    echo "✓ 函数已从 $SOURCE 删除 (L${START_LINE}-L${END_LINE})"

    echo ""
    echo "⚠ 请手动检查:"
    echo "  1. 目标文件的 #include 是否完整"
    echo "  2. 源文件中是否有对已删除函数的调用需要更新"
    echo "  3. 编译是否通过"
else
    echo "── 操作指南 ──"
    echo "这是 dry-run 预览。要实际应用变更，添加 --apply 参数:"
    echo "  bash $0 $SOURCE $FUNC_NAME --to $TARGET --apply"
    echo ""
    echo "⚠ 建议: 应用前先 git commit 当前状态，以便回滚"
fi

echo ""
echo "═══════════════════════════════════════════"
