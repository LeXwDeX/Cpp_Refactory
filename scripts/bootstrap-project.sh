#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CPP_REFACTORY_DIR="$(dirname "$SCRIPT_DIR")"

# --- 参数校验 ---
if [[ $# -lt 1 ]]; then
    echo "用法: $0 <目标项目路径>"
    echo "示例: $0 /path/to/my-cpp-project"
    exit 1
fi

TARGET_DIR="$1"

if [[ ! -d "$TARGET_DIR" ]]; then
    echo "错误: 目标目录不存在: $TARGET_DIR"
    exit 1
fi

TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"

CREATED=()
SKIPPED=()

# --- 1. 创建 state/ 目录 ---
STATE_DIR="$TARGET_DIR/state"
mkdir -p "$STATE_DIR"

# --- 2. 拷贝状态模板 ---
TEMPLATE_DIR="$CPP_REFACTORY_DIR/state/_template"
for FILE in REFACTOR_STATE.md PARTITION_LEDGER.md TOOL_GAPS.md; do
    DEST="$STATE_DIR/$FILE"
    SRC="$TEMPLATE_DIR/$FILE"
    if [[ -f "$DEST" ]]; then
        echo "跳过: state/$FILE（已存在）"
        SKIPPED+=("state/$FILE")
    elif [[ ! -f "$SRC" ]]; then
        echo "警告: 模板不存在: $SRC"
    else
        cp "$SRC" "$DEST"
        echo "创建: state/$FILE"
        CREATED+=("state/$FILE")
    fi
done

# --- 3. 拷贝配置文件 ---
CONFIGS_DIR="$CPP_REFACTORY_DIR/configs"
declare -A CONFIG_MAP=(
    ["clangd.yaml"]=".clangd"
    ["clang-tidy.yaml"]=".clang-tidy"
    ["clang-format.yaml"]=".clang-format"
    ["gitattributes"]=".gitattributes"
    ["editorconfig"]=".editorconfig"
)

for SRC_NAME in "${!CONFIG_MAP[@]}"; do
    DEST_NAME="${CONFIG_MAP[$SRC_NAME]}"
    DEST="$TARGET_DIR/$DEST_NAME"
    SRC="$CONFIGS_DIR/$SRC_NAME"
    if [[ -f "$DEST" ]]; then
        echo "跳过: $DEST_NAME（已存在）"
        SKIPPED+=("$DEST_NAME")
    elif [[ ! -f "$SRC" ]]; then
        echo "警告: 配置模板不存在: $SRC"
    else
        cp "$SRC" "$DEST"
        echo "创建: $DEST_NAME"
        CREATED+=("$DEST_NAME")
    fi
done

# --- 4. 生成/合并 opencode.json ---
echo ""
OPENCODE_JSON="$TARGET_DIR/opencode.json"
if [[ -f "$OPENCODE_JSON" ]]; then
    # Merge: add plugin and MCP if missing
    OPENCODE_JSON_PATH="$OPENCODE_JSON" python3 -c "
import json, sys, os
config_path = os.environ['OPENCODE_JSON_PATH']
try:
    config = json.load(open(config_path))
except:
    config = {}
changed = False
if 'plugins' not in config:
    config['plugins'] = []
if 'opencode-cpp-refactory' not in config.get('plugins', []):
    config.setdefault('plugins', []).append('opencode-cpp-refactory')
    changed = True
if 'mcp' not in config:
    config['mcp'] = {}
if 'clang-ast-mcp' not in config.get('mcp', {}):
    config['mcp']['clang-ast-mcp'] = {
        'command': 'docker',
        'args': ['run', '--rm', '-i', '-v', '\${PWD}:/work', 'cpp-refactory']
    }
    changed = True
if changed:
    json.dump(config, open(config_path, 'w'), indent=2, ensure_ascii=False)
    print('  合并: opencode.json (已添加 cpp-refactory 插件和 MCP 配置)')
else:
    print('  跳过: opencode.json (配置已完整)')
" 2>/dev/null
    if [[ $? -eq 0 ]]; then
        SKIPPED+=("opencode.json")
    else
        echo "  跳过: opencode.json (python3 不可用，请手动配置)"
        WARNINGS+=("opencode.json 合并失败: python3 不可用")
    fi
else
    # Generate fresh
    cat > "$OPENCODE_JSON" <<'OCEOF'
{
  "plugins": ["opencode-cpp-refactory"],
  "mcp": {
    "clang-ast-mcp": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-v", "${PWD}:/work", "cpp-refactory"]
    }
  }
}
OCEOF
    echo "  创建: opencode.json (插件 + MCP 配置)"
    CREATED+=("opencode.json")
fi

# --- 5. 检查 compile_commands.json ---
echo ""
if [[ -f "$TARGET_DIR/compile_commands.json" ]]; then
    echo "✓ compile_commands.json 已存在"
else
    echo "⚠ compile_commands.json 不存在"
    echo "  建议生成方式："
    echo "    bear -- make"
    echo "    bear -- cmake --build build/"
fi

# --- 5. 尝试运行 cpp-scan.sh ---
CPP_SCAN="$SCRIPT_DIR/cpp-scan.sh"
if [[ -x "$CPP_SCAN" ]]; then
    echo ""
    echo "--- cpp-scan.sh 输出 ---"
    "$CPP_SCAN" "$TARGET_DIR" 2>/dev/null || true
    echo "--- 结束 ---"
fi

# --- 6. 打印摘要 ---
echo ""
echo "========== 初始化摘要 =========="
echo "项目路径: $TARGET_DIR"
echo ""
if [[ ${#CREATED[@]} -gt 0 ]]; then
    echo "已创建 (${#CREATED[@]}):"
    for F in "${CREATED[@]}"; do
        echo "  + $F"
    done
else
    echo "已创建: 无"
fi
echo ""
if [[ ${#SKIPPED[@]} -gt 0 ]]; then
    echo "已跳过 (${#SKIPPED[@]}):"
    for F in "${SKIPPED[@]}"; do
        echo "  - $F（已存在）"
    done
else
    echo "已跳过: 无"
fi
echo ""
echo "下一步建议:"
echo "  1. 运行 cpp-diagnose 检测完整环境状态"
echo "  2. 确保 compile_commands.json 已生成 (bear -- make)"
echo "  3. 运行 cpp-scan 扫描项目结构"
echo "  4. 使用 cpp-pipeline 启动重构流水线"
echo "================================"
