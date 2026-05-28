# opencode-cpp-refactory

**[中文文档](README_ZH-CN.md)**

OpenCode plugin for AI-assisted C++ legacy code refactoring and new feature development with MCP-driven safety nets.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  opencode                                                   │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  NPM Plugin: opencode-cpp-refactory                   │  │
 │  │  ├── 17 custom tools (bash scripts + TS modules)      │  │
│  │  ├── Event hooks (session / tool-guard / env-inject)  │  │
│  │  └── MCP client ─────────────────┐                    │  │
│  └───────────────────────────────────┼────────────────────┘  │
│                                      │ stdio (JSON-RPC 2.0) │
└──────────────────────────────────────┼──────────────────────┘
                                       │
                        ┌──────────────▼──────────────────┐
                        │  Docker Container (user-managed) │
                        │  └── clang-ast-mcp server        │
                        │      ├── ASTEngine (libclang-18) │
                        │      ├── list_functions          │
                        │      ├── globals_finder          │
                        │      ├── virtual_calls           │
                        │      └── macro_jungle            │
                        └──────────────────────────────────┘
```

**Three components, each with its own role:**

| Component | What | How |
|---|---|---|
| **NPM Plugin** | Entry point — tools, hooks, workflow enforcement | `npm install opencode-cpp-refactory` |
| **MCP** | Communication protocol (JSON-RPC over stdio) | Configured in `opencode.json` |
| **Docker** | clang-ast-mcp server runtime (user builds & runs) | `docker build` + `docker run` |

---

## Prerequisites

### OpenCode (Fork)

This plugin requires the [OpenCode fork](https://github.com/LeXwDeX/opencode) with plugin and MCP support. Install it first:

**Linux:**
```bash
curl -fsSL https://github.com/LeXwDeX/opencode/releases/latest/download/opencode-linux-x64.tar.gz | tar xz
sudo mv opencode /usr/local/bin/
```

**macOS (Apple Silicon):**
```bash
curl -fsSL -o opencode.zip https://github.com/LeXwDeX/opencode/releases/latest/download/opencode-darwin-arm64.zip
unzip opencode.zip && sudo mv opencode /usr/local/bin/
```

**Windows:**
```powershell
Invoke-WebRequest -Uri "https://github.com/LeXwDeX/opencode/releases/latest/download/opencode-windows-x64.zip" -OutFile opencode.zip
Expand-Archive opencode.zip -DestinationPath .
# Move opencode.exe to a directory in your PATH
```

Verify installation:
```bash
opencode --version
```

### Node.js

Node.js >= 18.0.0 is required (for the NPM plugin).

### Docker

Docker Engine >= 20.10 is required (for the clang-ast-mcp server).

---

## Installation

### Step 1: Install the NPM Plugin

```bash
npm install opencode-cpp-refactory
```

### Step 2: Build the Docker Image

The clang-ast-mcp server runs inside a Docker container with full LLVM/Clang 18 toolchain. Build it from this repo:

```bash
git clone https://github.com/LeXwDeX/Cpp_Refactory.git
cd Cpp_Refactory
docker build -t cpp-refactory -f docker/Dockerfile .
```

The build automatically runs the test suite (42 assertions + E2E refactor tests). **Any failure aborts the build.**

### Step 3: Configure opencode.json

Add both the plugin and the MCP server to your project's `opencode.json`:

```json
{
  "plugin": ["opencode-cpp-refactory"],
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

**Configuration breakdown:**

| Field | Purpose |
|---|---|
| `"plugin"` | Registers the NPM plugin with opencode |
| `"mcp.clang-ast"` | Tells opencode how to start the MCP server |
| `"-v ...:/work:ro"` | Mounts your C++ project read-only into the container |
| `"docker run -i"` | `-i` is **required** — MCP uses stdin/stdout for JSON-RPC |

> **Tip:** Replace `/path/to/your/cpp/project` with your actual project path. The container only reads your source files; all analysis happens in-memory.

### Step 4: Verify

Open opencode in your C++ project and call the `cpp-bootstrap` tool. If everything is wired correctly:

1. Plugin hooks fire (`session.created` logs appear)
2. MCP tools are available (`clang_ast_load`, `clang_ast_list_functions`, etc.)
3. `cpp-bootstrap` initializes `.cpp_refactory/` workspace

---

## Quick Start

1. Open a C++ project in OpenCode
2. Call `cpp-bootstrap` to initialize `.cpp_refactory/` workspace
3. Call `cpp-scan` to scan the project
4. Follow the 6-phase workflow: Reconnaissance → Seam Discovery → Partition Planning → Refactoring → Verification → Archive

---

## Plugin Tools

These 17 tools are registered by the NPM plugin and available immediately after installation:

| Tool | Description |
|------|-------------|
| `cpp-scan` | Project pre-scan: C++ standard, file hotspots, god functions, #ifdef jungle index |
| `cpp-seam-finder` | Seam discovery via regex heuristics (fallback path, >30% false positive rate) |
| `cpp-bigfile-map` | Large file navigation map: Section Map + Function Index + Cut Points |
| `cpp-verify-tools` | Verify toolchain completeness (clang-tidy, cppcheck, bear, ccache) |
| `cpp-bootstrap` | Initialize cpp_refactory workspace in target project |
| `cpp-characterize` | Characterization test generation helper |
| `cpp-ast-cache` | AST disk cache management (stats/clean/list) |
| `ledger-init` | Initialize three-layer ledger (Wave/Batch/Partition) |
| `ledger-wave-add` | Create Wave (campaign-level goal) |
| `ledger-batch-add` | Create Batch (single-session goal) |
| `ledger-partition-add` | Create Partition (minimum execution unit, ~4h) |
| `ledger-promote` | Advance partition status (PLANNED→IN_PROGRESS→VERIFIED→DONE) |
| `ledger-status` | View current ledger overview |
| `ledger-list` | List all partition details |

## MCP Tools (via Docker)

These tools are provided by the clang-ast-mcp server running in Docker. They require the MCP configuration from Step 3:

| Tool | Description |
|---|---|
| `clang_ast_load` | Pre-warm AST cache for a file |
| `clang_ast_list_functions` | List functions with cyclomatic complexity and line boundaries |
| `clang_ast_globals` | Global variable analysis (SIOF risk detection) |
| `clang_ast_virtual_calls` | Virtual call sites + override candidates |
| `clang_ast_macro_jungle` | Preprocessor complexity report |

---

## Hooks

### session.created
Automatically reads `state/` files and injects them into conversation context. Warns if cpp_refactory is not initialized.

### tool.execute.before
Blocks cpp-refactory tools (except `cpp-bootstrap`) if `.cpp_refactory/` doesn't exist. Warns about open tool gaps.

### shell.env
Injects `CPP_REFACTORY_ROOT`, `CPP_REFACTORY_SCRIPTS`, `CPP_REFACTORY_RESOURCES` into all shell sessions.

---

## Docker Reference

The Docker image supports multiple run modes:

```bash
# MCP server mode (default — used by opencode.json)
docker run --rm -i -v /path/to/project:/work:ro cpp-refactory

# Interactive shell (debugging)
docker run --rm -it -v /path/to/project:/work cpp-refactory shell

# Run test suite
docker run --rm cpp-refactory test --all

# Full sandbox validation
docker run --rm cpp-refactory bash /opt/cpp_refactory/docker/validate-sandbox.sh
```

### Docker Compose

```bash
export CPP_PROJECT_PATH=/path/to/your/cpp/repo

# Start MCP server
docker compose -f docker/docker-compose.yml run --rm -T mcp-server

# Run tests
docker compose -f docker/docker-compose.yml run --rm test

# Interactive shell
docker compose -f docker/docker-compose.yml run --rm shell
```

### Security Isolation (docker-compose.yml)

| Measure | Description |
|---|---|
| `read_only: true` | Read-only root filesystem |
| `no-new-privileges` | Prevent privilege escalation |
| `cap_drop: ALL` | Remove all Linux capabilities |
| `cap_add: DAC_READ_SEARCH` | Only allow reading mounted files |
| `networks: internal` | No external network access |
| `memory: 4G` / `cpus: 4.0` | Resource limits |
| `/work:ro` | Host project mounted read-only |

### What's Inside the Image

| Component | Source | Purpose |
|---|---|---|
| LLVM/Clang 18 | Ubuntu 24.04 apt | C++ compilation + AST analysis |
| libclang-18-dev | Ubuntu 24.04 apt | Python binding for AST |
| clang-tidy / clang-format | Ubuntu 24.04 apt | Static analysis / formatting |
| cppcheck | Ubuntu 24.04 apt | Complementary static analysis |
| bear | Ubuntu 24.04 apt | Generate compile_commands.json |
| **clang-ast-mcp** | This repo (`mcp/`) | MCP server with 5 AST tools |

---

## Optional MCP Servers

The plugin also integrates with these optional MCP servers (configure separately in `opencode.json`):

- **codegraph** — Tree-sitter structural queries (impact analysis, call graph, symbol search)
- **mempalace** — Persistent semantic memory + knowledge graph (cross-session learning)

The plugin degrades gracefully when they're unavailable.

---

## Development

```bash
# Plugin development
npm install
npm test          # 38 tests, node:test + tsx
npm run build     # tsup → dist/index.js
npm run typecheck # tsc --noEmit

# Docker image
docker build -t cpp-refactory -f docker/Dockerfile .
docker run --rm cpp-refactory test --all
```

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
