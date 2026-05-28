import fs from "node:fs"
import path from "node:path"

// ─── Types ───────────────────────────────────────────────────────────

export interface BootstrapResult {
    projectDir: string
    created: string[]
    skipped: string[]
    warnings: string[]
    nextSteps: string[]
}

interface OpenCodeConfig {
    plugins?: string[]
    mcp?: Record<string, { command: string; args: string[] }>
    [key: string]: any
}

const CPP_REFACTORY_PLUGIN = "opencode-cpp-refactory"
const HINDSIGHT_PLUGIN = "@vectorize-io/opencode-hindsight"

// ─── OpenCode Config Generation ──────────────────────────────────────

/**
 * Generate or merge opencode.json configuration.
 * Preserves existing settings, adds cpp-refactory/Hindsight plugins and MCP config.
 */
export function generateOpenCodeConfig(projectDir: string): OpenCodeConfig {
    const configPath = path.join(projectDir, "opencode.json")
    let config: OpenCodeConfig = {}

    // Load existing config if present
    if (fs.existsSync(configPath)) {
        try {
            config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
        } catch {
            config = {}
        }
    }

    // Ensure plugins array exists and includes cpp-refactory + Hindsight memory
    if (!config.plugins) {
        config.plugins = []
    }
    for (const plugin of [CPP_REFACTORY_PLUGIN, HINDSIGHT_PLUGIN]) {
        if (!config.plugins.includes(plugin)) {
            config.plugins.push(plugin)
        }
    }

    // Ensure MCP config exists for clang-ast-mcp (don't overwrite existing)
    if (!config.mcp) {
        config.mcp = {}
    }
    if (!config.mcp["clang-ast-mcp"]) {
        config.mcp["clang-ast-mcp"] = {
            command: "docker",
            args: [
                "run", "--rm", "-i",
                "-v", "${PWD}:/work",
                "cpp-refactory",
            ],
        }
    }

    return config
}

// ─── Bootstrap ───────────────────────────────────────────────────────

/**
 * Run enhanced bootstrap: initialize project for cpp_refactory.
 *
 * Creates:
 *   - .cpp_refactory/state/ directory
 *   - opencode.json (with cpp-refactory + Hindsight plugins and MCP config)
 *   - State template files (if resources available)
 *
 * Returns structured result with created/skipped/warnings/nextSteps.
 */
export function runBootstrap(projectDir: string): BootstrapResult {
    const normalizedDir = path.resolve(projectDir)
    const created: string[] = []
    const skipped: string[] = []
    const warnings: string[] = []
    const nextSteps: string[] = []

    // 1. Create .cpp_refactory/state/ directory
    const cppRefactoryDir = path.join(normalizedDir, ".cpp_refactory")
    const stateDir = path.join(cppRefactoryDir, "state")

    if (!fs.existsSync(stateDir)) {
        fs.mkdirSync(stateDir, { recursive: true })
        created.push("state/")
    } else {
        skipped.push("state/ (已存在)")
    }

    // 2. Generate opencode.json
    const configPath = path.join(normalizedDir, "opencode.json")
    const configExisted = fs.existsSync(configPath)
    const config = generateOpenCodeConfig(normalizedDir)
    const serialized = JSON.stringify(config, null, 2)

    // Only write if content actually changed (avoid unnecessary mtime updates)
    let configChanged = true
    if (configExisted) {
        try {
            const existing = fs.readFileSync(configPath, "utf-8")
            configChanged = existing !== serialized
        } catch {
            // If we can't read, just overwrite
        }
    }
    if (configChanged) {
        fs.writeFileSync(configPath, serialized, "utf-8")
    }

    if (configExisted) {
        if (configChanged) {
            skipped.push("opencode.json (已存在，已合并新配置)")
        } else {
            skipped.push("opencode.json (已存在，配置无变化)")
        }
    } else {
        created.push("opencode.json")
    }

    // 3. Check compile_commands.json
    const ccPath = path.join(normalizedDir, "compile_commands.json")
    if (!fs.existsSync(ccPath)) {
        warnings.push("compile_commands.json 不存在 — AST 分析将降级为正则启发式")
        nextSteps.push("生成 compile_commands.json: bear -- make 或 bear -- cmake --build build/")
    } else {
        // Validate it
        try {
            const entries = JSON.parse(fs.readFileSync(ccPath, "utf-8"))
            if (Array.isArray(entries) && entries.length > 0) {
                skipped.push(`compile_commands.json (已存在, ${entries.length} 条目)`)
            } else {
                warnings.push("compile_commands.json 存在但为空")
                nextSteps.push("重新生成 compile_commands.json: bear -- make")
            }
        } catch {
            warnings.push("compile_commands.json 格式无效")
            nextSteps.push("重新生成 compile_commands.json: bear -- make")
        }
    }

    // 4. Standard next steps
    nextSteps.push("运行 cpp-diagnose 检测完整环境状态")
    nextSteps.push("运行 cpp-scan 扫描项目结构")
    nextSteps.push("配置 HINDSIGHT_API_URL 以启用 @vectorize-io/opencode-hindsight 记忆插件")
    nextSteps.push("使用 cpp-pipeline 启动重构流水线")

    return {
        projectDir: normalizedDir,
        created,
        skipped,
        warnings,
        nextSteps,
    }
}
