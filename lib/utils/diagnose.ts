import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs"
import path from "node:path"

const execFileAsync = promisify(execFile)

// ─── Types ───────────────────────────────────────────────────────────

export interface ToolCheckResult {
    name: string
    available: boolean
    path: string | null
    version?: string
}

export type CompileCommandsStatus =
    | "valid"
    | "not_found"
    | "invalid_json"
    | "empty"
    | "path_mismatch"

export interface CompileCommandsCheck {
    status: CompileCommandsStatus
    filePath: string | null
    entryCount: number
    mismatchedPaths: number
    validPaths: number
    suggestions: string[]
}

export interface DiagnosisSummary {
    totalChecks: number
    passed: number
    failed: number
    warnings: number
}

export interface DiagnosisReport {
    timestamp: string
    projectDir: string
    tools: ToolCheckResult[]
    compileCommands: CompileCommandsCheck
    ok: boolean
    summary: DiagnosisSummary
    humanSummary: string
}

// ─── Tool Availability ───────────────────────────────────────────────

/**
 * Check if a command-line tool is available in PATH.
 * Returns structured result with path and version info.
 */
export async function checkToolAvailability(
    name: string
): Promise<ToolCheckResult> {
    try {
        const { stdout } = await execFileAsync("which", [name], {
            timeout: 5000,
        })
        const toolPath = stdout.trim()
        if (!toolPath) {
            return { name, available: false, path: null }
        }

        // Try to get version
        let version: string | undefined
        try {
            const { stdout: versionOut } = await execFileAsync(
                name,
                ["--version"],
                { timeout: 5000 }
            )
            version = versionOut.trim().split("\n")[0]
        } catch {
            // Version flag not supported or failed, that's fine
        }

        return { name, available: true, path: toolPath, version }
    } catch {
        return { name, available: false, path: null }
    }
}

// ─── Compile Commands Validation ─────────────────────────────────────

/**
 * Validate compile_commands.json in a project directory.
 * Checks existence, JSON validity, path correctness, and provides fix suggestions.
 */
export function checkCompileCommands(projectDir: string): CompileCommandsCheck {
    const filePath = path.join(projectDir, "compile_commands.json")

    // Check existence
    if (!fs.existsSync(filePath)) {
        return {
            status: "not_found",
            filePath: null,
            entryCount: 0,
            mismatchedPaths: 0,
            validPaths: 0,
            suggestions: [
                "生成 compile_commands.json:",
                "  bear -- make",
                "  bear -- cmake --build build/",
                "  或手动创建（参考 https://clang.llvm.org/docs/JSONCompilationDatabase.html）",
            ],
        }
    }

    // Read and parse JSON
    let entries: any[]
    try {
        const content = fs.readFileSync(filePath, "utf-8")
        entries = JSON.parse(content)
    } catch {
        return {
            status: "invalid_json",
            filePath,
            entryCount: 0,
            mismatchedPaths: 0,
            validPaths: 0,
            suggestions: [
                "compile_commands.json 格式无效（非合法 JSON）",
                "请重新生成: bear -- make 或 bear -- cmake --build build/",
            ],
        }
    }

    // Check empty
    if (!Array.isArray(entries) || entries.length === 0) {
        return {
            status: "empty",
            filePath,
            entryCount: 0,
            mismatchedPaths: 0,
            validPaths: 0,
            suggestions: [
                "compile_commands.json 为空数组",
                "请确保 bear 捕获了编译命令: bear -- make",
            ],
        }
    }

    // Validate paths
    let mismatchedPaths = 0
    let validPaths = 0

    for (const entry of entries) {
        const dir = entry.directory || ""
        const file = entry.file || ""
        const fullPath = path.isAbsolute(file)
            ? file
            : path.resolve(dir, file)

        if (fs.existsSync(fullPath)) {
            validPaths++
        } else {
            mismatchedPaths++
        }
    }

    // Determine status
    if (mismatchedPaths > 0 && validPaths === 0) {
        return {
            status: "path_mismatch",
            filePath,
            entryCount: entries.length,
            mismatchedPaths,
            validPaths,
            suggestions: [
                `所有 ${mismatchedPaths} 个路径均无效`,
                "可能原因: compile_commands.json 在其他机器/容器中生成",
                "修复方案:",
                "  1. 在当前环境重新生成: bear -- make",
                "  2. 使用 sed 替换路径前缀",
                "  3. 使用 cpp-diagnose --fix-paths 自动修复（开发中）",
            ],
        }
    }

    if (mismatchedPaths > 0) {
        return {
            status: "path_mismatch",
            filePath,
            entryCount: entries.length,
            mismatchedPaths,
            validPaths,
            suggestions: [
                `${mismatchedPaths}/${entries.length} 个路径无效，${validPaths} 个有效`,
                "部分文件可能无法进行 AST 分析",
                "建议在当前环境重新生成 compile_commands.json",
            ],
        }
    }

    return {
        status: "valid",
        filePath,
        entryCount: entries.length,
        mismatchedPaths: 0,
        validPaths,
        suggestions: [],
    }
}

// ─── Full Diagnosis ──────────────────────────────────────────────────

// Critical tools that must be present
const CRITICAL_TOOLS = ["clang-tidy", "cppcheck", "bear"]

// Optional tools that are nice to have
const OPTIONAL_TOOLS = [
    "clang-format",
    "rg",
    "cmake",
    "ccache",
    "clangd",
]

/**
 * Run a complete diagnosis of the cpp_refactory environment.
 * Returns a structured report with tool availability, compile_commands status,
 * and actionable suggestions.
 */
export async function runDiagnosis(projectDir: string): Promise<DiagnosisReport> {
    const normalizedDir = path.resolve(projectDir)

    // Check all tools in parallel
    const allToolNames = [...CRITICAL_TOOLS, ...OPTIONAL_TOOLS]
    const toolChecks = await Promise.all(
        allToolNames.map(checkToolAvailability)
    )

    // Check compile_commands.json
    const compileCommands = checkCompileCommands(normalizedDir)

    // Calculate summary
    let passed = 0
    let failed = 0
    let warnings = 0

    for (const tool of toolChecks) {
        if (tool.available) {
            passed++
        } else if (CRITICAL_TOOLS.includes(tool.name)) {
            failed++
        } else {
            warnings++
        }
    }

    // compile_commands check
    const totalChecks = toolChecks.length + 1
    if (compileCommands.status === "valid") {
        passed++
    } else if (compileCommands.status === "not_found") {
        warnings++
    } else {
        failed++
    }

    const ok = failed === 0

    // Build human-readable summary
    const lines: string[] = []
    lines.push("═══════════════════════════════════════════")
    lines.push("  cpp_refactory 环境诊断报告")
    lines.push("═══════════════════════════════════════════")
    lines.push("")
    lines.push(`项目目录: ${normalizedDir}`)
    lines.push(`检测时间: ${new Date().toISOString()}`)
    lines.push("")

    lines.push("── 工具链 ──")
    for (const tool of toolChecks) {
        const isCritical = CRITICAL_TOOLS.includes(tool.name)
        const icon = tool.available ? "✓" : isCritical ? "✗" : "⚠"
        const tag = isCritical ? "[必需]" : "[可选]"
        const ver = tool.version ? ` (${tool.version})` : ""
        lines.push(`  ${icon} ${tag} ${tool.name}${ver}`)
    }
    lines.push("")

    lines.push("── compile_commands.json ──")
    const ccIcon =
        compileCommands.status === "valid"
            ? "✓"
            : compileCommands.status === "not_found"
              ? "⚠"
              : "✗"
    lines.push(`  ${ccIcon} 状态: ${compileCommands.status}`)
    if (compileCommands.entryCount > 0) {
        lines.push(`    条目数: ${compileCommands.entryCount}`)
        lines.push(
            `    有效路径: ${compileCommands.validPaths}, 无效路径: ${compileCommands.mismatchedPaths}`
        )
    }
    if (compileCommands.suggestions.length > 0) {
        lines.push("    建议:")
        for (const s of compileCommands.suggestions) {
            lines.push(`      ${s}`)
        }
    }
    lines.push("")

    lines.push("── 总结 ──")
    lines.push(
        `  通过: ${passed}  失败: ${failed}  警告: ${warnings}  总计: ${totalChecks}`
    )
    lines.push(`  整体状态: ${ok ? "✓ 就绪" : "✗ 需要修复"}`)
    lines.push("═══════════════════════════════════════════")

    return {
        timestamp: new Date().toISOString(),
        projectDir: normalizedDir,
        tools: toolChecks,
        compileCommands,
        ok,
        summary: { totalChecks, passed, failed, warnings },
        humanSummary: lines.join("\n"),
    }
}
