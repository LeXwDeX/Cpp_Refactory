import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

// ─── Types ───────────────────────────────────────────────────────────

export type PipelineStage =
    | "scan"
    | "analyze"
    | "plan"
    | "execute"
    | "verify"
    | "record"

export type StageStatus = "pending" | "running" | "completed" | "failed" | "retry"

export type PipelineStatus = "active" | "completed" | "failed" | "paused"

export interface StageResult {
    status: "completed" | "failed"
    artifacts: Record<string, any>
    error?: string
    duration?: number
}

export interface StageState {
    status: StageStatus
    result: StageResult | null
    startedAt: string | null
    completedAt: string | null
    retryCount: number
}

export interface PipelineState {
    id: string
    projectDir: string
    currentStage: PipelineStage
    status: PipelineStatus
    stages: Record<PipelineStage, StageState>
    stageOrder: PipelineStage[]
    createdAt: string
    updatedAt: string
}

// ─── Constants ───────────────────────────────────────────────────────

const STAGE_ORDER: PipelineStage[] = [
    "scan",
    "analyze",
    "plan",
    "execute",
    "verify",
    "record",
]

const PIPELINE_STATE_FILE = "PIPELINE_STATE.json"

// ─── Pipeline Creation ───────────────────────────────────────────────

function createInitialStageState(): StageState {
    return {
        status: "pending",
        result: null,
        startedAt: null,
        completedAt: null,
        retryCount: 0,
    }
}

/**
 * Create a new pipeline for a project.
 * Initializes all stages as pending and persists state to disk.
 */
export function createPipeline(projectDir: string): PipelineState {
    const now = new Date().toISOString()
    const stages = {} as Record<PipelineStage, StageState>
    for (const stage of STAGE_ORDER) {
        stages[stage] = createInitialStageState()
    }

    const pipeline: PipelineState = {
        id: crypto.randomUUID(),
        projectDir: path.resolve(projectDir),
        currentStage: "scan",
        status: "active",
        stages,
        stageOrder: [...STAGE_ORDER],
        createdAt: now,
        updatedAt: now,
    }

    savePipeline(pipeline)
    return pipeline
}

// ─── Stage Advancement ───────────────────────────────────────────────

/**
 * Advance a pipeline stage with a result.
 *
 * Rules:
 *   - Can only advance the current stage
 *   - Completed stage → advance to next stage
 *   - Failed verify → rollback to execute (retry)
 *   - Completed record → pipeline status = completed
 */
export function advanceStage(
    pipeline: PipelineState,
    stage: PipelineStage,
    result: StageResult
): PipelineState {
    // Validate: can only advance current stage
    if (stage !== pipeline.currentStage) {
        throw new Error(
            `Cannot advance stage '${stage}': current stage is '${pipeline.currentStage}'`
        )
    }

    const now = new Date().toISOString()
    const updated = deepClone(pipeline)
    updated.updatedAt = now

    // Update current stage result
    updated.stages[stage].status =
        result.status === "completed" ? "completed" : "failed"
    updated.stages[stage].result = result
    updated.stages[stage].completedAt = now

    // Handle stage transitions
    if (result.status === "completed") {
        const currentIndex = STAGE_ORDER.indexOf(stage)

        if (stage === "record") {
            // Pipeline complete
            updated.status = "completed"
        } else if (currentIndex < STAGE_ORDER.length - 1) {
            // Advance to next stage
            const nextStage = STAGE_ORDER[currentIndex + 1]
            updated.currentStage = nextStage
            updated.stages[nextStage].status = "pending"
            updated.stages[nextStage].startedAt = now
        }
    } else {
        // Stage failed
        if (stage === "verify") {
            // Verify failure: rollback to execute for retry
            updated.currentStage = "execute"
            updated.stages.execute.status = "retry"
            updated.stages.execute.retryCount++
            updated.stages.execute.result = null
            updated.stages.execute.completedAt = null
        } else {
            // Other failures: stay on current stage
            updated.status = "failed"
        }
    }

    savePipeline(updated)
    return updated
}

// ─── Persistence ─────────────────────────────────────────────────────

function getStateFilePath(projectDir: string): string {
    return path.join(projectDir, ".cpp_refactory", "state", PIPELINE_STATE_FILE)
}

/**
 * Save pipeline state to disk as JSON.
 */
export function savePipeline(pipeline: PipelineState): void {
    const filePath = getStateFilePath(pipeline.projectDir)
    const dir = path.dirname(filePath)

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(filePath, JSON.stringify(pipeline, null, 2), "utf-8")
}

/**
 * Load pipeline state from disk.
 * Returns null if no pipeline exists.
 */
export function loadPipeline(projectDir: string): PipelineState | null {
    const filePath = getStateFilePath(path.resolve(projectDir))

    if (!fs.existsSync(filePath)) {
        return null
    }

    try {
        const content = fs.readFileSync(filePath, "utf-8")
        return JSON.parse(content) as PipelineState
    } catch {
        return null
    }
}

// ─── Stage Result Access ─────────────────────────────────────────────

/**
 * Get the result of a specific stage.
 * Returns null if the stage hasn't completed yet.
 */
export function getStageResult(
    pipeline: PipelineState,
    stage: PipelineStage
): StageResult | null {
    return pipeline.stages[stage]?.result ?? null
}

// ─── Utilities ───────────────────────────────────────────────────────

function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj))
}
