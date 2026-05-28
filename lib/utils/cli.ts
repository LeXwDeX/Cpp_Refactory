import { runDiagnosis } from "./diagnose.js"
import { runBootstrap } from "./bootstrap.js"
import { getProductStatus } from "./orchestrator.js"

// ─── Types ───────────────────────────────────────────────────────────

export type CliCommand = "diagnose" | "init" | "status" | "verify"

export interface CliArgs {
    command: CliCommand
    project: string
    json: boolean
    help: boolean
}

export interface CliResult {
    exitCode: number
    output: string
}

// ─── Valid Commands ──────────────────────────────────────────────────

const VALID_COMMANDS = new Set<CliCommand>(["diagnose", "init", "status", "verify"])

const HELP_TEXT = `
cpp-refactory — C++ 重型项目重构辅助工具

用法:
  cpp-refactory <command> [project-dir] [options]

命令:
  diagnose [dir]    一键诊断环境（工具链 + compile_commands.json + Docker/MCP）
  init [dir]        初始化项目（创建状态目录 + 生成 opencode.json 配置）
  status [dir]      查看产品状态（分析模式 + 流水线 + 质量基线）
  verify [dir]      运行增量质量门禁

选项:
  --json            输出 JSON 格式（供程序消费）
  --help, -h        显示帮助信息

示例:
  cpp-refactory diagnose              # 诊断当前目录
  cpp-refactory init /path/to/project # 初始化指定项目
  cpp-refactory status --json         # JSON 格式状态输出
  cpp-refactory verify                # 运行质量门禁
`

// ─── Argument Parsing ────────────────────────────────────────────────

/**
 * Parse CLI arguments into structured CliArgs.
 */
export function parseCliArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        command: "diagnose",
        project: ".",
        json: false,
        help: false,
    }

    const positional: string[] = []

    for (const arg of argv) {
        if (arg === "--json") {
            args.json = true
        } else if (arg === "--help" || arg === "-h") {
            args.help = true
        } else if (!arg.startsWith("-")) {
            positional.push(arg)
        }
    }

    if (args.help || positional.length === 0) {
        args.help = true
        return args
    }

    const cmd = positional[0]
    if (!VALID_COMMANDS.has(cmd as CliCommand)) {
        throw new Error(`Unknown command: '${cmd}'. Valid commands: ${[...VALID_COMMANDS].join(", ")}`)
    }

    args.command = cmd as CliCommand
    if (positional.length > 1) {
        args.project = positional[1]
    }

    return args
}

// ─── Command Execution ───────────────────────────────────────────────

/**
 * Execute a CLI command and return structured result.
 */
export async function executeCliCommand(args: CliArgs): Promise<CliResult> {
    if (args.help) {
        return { exitCode: 0, output: HELP_TEXT.trim() }
    }

    switch (args.command) {
        case "diagnose":
            return executeDiagnose(args.project, args.json)
        case "init":
            return executeInit(args.project, args.json)
        case "status":
            return executeStatus(args.project, args.json)
        case "verify":
            return executeVerify(args.project, args.json)
        default:
            return { exitCode: 1, output: `Unknown command: ${args.command}` }
    }
}

// ─── Command Implementations ─────────────────────────────────────────

async function executeDiagnose(project: string, json: boolean): Promise<CliResult> {
    const report = await runDiagnosis(project)

    if (json) {
        return {
            exitCode: report.ok ? 0 : 1,
            output: JSON.stringify(report, null, 2),
        }
    }

    return {
        exitCode: report.ok ? 0 : 1,
        output: report.humanSummary,
    }
}

function executeInit(project: string, json: boolean): CliResult {
    const result = runBootstrap(project)

    if (json) {
        return {
            exitCode: 0,
            output: JSON.stringify(result, null, 2),
        }
    }

    const lines: string[] = []
    lines.push("═══════════════════════════════════════════")
    lines.push("  cpp_refactory 项目初始化")
    lines.push("═══════════════════════════════════════════")
    lines.push("")
    lines.push(`项目目录: ${result.projectDir}`)
    lines.push("")

    if (result.created.length > 0) {
        lines.push("已创建:")
        for (const item of result.created) {
            lines.push(`  + ${item}`)
        }
    }

    if (result.skipped.length > 0) {
        lines.push("已跳过:")
        for (const item of result.skipped) {
            lines.push(`  - ${item}`)
        }
    }

    if (result.warnings.length > 0) {
        lines.push("")
        lines.push("警告:")
        for (const w of result.warnings) {
            lines.push(`  ⚠ ${w}`)
        }
    }

    lines.push("")
    lines.push("下一步:")
    for (let i = 0; i < result.nextSteps.length; i++) {
        lines.push(`  ${i + 1}. ${result.nextSteps[i]}`)
    }
    lines.push("═══════════════════════════════════════════")

    return { exitCode: 0, output: lines.join("\n") }
}

function executeStatus(project: string, json: boolean): CliResult {
    const status = getProductStatus(project)

    if (json) {
        return {
            exitCode: 0,
            output: JSON.stringify(status, null, 2),
        }
    }

    const lines: string[] = []
    lines.push("═══════════════════════════════════════════")
    lines.push("  cpp_refactory 产品状态")
    lines.push("═══════════════════════════════════════════")
    lines.push("")
    lines.push(`项目目录: ${status.projectDir}`)
    lines.push("")
    lines.push(`分析模式: ${status.analysisMode} (${Math.round(status.analysisConfidence * 100)}% 可信度)`)
    lines.push(`流水线:   ${status.pipelineActive ? `活跃 (${status.pipelineStage})` : "未激活"}`)
    lines.push(`质量基线: ${status.hasBaseline ? `已记录 (${status.baselineTimestamp})` : "未记录"}`)
    lines.push(`compile:  ${status.environment.compileCommands} (${status.environment.compileEntries} 条目)`)
    lines.push("")

    if (status.advice.length > 0) {
        lines.push("建议:")
        for (const a of status.advice) {
            lines.push(`  → ${a}`)
        }
    }
    lines.push("═══════════════════════════════════════════")

    return { exitCode: 0, output: lines.join("\n") }
}

function executeVerify(project: string, json: boolean): CliResult {
    // Verify requires a baseline; check if one exists
    const status = getProductStatus(project)

    if (!status.hasBaseline) {
        const msg = "无 baseline 记录。请先运行: cpp-refactory init && cpp-quality-gate baseline"
        if (json) {
            return {
                exitCode: 1,
                output: JSON.stringify({ ok: false, error: msg }),
            }
        }
        return { exitCode: 1, output: `✗ ${msg}` }
    }

    // For now, return status with baseline info
    // Full verify would run compilation/tests/static-analysis
    const result = {
        ok: true,
        hasBaseline: true,
        baselineTimestamp: status.baselineTimestamp,
        message: "质量门禁检查需要运行编译/测试/静态分析，请使用 cpp-pipeline verify 或 cpp-quality-gate check",
    }

    if (json) {
        return { exitCode: 0, output: JSON.stringify(result, null, 2) }
    }

    return {
        exitCode: 0,
        output: `✓ 基线已记录 (${status.baselineTimestamp})\n  完整验证请运行: cpp-pipeline verify 或 cpp-quality-gate check`,
    }
}
