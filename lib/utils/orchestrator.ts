import path from "node:path"
import { routeAnalysisTool } from "./analysis-router.js"
import { loadPipeline } from "./pipeline.js"
import { loadBaseline, compareWithBaseline, type QualityMetrics, type QualityDelta } from "./quality-gate.js"
import { checkCompileCommands } from "./diagnose.js"

// ─── Types ───────────────────────────────────────────────────────────

export interface ProductStatus {
    projectDir: string
    analysisMode: "ast" | "regex_fallback" | "partial_ast"
    analysisConfidence: number
    pipelineActive: boolean
    pipelineStage: string | null
    pipelineStatus: string | null
    hasBaseline: boolean
    baselineTimestamp: string | null
    environment: {
        compileCommands: string
        compileEntries: number
    }
    advice: string[]
}

export interface AnalysisAdvice {
    mode: "ast" | "regex_fallback" | "partial_ast"
    confidence: number
    recommendedTool: string
    description: string
    warning?: string
    fixSuggestion?: string
}

export interface VerifyReport {
    hasBaseline: boolean
    qualityDelta: QualityDelta
    summary: string
    passed: boolean
}

// ─── Product Status ──────────────────────────────────────────────────

/**
 * Get a unified product status snapshot.
 * Combines: analysis mode + pipeline state + quality baseline + environment.
 * Generates contextual advice based on current state.
 */
export function getProductStatus(projectDir: string): ProductStatus {
    const normalizedDir = path.resolve(projectDir)
    const advice: string[] = []

    // 1. Analysis mode detection (use a representative file or project root)
    const ccCheck = checkCompileCommands(normalizedDir)
    let analysisMode: "ast" | "regex_fallback" | "partial_ast" = "regex_fallback"
    let analysisConfidence = 0.5

    if (ccCheck.status === "valid") {
        analysisMode = "ast"
        analysisConfidence = 1.0
    } else if (ccCheck.status === "path_mismatch" && ccCheck.validPaths > 0) {
        analysisMode = "partial_ast"
        analysisConfidence = ccCheck.validPaths / ccCheck.entryCount
    }

    // 2. Pipeline state
    const pipeline = loadPipeline(normalizedDir)
    const pipelineActive = pipeline !== null && pipeline.status === "active"
    const pipelineStage = pipeline?.currentStage ?? null
    const pipelineStatus = pipeline?.status ?? null

    // 3. Quality baseline
    const baseline = loadBaseline(normalizedDir)
    const hasBaseline = baseline !== null
    const baselineTimestamp = baseline?.timestamp ?? null

    // 4. Generate contextual advice
    if (ccCheck.status === "not_found") {
        advice.push("建议生成 compile_commands.json 以启用 AST 精准分析: bear -- make")
    } else if (ccCheck.status === "path_mismatch") {
        advice.push(`compile_commands.json 有 ${ccCheck.mismatchedPaths} 个路径失效，建议重新生成`)
    }

    if (!pipeline) {
        advice.push("运行 cpp-diagnose 检测环境，然后调用 cpp-bootstrap 初始化项目")
    } else if (pipelineActive) {
        advice.push(`流水线活跃: 当前阶段 ${pipelineStage}`)

        if ((pipelineStage === "execute" || pipelineStage === "verify") && !hasBaseline) {
            advice.push("进入 verify 阶段前建议先运行 cpp-quality-gate baseline 记录质量基线")
        }
        if (pipelineStage === "execute") {
            advice.push("execute 阶段: 使用 cpp-characterize 生成特征化测试骨架，再进行代码改造")
        }
    }

    if (analysisMode === "regex_fallback") {
        advice.push("当前使用正则启发式分析（误报率 >30%），生成 compile_commands.json 可切换到 AST 精准分析")
    }

    return {
        projectDir: normalizedDir,
        analysisMode,
        analysisConfidence,
        pipelineActive,
        pipelineStage,
        pipelineStatus,
        hasBaseline,
        baselineTimestamp,
        environment: {
            compileCommands: ccCheck.status,
            compileEntries: ccCheck.entryCount,
        },
        advice,
    }
}

// ─── Analysis Advice ─────────────────────────────────────────────────

/**
 * Build analysis advice for a specific source file.
 * Combines routing decision with actionable guidance.
 */
export function buildAnalysisAdvice(
    projectDir: string,
    sourceFile: string,
    toolType: string = "seam-finder"
): AnalysisAdvice {
    const routing = routeAnalysisTool(toolType, projectDir, sourceFile)

    const result: AnalysisAdvice = {
        mode: routing.mode,
        confidence: routing.confidence,
        recommendedTool: routing.toolName,
        description: routing.description,
    }

    if (routing.mode === "regex_fallback") {
        result.warning = "正则启发式分析误报率 >30%，结果仅供参考"
        result.fixSuggestion = "生成 compile_commands.json 启用 AST 精准分析: bear -- make"
    } else if (routing.mode === "partial_ast") {
        result.warning = "目标文件不在 compile_commands.json 中，降级为正则分析"
        result.fixSuggestion = "重新生成 compile_commands.json 以覆盖所有源文件"
    }

    return result
}

// ─── Verify Report ───────────────────────────────────────────────────

/**
 * Build a combined verify + quality-gate report.
 * Integrates pipeline verify results with quality baseline comparison.
 */
export function buildVerifyReport(
    projectDir: string,
    currentMetrics: QualityMetrics
): VerifyReport {
    const delta = compareWithBaseline(projectDir, currentMetrics)
    const hasBaseline = delta.hasBaseline

    // Build human-readable summary
    const lines: string[] = []
    lines.push("═══════════════════════════════════════════")
    lines.push("  验证报告 (Verify + Quality Gate)")
    lines.push("═══════════════════════════════════════════")
    lines.push("")

    if (!hasBaseline) {
        lines.push("⚠ 无 baseline 记录，无法进行增量对比")
        lines.push("  建议: 运行 cpp-quality-gate baseline 记录当前质量基线")
        lines.push("")
    } else {
        lines.push(`Baseline 时间: ${delta.baselineTimestamp}`)
        lines.push("")

        // Warnings delta
        lines.push("── 警告增量 ──")
        for (const [tool, d] of Object.entries(delta.warningsDelta)) {
            const icon = d <= 0 ? "✓" : "✗"
            lines.push(`  ${icon} ${tool}: ${d >= 0 ? "+" : ""}${d}`)
        }
        lines.push("")

        // Errors
        if (delta.newErrors > 0) {
            lines.push(`✗ 新增编译错误: +${delta.newErrors}`)
        } else {
            lines.push("✓ 零新增编译错误")
        }

        // Test regressions
        if (delta.testRegressions > 0) {
            lines.push(`✗ 测试回归: +${delta.testRegressions} 新增失败`)
        } else {
            lines.push("✓ 零测试回归")
        }
        lines.push("")
    }

    // Overall verdict
    lines.push("── 门禁判定 ──")
    if (delta.passed) {
        lines.push("  ✓ 增量门禁通过")
    } else {
        lines.push("  ✗ 增量门禁未通过")
        if (delta.details.length > 0) {
            for (const d of delta.details) {
                lines.push(`    ${d}`)
            }
        }
    }
    lines.push("═══════════════════════════════════════════")

    return {
        hasBaseline,
        qualityDelta: delta,
        summary: lines.join("\n"),
        passed: delta.passed,
    }
}
