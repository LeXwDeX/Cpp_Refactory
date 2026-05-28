import fs from "node:fs"
import path from "node:path"

// ─── Types ───────────────────────────────────────────────────────────

export type AnalysisMode = "ast" | "regex_fallback" | "partial_ast"

export interface AnalysisModeResult {
    mode: AnalysisMode
    confidence: number
    reason?: string
    missingFiles?: string[]
    compileDbPath?: string
    totalEntries?: number
    validEntries?: number
}

export interface RoutingDecision {
    /** The tool to use (AST or regex) */
    toolName: string
    /** Analysis mode */
    mode: AnalysisMode
    /** Confidence score 0-1 */
    confidence: number
    /** Human-readable description of the routing decision */
    description: string
    /** List of enhanced tools available in AST mode */
    enhancedTools: string[]
    /** Fallback chain: tools to try if primary fails */
    fallbackChain: string[]
    /** Reason for fallback (if applicable) */
    fallbackReason?: string
}

// ─── Tool Mapping ────────────────────────────────────────────────────

/**
 * Maps regex-based tool names to their AST equivalents.
 */
const AST_TOOL_MAP: Record<string, string> = {
    "seam-finder": "clang_ast_globals",
    "scan": "clang_ast_list_functions",
    "macro-jungle": "clang_ast_macro_jungle",
    "virtual-calls": "clang_ast_virtual_calls",
    "list-functions": "clang_ast_list_functions",
}

/**
 * Regex-based fallback tool names.
 */
const REGEX_TOOL_MAP: Record<string, string> = {
    "seam-finder": "cpp-seam-finder",
    "scan": "cpp-scan",
    "macro-jungle": "cpp-scan", // cpp-scan includes #ifdef jungle index
    "list-functions": "cpp-bigfile-map",
}

// ─── Compile Database Check ──────────────────────────────────────────

interface CompileDbInfo {
    exists: boolean
    valid: boolean
    entries: any[]
    path: string | null
}

function loadCompileDb(projectDir: string): CompileDbInfo {
    const dbPath = path.join(projectDir, "compile_commands.json")

    if (!fs.existsSync(dbPath)) {
        return { exists: false, valid: false, entries: [], path: null }
    }

    try {
        const content = fs.readFileSync(dbPath, "utf-8")
        const entries = JSON.parse(content)
        if (!Array.isArray(entries)) {
            return { exists: true, valid: false, entries: [], path: dbPath }
        }
        return { exists: true, valid: true, entries, path: dbPath }
    } catch {
        return { exists: true, valid: false, entries: [], path: dbPath }
    }
}

function hasCompileEntry(db: CompileDbInfo, sourceFile: string): boolean {
    if (!db.valid || db.entries.length === 0) return false

    const resolvedSource = path.resolve(sourceFile)

    for (const entry of db.entries) {
        const dir = entry.directory || ""
        const file = entry.file || ""
        const fullPath = path.isAbsolute(file)
            ? path.resolve(file)
            : path.resolve(dir, file)

        if (fullPath === resolvedSource) {
            return true
        }
    }

    return false
}

function countValidEntries(db: CompileDbInfo): { valid: number; total: number } {
    if (!db.valid) return { valid: 0, total: 0 }

    let valid = 0
    for (const entry of db.entries) {
        const dir = entry.directory || ""
        const file = entry.file || ""
        const fullPath = path.isAbsolute(file)
            ? file
            : path.resolve(dir, file)

        if (fs.existsSync(fullPath)) {
            valid++
        }
    }

    return { valid, total: db.entries.length }
}

// ─── Analysis Mode Determination ─────────────────────────────────────

/**
 * Determine the analysis mode for a given project and source file.
 *
 * Returns:
 *   - 'ast': compile_commands.json exists and target file has entry (confidence: 1.0)
 *   - 'partial_ast': compile_commands.json exists but target file missing (confidence: 0.3-0.7)
 *   - 'regex_fallback': no compile_commands.json or invalid (confidence: 0.5)
 */
export function determineAnalysisMode(
    projectDir: string,
    sourceFile: string
): AnalysisModeResult {
    const db = loadCompileDb(projectDir)

    // No compile_commands.json at all
    if (!db.exists) {
        return {
            mode: "regex_fallback",
            confidence: 0.5,
            reason: "compile_commands.json 不存在，使用正则启发式分析（误报率 >30%）",
        }
    }

    // Invalid JSON
    if (!db.valid) {
        return {
            mode: "regex_fallback",
            confidence: 0.5,
            reason: "compile_commands.json 格式无效，使用正则启发式分析",
        }
    }

    // Empty database
    if (db.entries.length === 0) {
        return {
            mode: "regex_fallback",
            confidence: 0.5,
            reason: "compile_commands.json 为空，使用正则启发式分析",
        }
    }

    // Check if target file has compile entry
    if (hasCompileEntry(db, sourceFile)) {
        const { valid, total } = countValidEntries(db)
        return {
            mode: "ast",
            confidence: 1.0,
            compileDbPath: db.path!,
            totalEntries: total,
            validEntries: valid,
        }
    }

    // Target file not in compile database
    const { valid, total } = countValidEntries(db)
    const coverageRatio = total > 0 ? valid / total : 0

    return {
        mode: "partial_ast",
        confidence: Math.round(coverageRatio * 0.7 * 100) / 100,
        reason: `目标文件 ${path.basename(sourceFile)} 不在 compile_commands.json 中`,
        missingFiles: [sourceFile],
        compileDbPath: db.path!,
        totalEntries: total,
        validEntries: valid,
    }
}

// ─── Tool Routing ────────────────────────────────────────────────────

/**
 * Route an analysis tool request to the best available implementation.
 *
 * If AST is available, routes to MCP AST tools.
 * Otherwise, falls back to regex-based tools with clear degradation notice.
 */
export function routeAnalysisTool(
    toolType: string,
    projectDir: string,
    sourceFile: string
): RoutingDecision {
    const modeResult = determineAnalysisMode(projectDir, sourceFile)

    const astTool = AST_TOOL_MAP[toolType]
    const regexTool = REGEX_TOOL_MAP[toolType] || `cpp-${toolType}`

    // AST mode: use precise AST tools
    if (modeResult.mode === "ast" && astTool) {
        const enhancedTools = Object.values(AST_TOOL_MAP).filter(
            (v, i, a) => a.indexOf(v) === i
        )

        return {
            toolName: astTool,
            mode: "ast",
            confidence: modeResult.confidence,
            description: `AST 精准分析: ${astTool} (基于 compile_commands.json, ${modeResult.validEntries}/${modeResult.totalEntries} 路径有效)`,
            enhancedTools,
            fallbackChain: [astTool, regexTool],
        }
    }

    // Partial AST: AST available but not for this file
    if (modeResult.mode === "partial_ast") {
        return {
            toolName: regexTool,
            mode: "partial_ast",
            confidence: modeResult.confidence,
            description: `部分 AST 可用但目标文件无条目，降级为正则分析: ${regexTool}`,
            enhancedTools: [],
            fallbackChain: [regexTool],
            fallbackReason: modeResult.reason,
        }
    }

    // Regex fallback
    return {
        toolName: regexTool,
        mode: "regex_fallback",
        confidence: modeResult.confidence,
        description: `正则启发式分析: ${regexTool} (${modeResult.reason})`,
        enhancedTools: [],
        fallbackChain: [regexTool],
        fallbackReason: modeResult.reason,
    }
}
