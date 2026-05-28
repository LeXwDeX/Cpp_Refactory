#!/usr/bin/env bash
# ledger.sh — 三层 PARTITION_LEDGER 管理 CLI
#
# 用途：
#   - 在 5万行级屎山项目中，台账会膨胀到数百条。手工维护会出错。
#   - 提供 init / wave-add / batch-add / partition-add / status / list / promote / sync 子命令
#
# 文件位置：项目根 `.cpp_refactory/state/PARTITION_LEDGER.md`
#
# 依赖：bash 4+, awk, sed, mktemp。无 yq/jq 依赖（用 Markdown 锚点解析）。

set -uo pipefail

if file "$0" 2>/dev/null | grep -q CRLF; then
    tr -d '\r' < "$0" > "$0.tmp" && mv "$0.tmp" "$0" && chmod +x "$0"
    exec bash "$0" "$@"
fi

LEDGER_REL=".cpp_refactory/state/PARTITION_LEDGER.md"

# ── 工具 ───────────────────────────────────────────────
die()  { echo "ERROR: $*" >&2; exit 1; }
info() { echo "[ledger] $*" >&2; }

find_project_root() {
    local dir="${1:-$PWD}"
    while [[ "$dir" != "/" ]]; do
        [[ -d "$dir/.cpp_refactory" ]] && { echo "$dir"; return 0; }
        dir=$(dirname "$dir")
    done
    return 1
}

today() { date +%Y-%m-%d; }

# 在 "## 平铺总览" 之前插入一段内容（保持 sync 区永远在文件末尾）
# 用法：append_before_overview <ledger> <heredoc 字符串>
append_before_overview() {
    local path="$1"
    local content="$2"
    local tmp; tmp=$(mktemp)
    if grep -qE '^## 平铺总览' "$path"; then
        awk -v c="$content" '
            /^## 平铺总览/ && !done {
                print c
                print ""
                done=1
            }
            { print }
        ' "$path" > "$tmp" && mv "$tmp" "$path"
    else
        # 没有平铺总览段，直接追加
        printf "\n%s\n" "$content" >> "$path"
    fi
}

ledger_path() {
    local root
    root=$(find_project_root) || die "未找到 .cpp_refactory/，请先 cd 到项目根或先 init"
    echo "$root/$LEDGER_REL"
}

ensure_ledger() {
    local path="$1"
    [[ -f "$path" ]] || die "台账不存在：$path（先运行 ledger.sh init）"
}

# ── init ──────────────────────────────────────────────
cmd_init() {
    local root="${1:-$PWD}"
    local target="$root/$LEDGER_REL"
    if [[ -f "$target" ]]; then
        info "已存在：$target"
        return 0
    fi
    mkdir -p "$(dirname "$target")"

    # 模板从 cpp_refactory 安装路径取
    local tmpl=""
    for cand in \
        "$HOME/cpp_refactory/state/_template/PARTITION_LEDGER.md" \
        "/root/cpp_refactory/state/_template/PARTITION_LEDGER.md" \
        "$(dirname "$0")/../state/_template/PARTITION_LEDGER.md"
    do
        [[ -f "$cand" ]] && { tmpl="$cand"; break; }
    done
    [[ -n "$tmpl" ]] || die "找不到 PARTITION_LEDGER 模板"
    cp "$tmpl" "$target"
    info "已创建：$target （来自 $tmpl）"
}

# ── id 生成 ───────────────────────────────────────────
next_id() {
    # next_id <prefix> <ledger>
    local prefix="$1" path="$2"
    local max
    max=$(grep -oE "${prefix}-[0-9]+" "$path" 2>/dev/null \
        | sed "s/${prefix}-//" \
        | sort -n \
        | tail -1)
    [[ -z "$max" ]] && max=0
    printf "%s-%03d" "$prefix" "$((10#$max + 1))"
}

# ── wave-add ──────────────────────────────────────────
cmd_wave_add() {
    local goal="${1:-}" scope="${2:-}"
    [[ -n "$goal" ]] || die "用法：ledger.sh wave-add <goal> [scope]"
    local path; path=$(ledger_path); ensure_ledger "$path"
    local wid; wid=$(next_id W "$path")
    local d; d=$(today)

    local block
    block=$(cat <<EOF
### $wid: $goal

- **目标**：$goal
- **范围**：${scope:-未填写}
- **预计 Batches**：?
- **预计 Partitions**：?
- **状态**：PLANNED
- **启动日期**：$d
- **完成日期**：-
- **驱动指标**：未填写

#### Batches in $wid

| Batch ID | 目标 | Partitions | 状态 | 会话日期 |
|----------|------|------------|------|----------|
EOF
    )
    append_before_overview "$path" "$block"
    info "新增 Wave: $wid"
    echo "$wid"
}

# ── batch-add ─────────────────────────────────────────
cmd_batch_add() {
    local wave="${1:-}" goal="${2:-}"
    [[ -n "$wave" && -n "$goal" ]] || die "用法：ledger.sh batch-add <W-id> <goal>"
    local path; path=$(ledger_path); ensure_ledger "$path"
    grep -qE "^### $wave: " "$path" || die "Wave 不存在：$wave"
    local bid; bid=$(next_id B "$path")
    local d; d=$(today)

    local block
    block=$(cat <<EOF
### $bid ($wave): $goal

- **目标**：$goal
- **预算**：未填写
- **依赖 Batches**：-
- **状态**：PLANNED
- **会话日期**：$d
- **AST 缓存预热**：（可选）

#### Partitions in $bid

| ID | 文件 | 行范围 | 状态 | 风险 | 备注 |
|----|------|--------|------|------|------|
EOF
    )
    append_before_overview "$path" "$block"
    info "新增 Batch: $bid (隶属 $wave)"
    echo "$bid"
}

# ── partition-add ─────────────────────────────────────
cmd_partition_add() {
    # ledger.sh partition-add <B-id> <file> <line-range> <risk> <name>
    local batch="${1:-}" file="${2:-}" range="${3:-}" risk="${4:-}" name="${5:-}"
    [[ -n "$batch" && -n "$file" && -n "$range" && -n "$risk" && -n "$name" ]] \
        || die "用法：ledger.sh partition-add <B-id> <file> <L-a-L-b> <risk:low|med|high> <name>"
    local path; path=$(ledger_path); ensure_ledger "$path"
    local wave
    wave=$(grep -E "^### $batch \(W-[0-9]+\):" "$path" | head -1 \
           | sed -E 's/.*\((W-[0-9]+)\).*/\1/')
    [[ -n "$wave" ]] || die "无法找到 Batch $batch 所属 Wave"

    local pid; pid=$(next_id P "$path")
    local d; d=$(today)

    local block
    block=$(cat <<EOF
### $pid ($batch / $wave): $name

- **状态**：PLANNED
- **文件**：$file
- **行范围**：$range
- **关联符号**：未填写
- **风险**：$risk
- **依赖 Partitions**：-
- **重构策略**：未填写
- **影响分析**：未执行（运行 \`codegraph_codegraph_impact\` 后填写）
- **特征化测试**：未填写
- **验证步骤**：
  1. 编译：未填写
  2. 测试：未填写
  3. impact 校验：\`codegraph_codegraph_impact\`
- **验证结果**：未执行
- **耗时**：-
- **备注**：

最后更新：$d
EOF
    )
    append_before_overview "$path" "$block"
    info "新增 Partition: $pid (隶属 $batch / $wave)"
    echo "$pid"
}

# ── status ────────────────────────────────────────────
cmd_status() {
    local path; path=$(ledger_path); ensure_ledger "$path"
    local waves batches parts
    waves=$(grep -cE '^### W-[0-9]+:' "$path" || true)
    batches=$(grep -cE '^### B-[0-9]+ \(W-' "$path" || true)
    parts=$(grep -cE '^### P-[0-9]+ \(B-' "$path" || true)

    echo "Ledger: $path"
    echo "  Waves:      $waves"
    echo "  Batches:    $batches"
    echo "  Partitions: $parts"
    echo ""
    echo "状态分布："
    for s in PLANNED IN_PROGRESS VERIFIED DONE BLOCKED FAILED ESCALATED; do
        local n
        n=$(awk -v s="$s" '
            /^### P-[0-9]+ / { in_p=1; next }
            in_p && /^- \*\*状态\*\*：/ {
                sub(/.*状态\*\*：/, "")
                sub(/[ \t]*$/, "")
                if ($0 == s) c++
                in_p=0
            }
            END { print c+0 }
        ' "$path")
        printf "  %-12s %d\n" "$s" "$n"
    done
}

# ── list ──────────────────────────────────────────────
cmd_list() {
    local filter="${1:-}"
    local path; path=$(ledger_path); ensure_ledger "$path"
    awk -v f="$filter" '
        /^### W-[0-9]+:/ { wave=$2; sub(/:$/, "", wave); print "[Wave]  " $0 }
        /^### B-[0-9]+ \(W-/ { print "[Batch] " $0 }
        /^### P-[0-9]+ \(B-/ {
            pid=$2
            in_p=1
            line=$0
            next
        }
        in_p && /^- \*\*状态\*\*：/ {
            st=$0; sub(/.*状态\*\*：/, "", st); sub(/[ \t]*$/, "", st)
            if (f == "" || st == f) print "[Part]  " line " — " st
            in_p=0
        }
    ' "$path"
}

# ── promote ───────────────────────────────────────────
cmd_promote() {
    local pid="${1:-}" newst="${2:-}"
    [[ -n "$pid" && -n "$newst" ]] || die "用法：ledger.sh promote <P-id> <NEW_STATE>"
    case "$newst" in
        PLANNED|IN_PROGRESS|VERIFIED|DONE|BLOCKED|FAILED|ESCALATED) ;;
        *) die "非法状态：$newst" ;;
    esac
    local path; path=$(ledger_path); ensure_ledger "$path"
    grep -qE "^### $pid \(B-" "$path" || die "Partition 不存在：$pid"

    local d; d=$(today)
    # 用 awk 在 P-id 段内替换状态行 + 更新"最后更新"
    local tmp; tmp=$(mktemp)
    awk -v pid="$pid" -v st="$newst" -v d="$d" '
        BEGIN { in_p=0 }
        /^### P-[0-9]+ \(B-/ {
            in_p=($2 == pid)
        }
        in_p && /^- \*\*状态\*\*：/ {
            sub(/状态\*\*：.*/, "状态**：" st)
        }
        in_p && /^最后更新：/ {
            $0="最后更新：" d
        }
        { print }
    ' "$path" > "$tmp" && mv "$tmp" "$path"
    info "$pid → $newst (更新于 $d)"
}

# ── sync 平铺总览 ────────────────────────────────────
cmd_sync() {
    local path; path=$(ledger_path); ensure_ledger "$path"
    local tmp; tmp=$(mktemp)

    # 提取所有 Partition 数据
    local rows
    rows=$(awk '
        /^### P-[0-9]+ \(B-[0-9]+ \/ W-[0-9]+\):/ {
            pid=$2
            # batch 在第 3 字段去掉前导括号
            split($0, a, /[()]/)
            split(a[2], b, /\//)
            batch=b[1]; gsub(/^[ \t]+|[ \t]+$/, "", batch)
            wave=b[2]; gsub(/^[ \t]+|[ \t]+$/, "", wave)
            in_p=1; file=""; range=""; status=""; risk=""; updated=""
            next
        }
        in_p && /^- \*\*文件\*\*：/  { file=$0;  sub(/.*文件\*\*：/, "", file) }
        in_p && /^- \*\*行范围\*\*：/ { range=$0; sub(/.*行范围\*\*：/, "", range); sub(/（.*$/, "", range) }
        in_p && /^- \*\*状态\*\*：/   { status=$0; sub(/.*状态\*\*：/, "", status) }
        in_p && /^- \*\*风险\*\*：/   { risk=$0; sub(/.*风险\*\*：/, "", risk) }
        in_p && /^最后更新：/         {
            updated=$0; sub(/最后更新：/, "", updated)
            printf "| %s | %s | %s | %s | %s | %s | %s | %s |\n", \
                pid, wave, batch, file, range, status, risk, updated
            in_p=0
        }
    ' "$path")

    # 替换 "## 平铺总览" 段
    awk -v rows="$rows" '
        BEGIN { skip=0 }
        /^## 平铺总览/ {
            print
            print ""
            print "> 兼容旧版 P-NNN 平铺视图。由 `ledger.sh sync` 自动维护。"
            print ""
            print "| ID | Wave | Batch | 文件 | 行范围 | 状态 | 风险 | 最后更新 |"
            print "|----|------|-------|------|--------|------|------|----------|"
            print rows
            skip=1
            next
        }
        skip && /^## / { skip=0 }
        !skip { print }
    ' "$path" > "$tmp" && mv "$tmp" "$path"

    info "已同步平铺总览"
    cmd_status
}

# ── help ──────────────────────────────────────────────
cmd_help() {
    cat <<'EOF'
ledger.sh — 三层 PARTITION_LEDGER 管理

用法：
  ledger.sh init [project_root]                            初始化台账
  ledger.sh wave-add <goal> [scope]                        新增 Wave
  ledger.sh batch-add <W-id> <goal>                        新增 Batch
  ledger.sh partition-add <B-id> <file> <range> <risk> <name>
                                                           新增 Partition
                                                           range 形如 "L100-L250"
                                                           risk: low | med | high
  ledger.sh promote <P-id> <STATE>                         切换 Partition 状态
                                                           STATE: PLANNED|IN_PROGRESS|VERIFIED|
                                                                  DONE|BLOCKED|FAILED|ESCALATED
  ledger.sh status                                         显示统计
  ledger.sh list [STATE]                                   列出全部或按状态过滤
  ledger.sh sync                                           重建平铺总览表
  ledger.sh help                                           本帮助

工作流：
  1) ledger.sh init
  2) ledger.sh wave-add "拆分 GodModule.cpp"
  3) ledger.sh batch-add W-001 "提取第 1-3 责任域"
  4) ledger.sh partition-add B-001 src/x.cpp L100-L250 med "Extract LegacyParser"
  5) ledger.sh promote P-001 IN_PROGRESS
     ... 重构 + impact 校验 ...
  6) ledger.sh promote P-001 VERIFIED
  7) ledger.sh sync   # 刷新平铺总览
EOF
}

# ── dispatch ──────────────────────────────────────────
sub="${1:-help}"
shift || true
case "$sub" in
    init)            cmd_init "$@" ;;
    wave-add)        cmd_wave_add "$@" ;;
    batch-add)       cmd_batch_add "$@" ;;
    partition-add)   cmd_partition_add "$@" ;;
    promote)         cmd_promote "$@" ;;
    status)          cmd_status "$@" ;;
    list)            cmd_list "$@" ;;
    sync)            cmd_sync "$@" ;;
    help|-h|--help)  cmd_help ;;
    *)               die "未知子命令：$sub（运行 ledger.sh help）" ;;
esac
