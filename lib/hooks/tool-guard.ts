import { stateExists } from "../utils/state.js"
import { readStateFiles } from "../utils/state.js"
import { loadPipeline, type PipelineStage } from "../utils/pipeline.js"
import fs from "node:fs"
import path from "node:path"

export interface ConstraintResult {
    allowed: boolean
    reasons: string[]
    warnings: string[]
}

// --- Pipeline stage requirements for specific tools ---

const TOOL_STAGE_REQUIREMENTS: Record<string, PipelineStage> = {
    "cpp-characterize": "execute",
    "cpp-pipeline": "verify",
    "cpp-quality-gate": "verify",
}

const STAGE_ORDER: PipelineStage[] = [
    "scan", "analyze", "plan", "execute", "verify", "record",
]

// --- Structured tool gap storage (Phase 1: interfaces) ---

interface ToolGap {
    id: string
    title: string
    status: "OPEN" | "CLOSED" | "WONTFIX"
    severity: "HIGH" | "MEDIUM" | "LOW"
    description: string
}

interface ToolGapsJson {
    gaps: ToolGap[]
    updatedAt: string
}

/**
 * Load structured TOOL_GAPS.json if present.
 * Returns null if file doesn't exist or is invalid.
 */
function loadToolGapsJson(projectDir: string): ToolGapsJson | null {
    const jsonPath = path.join(projectDir, ".cpp_refactory", "state", "TOOL_GAPS.json")
    if (!fs.existsSync(jsonPath)) return null
    try {
        const content = fs.readFileSync(jsonPath, "utf-8")
        const parsed = JSON.parse(content)
        // Basic validation: ensure it has the expected structure
        if (parsed && Array.isArray(parsed.gaps) && typeof parsed.updatedAt === "string") {
            return parsed as ToolGapsJson
        }
        return null
    } catch {
        return null
    }
}

/**
 * Check hard constraints before tool execution.
 * Returns whether the tool should be allowed to proceed.
 *
 * @param projectDir - The project root directory.
 * @param toolName - Optional tool name for pipeline stage checking.
 */
export function checkConstraints(projectDir: string, toolName?: string): ConstraintResult {
    const reasons: string[] = []
    const warnings: string[] = []

    // Constraint 1: .cpp_refactory must exist
    if (!stateExists(projectDir)) {
        reasons.push("cpp_refactory is not installed. Run cpp-bootstrap first.")
        return { allowed: false, reasons, warnings }
    }

    // Check for open tool gaps (Constraint 2: warn but don't block)
    // Try structured JSON first, fall back to markdown regex (backward compatibility)
    const gapsJson = loadToolGapsJson(projectDir)
    if (gapsJson) {
        const openGaps = gapsJson.gaps.filter(g => g.status === "OPEN")
        if (openGaps.length > 0) {
            warnings.push(
                `${openGaps.length} open tool gap(s) detected. Consider fixing before continuing refactoring.`
            )
        }
    } else {
        // Fallback to markdown regex (backward compatibility)
        const state = readStateFiles(projectDir)
        if (state.toolGaps) {
            const openGaps = state.toolGaps.match(/### GAP-\d+[\s\S]*?状态.*?OPEN/g)
            if (openGaps && openGaps.length > 0) {
                warnings.push(
                    `${openGaps.length} open tool gap(s) detected. Consider fixing before continuing refactoring.`
                )
            }
        }
    }

    // Pipeline stage enforcement (warning only, never blocks)
    if (toolName && TOOL_STAGE_REQUIREMENTS[toolName]) {
        const pipeline = loadPipeline(projectDir)
        if (pipeline) {
            const requiredStage = TOOL_STAGE_REQUIREMENTS[toolName]
            const currentIdx = STAGE_ORDER.indexOf(pipeline.currentStage)
            const requiredIdx = STAGE_ORDER.indexOf(requiredStage)

            if (currentIdx < requiredIdx) {
                warnings.push(
                    `Tool '${toolName}' is recommended for '${requiredStage}' stage, ` +
                    `but pipeline is at '${pipeline.currentStage}'. ` +
                    `Consider completing earlier stages first.`
                )
            }
        }
    }

    return { allowed: true, reasons, warnings }
}
