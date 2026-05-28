import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

// ─── Types ───────────────────────────────────────────────────────────

export type ComponentStatusType = "ok" | "missing" | "misconfigured" | "degraded"

export interface ComponentStatus {
    component: string
    status: ComponentStatusType
    required: boolean
    details: string
    suggestions: string[]
}

export interface ConfigValidationResult {
    projectDir: string
    components: ComponentStatus[]
    ok: boolean
    summary: string
}

// ─── MCP Configuration Check ─────────────────────────────────────────

/**
 * Check if opencode.json has valid MCP configuration for clang-ast-mcp.
 */
export function checkMcpConfig(projectDir: string): ComponentStatus {
    const configPath = path.join(projectDir, "opencode.json")

    if (!fs.existsSync(configPath)) {
        return {
            component: "clang-ast-mcp",
            status: "missing",
            required: true,
            details: "opencode.json 不存在",
            suggestions: [
                "创建 opencode.json 并添加 MCP 配置:",
                JSON.stringify(
                    {
                        mcp: {
                            "clang-ast-mcp": {
                                command: "docker",
                                args: [
                                    "run",
                                    "--rm",
                                    "-i",
                                    "-v",
                                    "${PWD}:/work",
                                    "cpp-refactory",
                                ],
                            },
                        },
                    },
                    null,
                    2
                ),
            ],
        }
    }

    try {
        const content = fs.readFileSync(configPath, "utf-8")
        const config = JSON.parse(content)

        if (!config.mcp) {
            return {
                component: "clang-ast-mcp",
                status: "misconfigured",
                required: true,
                details: "opencode.json 缺少 mcp 配置段",
                suggestions: [
                    "在 opencode.json 中添加 mcp 配置:",
                    '"mcp": { "clang-ast-mcp": { "command": "docker", "args": ["run", "--rm", "-i", "cpp-refactory"] } }',
                ],
            }
        }

        if (!config.mcp["clang-ast-mcp"]) {
            return {
                component: "clang-ast-mcp",
                status: "misconfigured",
                required: true,
                details: "opencode.json 的 mcp 配置中缺少 clang-ast-mcp",
                suggestions: [
                    "在 mcp 配置中添加 clang-ast-mcp:",
                    '"clang-ast-mcp": { "command": "docker", "args": ["run", "--rm", "-i", "cpp-refactory"] }',
                ],
            }
        }

        return {
            component: "clang-ast-mcp",
            status: "ok",
            required: true,
            details: "MCP 配置正确",
            suggestions: [],
        }
    } catch {
        return {
            component: "clang-ast-mcp",
            status: "misconfigured",
            required: true,
            details: "opencode.json 格式无效（非合法 JSON）",
            suggestions: ["请检查 opencode.json 的 JSON 格式"],
        }
    }
}

// ─── Docker Availability Check ───────────────────────────────────────

/**
 * Check if Docker is available and running.
 * Docker is optional — the plugin can work without it (host mode).
 */
export async function checkDockerAvailability(): Promise<ComponentStatus> {
    try {
        const { stdout } = await execFileAsync("docker", ["--version"], {
            timeout: 5000,
        })
        const version = stdout.trim().split("\n")[0]

        // Check if daemon is running
        try {
            await execFileAsync("docker", ["info"], { timeout: 5000 })
            return {
                component: "docker",
                status: "ok",
                required: false,
                details: `Docker 可用: ${version}`,
                suggestions: [],
            }
        } catch {
            return {
                component: "docker",
                status: "degraded",
                required: false,
                details: `Docker 已安装 (${version}) 但 daemon 未运行`,
                suggestions: ["启动 Docker daemon: sudo systemctl start docker"],
            }
        }
    } catch {
        return {
            component: "docker",
            status: "missing",
            required: false,
            details: "Docker 未安装",
            suggestions: [
                "Docker 可选，用于沙盒模式",
                "安装: https://docs.docker.com/get-docker/",
                "不使用 Docker 时，工具在宿主环境直接运行",
            ],
        }
    }
}

// ─── Plugin Registration Check ───────────────────────────────────────

function checkPluginConfig(projectDir: string): ComponentStatus {
    const configPath = path.join(projectDir, "opencode.json")

    if (!fs.existsSync(configPath)) {
        return {
            component: "opencode-cpp-refactory",
            status: "missing",
            required: true,
            details: "opencode.json 不存在",
            suggestions: [
                "安装插件: npm install -g opencode-cpp-refactory",
                "在 opencode.json 中注册: { \"plugins\": [\"opencode-cpp-refactory\"] }",
            ],
        }
    }

    try {
        const content = fs.readFileSync(configPath, "utf-8")
        const config = JSON.parse(content)

        if (
            config.plugins &&
            Array.isArray(config.plugins) &&
            config.plugins.includes("opencode-cpp-refactory")
        ) {
            return {
                component: "opencode-cpp-refactory",
                status: "ok",
                required: true,
                details: "插件已注册",
                suggestions: [],
            }
        }

        return {
            component: "opencode-cpp-refactory",
            status: "misconfigured",
            required: true,
            details: "opencode.json 中未注册 opencode-cpp-refactory 插件",
            suggestions: [
                '在 opencode.json 中添加: { "plugins": ["opencode-cpp-refactory"] }',
            ],
        }
    } catch {
        return {
            component: "opencode-cpp-refactory",
            status: "misconfigured",
            required: true,
            details: "opencode.json 格式无效",
            suggestions: ["请检查 opencode.json 的 JSON 格式"],
        }
    }
}

// ─── Compile Commands Check ──────────────────────────────────────────

function checkCompileCommandsConfig(projectDir: string): ComponentStatus {
    const ccPath = path.join(projectDir, "compile_commands.json")

    if (!fs.existsSync(ccPath)) {
        return {
            component: "compile_commands.json",
            status: "missing",
            required: false,
            details: "compile_commands.json 不存在（AST 分析将降级为正则）",
            suggestions: [
                "生成 compile_commands.json:",
                "  bear -- make",
                "  bear -- cmake --build build/",
            ],
        }
    }

    try {
        const content = fs.readFileSync(ccPath, "utf-8")
        const entries = JSON.parse(content)

        if (!Array.isArray(entries) || entries.length === 0) {
            return {
                component: "compile_commands.json",
                status: "degraded",
                required: false,
                details: "compile_commands.json 存在但为空",
                suggestions: ["请确保 bear 捕获了编译命令"],
            }
        }

        return {
            component: "compile_commands.json",
            status: "ok",
            required: false,
            details: `compile_commands.json 有效 (${entries.length} 条目)`,
            suggestions: [],
        }
    } catch {
        return {
            component: "compile_commands.json",
            status: "misconfigured",
            required: false,
            details: "compile_commands.json 格式无效",
            suggestions: ["重新生成: bear -- make"],
        }
    }
}

// ─── Full Validation ─────────────────────────────────────────────────

/**
 * Validate the complete cpp_refactory configuration.
 * Checks all components and generates actionable fix suggestions.
 */
export async function validateConfig(
    projectDir: string
): Promise<ConfigValidationResult> {
    const normalizedDir = path.resolve(projectDir)

    // Run all checks in parallel
    const [mcpResult, dockerResult, pluginResult, compileResult] =
        await Promise.all([
            Promise.resolve(checkMcpConfig(normalizedDir)),
            checkDockerAvailability(),
            Promise.resolve(checkPluginConfig(normalizedDir)),
            Promise.resolve(checkCompileCommandsConfig(normalizedDir)),
        ])

    const components = [pluginResult, mcpResult, dockerResult, compileResult]

    // Determine overall status
    const failedRequired = components.filter(
        (c) => c.required && (c.status === "missing" || c.status === "misconfigured")
    )
    const ok = failedRequired.length === 0

    // Build summary
    const lines: string[] = []
    lines.push("═══════════════════════════════════════════")
    lines.push("  cpp_refactory 配置验证报告")
    lines.push("═══════════════════════════════════════════")
    lines.push("")
    lines.push(`项目目录: ${normalizedDir}`)
    lines.push("")

    lines.push("── 组件状态 ──")
    for (const c of components) {
        const icon =
            c.status === "ok"
                ? "✓"
                : c.status === "degraded"
                  ? "⚠"
                  : c.required
                    ? "✗"
                    : "⚠"
        const tag = c.required ? "[必需]" : "[可选]"
        lines.push(`  ${icon} ${tag} ${c.component}: ${c.details}`)
        if (c.suggestions.length > 0) {
            for (const s of c.suggestions) {
                lines.push(`      → ${s}`)
            }
        }
    }
    lines.push("")

    lines.push("── 总结 ──")
    const okCount = components.filter((c) => c.status === "ok").length
    const warnCount = components.filter(
        (c) => c.status === "degraded" || (!c.required && c.status !== "ok")
    ).length
    const failCount = failedRequired.length

    lines.push(
        `  通过: ${okCount}  警告: ${warnCount}  失败: ${failCount}  总计: ${components.length}`
    )
    lines.push(`  整体状态: ${ok ? "✓ 配置就绪" : "✗ 需要修复"}`)
    lines.push("═══════════════════════════════════════════")

    return {
        projectDir: normalizedDir,
        components,
        ok,
        summary: lines.join("\n"),
    }
}
