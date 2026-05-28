# opencode-cpp-refactory

**[English](README.md)**

AI 辅助 C++ 遗留代码重构与新功能开发的 OpenCode 插件，通过 MCP 驱动安全分析网。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  opencode                                                   │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  NPM 插件: opencode-cpp-refactory                     │  │
│  │  ├── 14 个自定义工具（bash 脚本）                      │  │
│  │  ├── 事件钩子（session / tool-guard / env-inject）     │  │
│  │  └── MCP 客户端 ─────────────────┐                    │  │
│  └───────────────────────────────────┼────────────────────┘  │
│                                      │ stdio (JSON-RPC 2.0) │
└──────────────────────────────────────┼──────────────────────┘
                                       │
                        ┌──────────────▼──────────────────┐
                        │  Docker 容器（用户自行管理）       │
                        │  └── clang-ast-mcp 服务端         │
                        │      ├── ASTEngine (libclang-18) │
                        │      ├── list_functions          │
                        │      ├── globals_finder          │
                        │      ├── virtual_calls           │
                        │      └── macro_jungle            │
                        └──────────────────────────────────┘
```

**三个组件，各司其职：**

| 组件 | 职责 | 安装方式 |
|---|---|---|
| **NPM 插件** | 入口 — 工具、钩子、工作流执行 | `npm install opencode-cpp-refactory` |
| **MCP** | 通信协议（基于 stdio 的 JSON-RPC） | 在 `opencode.json` 中配置 |
| **Docker** | clang-ast-mcp 服务端运行环境（用户自行构建和运行） | `docker build` + `docker run` |

---

## 前置条件

### OpenCode（Fork 版本）

本插件需要 [OpenCode fork](https://github.com/LeXwDeX/opencode)（支持插件和 MCP）。请先安装：

**Linux：**
```bash
curl -fsSL https://github.com/LeXwDeX/opencode/releases/latest/download/opencode-linux-x64.tar.gz | tar xz
sudo mv opencode /usr/local/bin/
```

**macOS（Apple Silicon）：**
```bash
curl -fsSL -o opencode.zip https://github.com/LeXwDeX/opencode/releases/latest/download/opencode-darwin-arm64.zip
unzip opencode.zip && sudo mv opencode /usr/local/bin/
```

**Windows：**
```powershell
Invoke-WebRequest -Uri "https://github.com/LeXwDeX/opencode/releases/latest/download/opencode-windows-x64.zip" -OutFile opencode.zip
Expand-Archive opencode.zip -DestinationPath .
# 将 opencode.exe 移动到 PATH 中的目录
```

验证安装：
```bash
opencode --version
```

### Node.js

需要 Node.js >= 18.0.0（NPM 插件运行所需）。

### Docker

需要 Docker Engine >= 20.10（clang-ast-mcp 服务端运行所需）。

---

## 安装

### 第一步：安装 NPM 插件

```bash
npm install opencode-cpp-refactory
```

### 第二步：构建 Docker 镜像

clang-ast-mcp 服务端运行在 Docker 容器内，包含完整的 LLVM/Clang 18 工具链。从本仓库构建：

```bash
git clone https://github.com/LeXwDeX/Cpp_Refactory.git
cd Cpp_Refactory
docker build -t cpp-refactory -f docker/Dockerfile .
```

构建过程会自动运行测试套件（42 个断言 + E2E 重构测试）。**任何测试失败都会终止构建。**

### 第三步：配置 opencode.json

在项目的 `opencode.json` 中同时注册 cpp-refactory 插件、Hindsight 记忆插件和 MCP 服务端：

```json
{
  "plugin": ["opencode-cpp-refactory", "@vectorize-io/opencode-hindsight"],
  "mcp": {
    "clang-ast": {
      "type": "local",
      "command": [
        "docker", "run", "--rm", "-i",
        "-v", "/path/to/your/cpp/project:/work:ro",
        "cpp-refactory"
      ],
      "enabled": true
    }
  }
}
```

**配置说明：**

| 字段 | 用途 |
|---|---|
| `"plugin"` | 向 opencode 注册 cpp-refactory 与 Hindsight NPM 插件 |
| `"mcp.clang-ast"` | 告诉 opencode 如何启动 MCP 服务端 |
| `"-v ...:/work:ro"` | 将你的 C++ 项目以只读方式挂载到容器中 |
| `"docker run -i"` | `-i` 参数**必须** — MCP 通过 stdin/stdout 进行 JSON-RPC 通信 |

> **提示：** 将 `/path/to/your/cpp/project` 替换为你的实际项目路径。容器只读取源文件，所有分析在内存中完成。

启动 opencode 前配置 Hindsight：

```bash
export HINDSIGHT_API_URL="http://localhost:8888"
# 使用 Hindsight Cloud 时可选：
# export HINDSIGHT_API_TOKEN="your-api-key"
```

### 第四步：验证

在 C++ 项目中打开 opencode，调用 `cpp-bootstrap` 工具。如果一切正常：

1. 插件钩子触发（出现 `session.created` 日志）
2. MCP 工具可用（`clang_ast_load`、`clang_ast_list_functions` 等）
3. `cpp-bootstrap` 初始化 `.cpp_refactory/` 工作区

---

## 快速开始

1. 在 OpenCode 中打开 C++ 项目
2. 调用 `cpp-bootstrap` 初始化 `.cpp_refactory/` 工作区
3. 调用 `cpp-scan` 扫描项目
4. 按 6 阶段工作流执行：侦察 → 接缝发现 → 分区规划 → 重构/开发 → 验证 → 归档

---

## 插件工具

以下 14 个工具由 NPM 插件注册，安装后即可使用：

| 工具 | 说明 |
|------|------|
| `cpp-scan` | 项目预扫描：C++ 标准版本、文件热点、上帝函数、#ifdef 丛林指数 |
| `cpp-seam-finder` | 接缝发现（正则启发式，降级路径，误报率 >30%） |
| `cpp-bigfile-map` | 大文件导航地图：章节地图 + 函数索引 + 切割点 |
| `cpp-verify-tools` | 验证工具链完整性（clang-tidy、cppcheck、bear、ccache） |
| `cpp-bootstrap` | 在目标项目中初始化 cpp_refactory 工作区 |
| `cpp-characterize` | 特征化测试生成辅助 |
| `cpp-ast-cache` | AST 磁盘缓存管理（统计/清理/列表） |
| `ledger-init` | 初始化三层台账（Wave/Batch/Partition） |
| `ledger-wave-add` | 创建 Wave（战役级目标） |
| `ledger-batch-add` | 创建 Batch（单次 session 目标） |
| `ledger-partition-add` | 创建 Partition（最小执行单元，约 4 小时） |
| `ledger-promote` | 推进分区状态（PLANNED→IN_PROGRESS→VERIFIED→DONE） |
| `ledger-status` | 查看当前台账概览 |
| `ledger-list` | 列出所有分区详情 |

## MCP 工具（通过 Docker）

以下工具由 Docker 中运行的 clang-ast-mcp 服务端提供，需要第三步中的 MCP 配置：

| 工具 | 说明 |
|---|---|
| `clang_ast_load` | 预热文件的 AST 缓存 |
| `clang_ast_list_functions` | 列出函数及其圈复杂度和行边界 |
| `clang_ast_globals` | 全局变量分析（SIOF 风险检测） |
| `clang_ast_virtual_calls` | 虚调用站点 + 覆写候选 |
| `clang_ast_macro_jungle` | 预处理器复杂度报告 |

---

## 钩子

### session.created
自动读取 `state/` 文件并注入对话上下文。如果 cpp_refactory 未初始化则发出警告。

### tool.execute.before
如果 `.cpp_refactory/` 不存在，阻止 cpp-refactory 工具执行（`cpp-bootstrap` 除外）。对未关闭的工具缺口发出警告。

### shell.env
向所有 shell 会话注入 `CPP_REFACTORY_ROOT`、`CPP_REFACTORY_SCRIPTS`、`CPP_REFACTORY_RESOURCES` 环境变量。

---

## Docker 参考

Docker 镜像支持多种运行模式：

```bash
# MCP 服务端模式（默认 — opencode.json 使用此模式）
docker run --rm -i -v /path/to/project:/work:ro cpp-refactory

# 交互式 shell（调试用）
docker run --rm -it -v /path/to/project:/work cpp-refactory shell

# 运行测试套件
docker run --rm cpp-refactory test --all

# 完整沙盒验证
docker run --rm cpp-refactory bash /opt/cpp_refactory/docker/validate-sandbox.sh
```

### Docker Compose

```bash
export CPP_PROJECT_PATH=/path/to/your/cpp/repo

# 启动 MCP 服务端
docker compose -f docker/docker-compose.yml run --rm -T mcp-server

# 运行测试
docker compose -f docker/docker-compose.yml run --rm test

# 交互式 shell
docker compose -f docker/docker-compose.yml run --rm shell
```

### 安全隔离（docker-compose.yml）

| 措施 | 说明 |
|---|---|
| `read_only: true` | 根文件系统只读 |
| `no-new-privileges` | 禁止提权 |
| `cap_drop: ALL` | 移除所有 Linux capabilities |
| `cap_add: DAC_READ_SEARCH` | 仅允许读取挂载的文件 |
| `networks: internal` | 无外网访问 |
| `memory: 4G` / `cpus: 4.0` | 资源限制 |
| `/work:ro` | 宿主项目只读挂载 |

### 镜像内含组件

| 组件 | 来源 | 用途 |
|---|---|---|
| LLVM/Clang 18 | Ubuntu 24.04 apt | C++ 编译 + AST 分析 |
| libclang-18-dev | Ubuntu 24.04 apt | AST 的 Python 绑定 |
| clang-tidy / clang-format | Ubuntu 24.04 apt | 静态分析 / 代码格式化 |
| cppcheck | Ubuntu 24.04 apt | 互补静态分析 |
| bear | Ubuntu 24.04 apt | 生成 compile_commands.json |
| **clang-ast-mcp** | 本仓库 (`mcp/`) | MCP 服务端，含 5 个 AST 分析工具 |

---

## 可选集成

插件还可集成以下可选组件（需在 `opencode.json` 中单独配置）：

- **codegraph** — Tree-sitter 结构查询（影响分析、调用图、符号搜索）
- **Hindsight** — 通过 `@vectorize-io/opencode-hindsight` 提供持久语义记忆（跨 session 学习）

这些服务端不可用时，插件会优雅降级。

---

## 开发

```bash
# 插件开发
npm install
npm test          # 38 个测试，node:test + tsx
npm run build     # tsup → dist/index.js
npm run typecheck # tsc --noEmit

# Docker 镜像
docker build -t cpp-refactory -f docker/Dockerfile .
docker run --rm cpp-refactory test --all
```

## 许可证

AGPL-3.0-or-later。详见 [LICENSE](LICENSE)。
