import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import {
    PipelineState,
    PipelineStage,
    createPipeline,
    advanceStage,
    loadPipeline,
    savePipeline,
    getStageResult,
    type StageResult,
} from "../../lib/utils/pipeline.js"

describe("pipeline", () => {
    let tmpDir: string
    let stateDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-pipeline-test-"))
        stateDir = path.join(tmpDir, ".cpp_refactory", "state")
        fs.mkdirSync(stateDir, { recursive: true })
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    // ─── Pipeline Creation ───────────────────────────────────────────
    describe("createPipeline", () => {
        it("creates a new pipeline in 'scan' stage", () => {
            const pipeline = createPipeline(tmpDir)
            assert.equal(pipeline.currentStage, "scan")
            assert.equal(pipeline.projectDir, tmpDir)
            assert.ok(pipeline.id, "should have unique ID")
            assert.ok(pipeline.createdAt, "should have creation timestamp")
        })

        it("initializes all stages as pending", () => {
            const pipeline = createPipeline(tmpDir)
            const stages: PipelineStage[] = ["scan", "analyze", "plan", "execute", "verify", "record"]
            for (const stage of stages) {
                assert.equal(pipeline.stages[stage].status, "pending")
            }
        })

        it("persists pipeline state to disk", () => {
            createPipeline(tmpDir)
            const stateFile = path.join(stateDir, "PIPELINE_STATE.json")
            assert.ok(fs.existsSync(stateFile), "pipeline state file should exist")
        })
    })

    // ─── Stage Advancement ───────────────────────────────────────────
    describe("advanceStage", () => {
        it("advances from scan to analyze", () => {
            const pipeline = createPipeline(tmpDir)
            const result: StageResult = {
                status: "completed",
                artifacts: { scanReport: "scan output" },
            }

            const updated = advanceStage(pipeline, "scan", result)
            assert.equal(updated.currentStage, "analyze")
            assert.equal(updated.stages.scan.status, "completed")
        })

        it("advances through the full pipeline: scan→analyze→plan→execute→verify→record", () => {
            let pipeline = createPipeline(tmpDir)

            const stages: PipelineStage[] = ["scan", "analyze", "plan", "execute", "verify", "record"]
            for (let i = 0; i < stages.length - 1; i++) {
                const result: StageResult = {
                    status: "completed",
                    artifacts: { [`${stages[i]}Output`]: "data" },
                }
                pipeline = advanceStage(pipeline, stages[i], result)
                assert.equal(pipeline.currentStage, stages[i + 1])
                assert.equal(pipeline.stages[stages[i]].status, "completed")
            }
        })

        it("marks stage as failed when result status is failed", () => {
            const pipeline = createPipeline(tmpDir)
            const result: StageResult = {
                status: "failed",
                error: "scan failed: no source files found",
                artifacts: {},
            }

            const updated = advanceStage(pipeline, "scan", result)
            assert.equal(updated.stages.scan.status, "failed")
            assert.equal(updated.currentStage, "scan") // stays on failed stage
        })

        it("verify failure rolls back to execute stage", () => {
            let pipeline = createPipeline(tmpDir)

            // Advance to verify stage
            const advanceTo: PipelineStage[] = ["scan", "analyze", "plan", "execute"]
            for (const stage of advanceTo) {
                pipeline = advanceStage(pipeline, stage, {
                    status: "completed",
                    artifacts: {},
                })
            }
            assert.equal(pipeline.currentStage, "verify")

            // Verify fails
            const verifyResult: StageResult = {
                status: "failed",
                error: "compilation error in modified file",
                artifacts: { errors: ["error: undefined reference"] },
            }
            const rolled = advanceStage(pipeline, "verify", verifyResult)
            assert.equal(rolled.currentStage, "execute")
            assert.equal(rolled.stages.verify.status, "failed")
            assert.equal(rolled.stages.execute.status, "retry")
        })

        it("record stage marks pipeline as completed", () => {
            let pipeline = createPipeline(tmpDir)
            const stages: PipelineStage[] = ["scan", "analyze", "plan", "execute", "verify", "record"]

            for (const stage of stages) {
                pipeline = advanceStage(pipeline, stage, {
                    status: "completed",
                    artifacts: {},
                })
            }

            assert.equal(pipeline.status, "completed")
        })
    })

    // ─── Persistence ─────────────────────────────────────────────────
    describe("savePipeline / loadPipeline", () => {
        it("saves and loads pipeline state correctly", () => {
            const pipeline = createPipeline(tmpDir)
            savePipeline(pipeline)

            const loaded = loadPipeline(tmpDir)
            assert.ok(loaded, "should load pipeline")
            assert.equal(loaded!.id, pipeline.id)
            assert.equal(loaded!.currentStage, pipeline.currentStage)
            assert.equal(loaded!.projectDir, pipeline.projectDir)
        })

        it("returns null when no pipeline exists", () => {
            const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-empty-"))
            const loaded = loadPipeline(emptyDir)
            assert.equal(loaded, null)
            fs.rmSync(emptyDir, { recursive: true, force: true })
        })

        it("supports resume from any stage (breakpoint recovery)", () => {
            let pipeline = createPipeline(tmpDir)

            // Advance to plan stage
            pipeline = advanceStage(pipeline, "scan", { status: "completed", artifacts: {} })
            pipeline = advanceStage(pipeline, "analyze", { status: "completed", artifacts: {} })
            savePipeline(pipeline)

            // Simulate session restart: load from disk
            const loaded = loadPipeline(tmpDir)
            assert.ok(loaded)
            assert.equal(loaded!.currentStage, "plan")
            assert.equal(loaded!.stages.scan.status, "completed")
            assert.equal(loaded!.stages.analyze.status, "completed")
            assert.equal(loaded!.stages.plan.status, "pending")
        })
    })

    // ─── Stage Results ───────────────────────────────────────────────
    describe("getStageResult", () => {
        it("returns stage result for completed stages", () => {
            let pipeline = createPipeline(tmpDir)
            pipeline = advanceStage(pipeline, "scan", {
                status: "completed",
                artifacts: { fileCount: 42, hotspots: ["big.cpp"] },
            })

            const result = getStageResult(pipeline, "scan")
            assert.ok(result)
            assert.equal(result.status, "completed")
            assert.deepEqual(result.artifacts.fileCount, 42)
        })

        it("returns null for pending stages", () => {
            const pipeline = createPipeline(tmpDir)
            const result = getStageResult(pipeline, "analyze")
            assert.equal(result, null)
        })
    })

    // ─── Pipeline State Machine ──────────────────────────────────────
    describe("state machine validation", () => {
        it("rejects advancing a stage that is not current", () => {
            const pipeline = createPipeline(tmpDir)
            // Try to advance analyze when current is scan
            assert.throws(
                () => advanceStage(pipeline, "analyze", { status: "completed", artifacts: {} }),
                /cannot advance.*analyze.*current.*scan/i
            )
        })

        it("pipeline has valid stage order", () => {
            const pipeline = createPipeline(tmpDir)
            const expectedOrder: PipelineStage[] = ["scan", "analyze", "plan", "execute", "verify", "record"]
            assert.deepEqual(pipeline.stageOrder, expectedOrder)
        })
    })
})
