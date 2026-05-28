# cpp_refactory 安装指南

> C++ 重型项目重构辅助工具 — 完整安装步骤

---

## 前置要求

| 组件 | 必需 | 说明 |
|---|---|---|
| Node.js ≥ 18 | ✅ | 插件运行时 |
| OpenCode | ✅ | AI 编码助手 |
| Python 3 | ⬜ 可选 | 脚本 JSON 处理（quality-gate、bootstrap） |
| Docker | ⬜ 可选 | MCP AST 分析沙盒 |
| clang-tidy | ⬜ 可选 | 静态分析 |
| cppcheck | ⬜ 可选 | 静态分析 |
| bear | ⬜ 可选 | 生成 compile_commands.json |
| ripgrep (rg) | ⬜ 可选 | 快速搜索 |

---

## 方式一：一键安装（推荐）

### Step 1: 安装插件

```bash
npm install -g opencode-cpp-refactory
```

### Step 2: 初始化项目

```bash
cd /path/to/your-cpp-project
cpp-refactory init
```

这会自动：
- 创建 `.cpp_refactory/state/` 目录
- 生成 `opencode.json`（含插件注册 + MCP 配置）
- 检测 `compile_commands.json` 状态

### Step 3: 诊断环境

```bash
cpp-refactory diagnose
```

查看哪些工具缺失，按提示安装。

### Step 4: 启动 OpenCode

```bash
opencode
```

插件会自动加载，session 开始时显示项目状态。

---

## 方式二：手动安装

### Step 1: 安装 NPM 插件

```bash
npm install -g opencode-cpp-refactory
```

### Step 2: 配置 opencode.json

在项目根目录创建 `opencode.json`：

```json
{
  "plugins": ["opencode-cpp-refactory"],
  "mcp": {
    "clang-ast-mcp": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-v", "${PWD}:/work", "cpp-refactory"]
    }
  }
}
```

### Step 3: 构建 Docker 镜像（可选，用于 AST 分析）

```bash
git clone https://github.com/LeXwDeX/Cpp_Refactory.git
cd Cpp_Refactory
docker build -t cpp-refactory -f docker/Dockerfile .
```

验证：
```bash
docker run --rm cpp-refactory test
```

### Step 4: 生成 compile_commands.json（可选，用于 AST 精准分析）

```bash
# CMake 项目
bear -- cmake --build build/

# Make 项目
bear -- make
```

### Step 5: 安装分析工具（可选）

Ubuntu/Debian:
```bash
sudo apt install clang-tidy cppcheck bear ripgrep
```

macOS:
```bash
brew install llvm cppcheck bear ripgrep
```

---

## 验证安装

### 快速验证

```bash
cpp-refactory diagnose
```

期望输出：
```
═══════════════════════════════════════════
  cpp_refactory 环境诊断报告
═══════════════════════════════════════════

── 工具链 ──
  ✓ [必需] clang-tidy (clang-tidy version 18.x)
  ✓ [必需] cppcheck (Cppcheck 2.x)
  ✓ [必需] bear (bear 3.x)
  ✓ [必需] rg (ripgrep 14.x)

── compile_commands.json ──
  ✓ 状态: valid
    条目数: 42
    有效路径: 42, 无效路径: 0

── 总结 ──
  通过: 5  失败: 0  警告: 0  总计: 5
  整体状态: ✓ 就绪
═══════════════════════════════════════════
```

### 在 OpenCode 中验证

启动 OpenCode 后，观察 session 日志：
```
[cpp-refactory] Session context loaded.
[cpp-refactory] 产品状态: 分析模式=ast(100%), 流水线=未激活, 基线=未记录
```

---

## 常见问题

### Q: compile_commands.json 路径失效

**症状**: diagnose 报告 `path_mismatch`

**原因**: compile_commands.json 在其他机器/容器中生成，路径不匹配

**修复**:
```bash
# 方案 1: 重新生成
bear -- make

# 方案 2: 路径替换
sed -i 's|/old/path|/new/path|g' compile_commands.json
```

### Q: Docker 镜像构建失败

**症状**: `docker build` 报错

**检查**:
```bash
# 确认 Docker daemon 运行中
docker info

# 确认网络可用（需要 apt install）
docker run --rm ubuntu:24.04 apt update
```

### Q: MCP 连接失败

**症状**: OpenCode 中调用 AST 工具超时

**检查**:
```bash
# 手动测试 MCP server
docker run --rm -i cpp-refactory <<< '{"jsonrpc":"2.0","method":"initialize","id":1}'
```

### Q: 不使用 Docker 可以吗？

可以。Docker 仅用于 MCP AST 分析沙盒。不使用 Docker 时：
- 分析工具在宿主环境直接运行
- 需要本地安装 clang-tidy、cppcheck 等
- compile_commands.json 路径直接使用本地路径

---

## CLI 命令参考

```bash
cpp-refactory diagnose [dir]    # 环境诊断
cpp-refactory init [dir]        # 项目初始化
cpp-refactory status [dir]      # 产品状态
cpp-refactory verify [dir]      # 质量门禁

# JSON 输出（供程序消费）
cpp-refactory status --json
cpp-refactory diagnose --json
```

---

## 下一步

安装完成后：

1. **扫描项目**: 在 OpenCode 中调用 `cpp-scan`
2. **启动流水线**: 调用 `cpp-pipeline` 开始重构闭环
3. **记录基线**: 调用 `cpp-quality-gate` 记录质量基线

详细使用指南见 [README_ZH-CN.md](./README_ZH-CN.md)
