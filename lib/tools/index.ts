import { resolveScriptPath } from "../utils/paths.js"

/**
 * Minimal tool definition interface compatible with @opencode-ai/plugin.
 * We define our own to avoid importing the full plugin package in tests.
 */
export interface ToolDefinition {
    description: string
    args: Record<string, any>
    execute: (args: any, context?: any) => Promise<string>
}

/**
 * Create a shell script tool definition.
 */
function shellTool(
    scriptName: string,
    description: string,
    args: Record<string, any>,
    buildArgs: (args: any, projectDir: string) => string[]
): ToolDefinition {
    return {
        description,
        args,
        async execute(toolArgs: any, context?: any) {
            const scriptPath = resolveScriptPath(scriptName)
            const cmdArgs = buildArgs(toolArgs, context?.directory ?? "")
            const { execFile } = await import("node:child_process")
            const { promisify } = await import("node:util")
            const execFileAsync = promisify(execFile)
            try {
                const { stdout, stderr } = await execFileAsync("bash", [scriptPath, ...cmdArgs], {
                    maxBuffer: 10 * 1024 * 1024,
                    timeout: 300_000,
                })
                return stdout + (stderr ? `\n[stderr] ${stderr}` : "")
            } catch (err: any) {
                const stdout = err.stdout ?? ""
                const stderr = err.stderr ?? ""
                const exitCode = err.code ?? "unknown"
                if (stdout) {
                    return stdout + (stderr ? `\n[stderr] ${stderr}` : "") + `\n[exit code: ${exitCode}]`
                }
                return `[ERROR] Command failed with exit code ${exitCode}\n${stderr}`
            }
        },
    }
}

// Zod-like schema helpers (lightweight, no zod dependency needed)
const schema = {
    string: () => ({ type: "string" as const, _def: { typeName: "ZodString" } }),
    boolean: () => ({ type: "boolean" as const, _def: { typeName: "ZodBoolean" } }),
    optional: (s: any) => ({ ...s, optional: true }),
}

/**
 * Create all cpp_refactory tool definitions.
 */
export function createTools(projectDir: string): Record<string, ToolDefinition> {
    return {
        "cpp-scan": shellTool(
            "cpp-scan.sh",
            "C++ 项目预扫描：检测 C++ 标准版本、文件行数热点、include 依赖、上帝函数、#ifdef 丛林指数",
            { target: schema.string() },
            (args) => [args.target]
        ),

        "cpp-seam-finder": shellTool(
            "cpp-seam-finder.sh",
            "C++ 接缝发现：基于正则启发式识别全局变量、宏丛林、裸指针等接缝（降级路径，误报率 >30%）",
            { target: schema.string() },
            (args) => [args.target]
        ),

        "cpp-bigfile-map": shellTool(
            "cpp-bigfile-map.sh",
            "大文件分块导航地图：生成 Section Map + Function Index + God Functions + Cut Points",
            { file: schema.string() },
            (args) => [args.file]
        ),

        "cpp-verify-tools": shellTool(
            "verify-tools.sh",
            "验证 cpp_refactory 工具链完整性（clang-tidy, cppcheck, bear, ccache 等）",
            { project: schema.optional(schema.string()) },
            (args, dir) => [args.project || dir]
        ),

        "cpp-bootstrap": shellTool(
            "bootstrap-project.sh",
            "初始化目标 C++ 项目的 cpp_refactory 工作区（创建 state/ 三件套 + 扫描报告）",
            { project: schema.optional(schema.string()) },
            (args, dir) => [args.project || dir]
        ),

        "cpp-characterize": shellTool(
            "characterize.sh",
            "特征化测试生成辅助：为指定文件/函数生成 gtest 特征化测试骨架",
            { target: schema.string() },
            (args) => [args.target]
        ),

        "cpp-ast-cache": shellTool(
            "clang-ast-cache.sh",
            "AST 磁盘缓存管理：stats（查看）/ clean（清理）/ list（列出）",
            { action: schema.string() },
            (args) => [args.action]
        ),

        // Ledger tools (multi-export)
        "ledger-init": shellTool(
            "ledger.sh",
            "初始化三层台账（Wave/Batch/Partition）",
            {},
            () => ["init"]
        ),

        "ledger-wave-add": shellTool(
            "ledger.sh",
            "创建 Wave（战役级目标）",
            { description: schema.string() },
            (args) => ["wave-add", args.description]
        ),

        "ledger-batch-add": shellTool(
            "ledger.sh",
            "创建 Batch（单会话目标），隶属于指定 Wave",
            { waveId: schema.string(), description: schema.string() },
            (args) => ["batch-add", args.waveId, args.description]
        ),

        "ledger-partition-add": shellTool(
            "ledger.sh",
            "创建 Partition（最小执行单元，~4h），隶属于指定 Batch",
            {
                batchId: schema.string(),
                description: schema.string(),
                risk: schema.string(),
            },
            (args) => ["partition-add", args.batchId, args.description, args.risk]
        ),

        "ledger-promote": shellTool(
            "ledger.sh",
            "推进分区状态（PLANNED→IN_PROGRESS→VERIFIED→DONE）",
            { id: schema.string(), status: schema.string() },
            (args) => ["promote", args.id, args.status]
        ),

        "ledger-status": shellTool(
            "ledger.sh",
            "查看当前台账状态概览",
            {},
            () => ["status"]
        ),

        "ledger-list": shellTool(
            "ledger.sh",
            "列出所有分区详情",
            {},
            () => ["list"]
        ),

        "cpp-diagnose": shellTool(
            "diagnose.sh",
            "一键诊断 cpp_refactory 环境：检测工具链、compile_commands.json、Docker/MCP 连通性，生成结构化诊断报告",
            { project: schema.optional(schema.string()) },
            (args, dir) => [args.project || dir]
        ),

        "cpp-pipeline": shellTool(
            "pipeline-verify.sh",
            "重构流水线验证阶段：编译/测试/静态分析验证，返回结构化结果供流水线状态机消费",
            {
                project: schema.optional(schema.string()),
                stage: schema.optional(schema.string()),
            },
            (args, dir) => [args.project || dir, args.stage || "verify"]
        ),

        "cpp-quality-gate": shellTool(
            "quality-gate.sh",
            "增量质量门禁：记录 baseline、对比变更后的警告/错误/测试增量，支持自定义阈值",
            {
                action: schema.string(),
                project: schema.optional(schema.string()),
            },
            (args, dir) => [args.action, args.project || dir]
        ),
    }
}
