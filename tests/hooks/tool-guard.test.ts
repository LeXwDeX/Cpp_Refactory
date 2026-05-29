import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { checkConstraints, type ConstraintResult } from "../../lib/hooks/tool-guard.js"

describe("tool-guard", () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-refactory-guard-"))
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    describe("checkConstraints", () => {
        it("returns blocked when .cpp_refactory does not exist", () => {
            const result = checkConstraints(tmpDir)
            assert.equal(result.allowed, false)
            assert.ok(result.reasons.some((r) => r.includes("not installed")))
        })

        it("returns allowed when state files exist", () => {
            const stateDir = path.join(tmpDir, ".cpp_refactory", "state")
            fs.mkdirSync(stateDir, { recursive: true })
            fs.writeFileSync(path.join(stateDir, "REFACTOR_STATE.md"), "# State")
            fs.writeFileSync(path.join(stateDir, "PARTITION_LEDGER.md"), "# Ledger")
            fs.writeFileSync(path.join(stateDir, "TOOL_GAPS.md"), "# Gaps")

            const result = checkConstraints(tmpDir)
            assert.equal(result.allowed, true)
            assert.equal(result.reasons.length, 0)
        })

        it("warns about open tool gaps from markdown (fallback)", () => {
            const stateDir = path.join(tmpDir, ".cpp_refactory", "state")
            fs.mkdirSync(stateDir, { recursive: true })
            fs.writeFileSync(path.join(stateDir, "REFACTOR_STATE.md"), "# State")
            fs.writeFileSync(path.join(stateDir, "PARTITION_LEDGER.md"), "# Ledger")
            fs.writeFileSync(
                path.join(stateDir, "TOOL_GAPS.md"),
                "# Gaps\n\n### GAP-001: test\n- **状态**：OPEN"
            )

            const result = checkConstraints(tmpDir)
            assert.equal(result.allowed, true) // Still allowed, but warns
            assert.ok(result.warnings.some((w) => w.includes("open tool gap")))
        })

        // --- New tests for structured JSON storage ---

        it("reads open gaps from TOOL_GAPS.json when present", () => {
            const stateDir = path.join(tmpDir, ".cpp_refactory", "state")
            fs.mkdirSync(stateDir, { recursive: true })
            fs.writeFileSync(path.join(stateDir, "REFACTOR_STATE.md"), "# State")
            fs.writeFileSync(path.join(stateDir, "PARTITION_LEDGER.md"), "# Ledger")
            fs.writeFileSync(path.join(stateDir, "TOOL_GAPS.md"), "# Gaps")

            // Write structured JSON with 2 open gaps
            const gapsJson = {
                gaps: [
                    {
                        id: "GAP-001",
                        title: "Missing feature A",
                        status: "OPEN",
                        severity: "HIGH",
                        description: "Test gap 1"
                    },
                    {
                        id: "GAP-002",
                        title: "Missing feature B",
                        status: "OPEN",
                        severity: "MEDIUM",
                        description: "Test gap 2"
                    },
                    {
                        id: "GAP-003",
                        title: "Fixed feature C",
                        status: "CLOSED",
                        severity: "LOW",
                        description: "Already fixed"
                    }
                ],
                updatedAt: "2026-05-29T00:00:00Z"
            }
            fs.writeFileSync(
                path.join(stateDir, "TOOL_GAPS.json"),
                JSON.stringify(gapsJson, null, 2)
            )

            const result = checkConstraints(tmpDir)
            assert.equal(result.allowed, true)
            // Should warn about 2 open gaps (not 3, since one is CLOSED)
            assert.ok(result.warnings.some((w) => w.includes("2 open tool gap")))
        })

        it("prefers JSON over markdown when both exist", () => {
            const stateDir = path.join(tmpDir, ".cpp_refactory", "state")
            fs.mkdirSync(stateDir, { recursive: true })
            fs.writeFileSync(path.join(stateDir, "REFACTOR_STATE.md"), "# State")
            fs.writeFileSync(path.join(stateDir, "PARTITION_LEDGER.md"), "# Ledger")

            // Markdown has 1 open gap
            fs.writeFileSync(
                path.join(stateDir, "TOOL_GAPS.md"),
                "# Gaps\n\n### GAP-001: test\n- **状态**：OPEN"
            )

            // JSON has 0 open gaps (all CLOSED)
            const gapsJson = {
                gaps: [
                    {
                        id: "GAP-001",
                        title: "Fixed",
                        status: "CLOSED",
                        severity: "LOW",
                        description: "Done"
                    }
                ],
                updatedAt: "2026-05-29T00:00:00Z"
            }
            fs.writeFileSync(
                path.join(stateDir, "TOOL_GAPS.json"),
                JSON.stringify(gapsJson, null, 2)
            )

            const result = checkConstraints(tmpDir)
            assert.equal(result.allowed, true)
            // Should NOT warn (JSON takes precedence, shows 0 open gaps)
            assert.equal(result.warnings.length, 0)
        })

        it("falls back to markdown when JSON is invalid", () => {
            const stateDir = path.join(tmpDir, ".cpp_refactory", "state")
            fs.mkdirSync(stateDir, { recursive: true })
            fs.writeFileSync(path.join(stateDir, "REFACTOR_STATE.md"), "# State")
            fs.writeFileSync(path.join(stateDir, "PARTITION_LEDGER.md"), "# Ledger")

            // Markdown has 1 open gap
            fs.writeFileSync(
                path.join(stateDir, "TOOL_GAPS.md"),
                "# Gaps\n\n### GAP-001: test\n- **状态**：OPEN"
            )

            // Invalid JSON
            fs.writeFileSync(
                path.join(stateDir, "TOOL_GAPS.json"),
                "{ invalid json }"
            )

            const result = checkConstraints(tmpDir)
            assert.equal(result.allowed, true)
            // Should fall back to markdown and warn
            assert.ok(result.warnings.some((w) => w.includes("open tool gap")))
        })

        it("no warning when JSON has no open gaps", () => {
            const stateDir = path.join(tmpDir, ".cpp_refactory", "state")
            fs.mkdirSync(stateDir, { recursive: true })
            fs.writeFileSync(path.join(stateDir, "REFACTOR_STATE.md"), "# State")
            fs.writeFileSync(path.join(stateDir, "PARTITION_LEDGER.md"), "# Ledger")
            fs.writeFileSync(path.join(stateDir, "TOOL_GAPS.md"), "# Gaps")

            const gapsJson = {
                gaps: [
                    {
                        id: "GAP-001",
                        title: "Fixed",
                        status: "CLOSED",
                        severity: "LOW",
                        description: "Done"
                    },
                    {
                        id: "GAP-002",
                        title: "Wontfix",
                        status: "WONTFIX",
                        severity: "LOW",
                        description: "Not fixing"
                    }
                ],
                updatedAt: "2026-05-29T00:00:00Z"
            }
            fs.writeFileSync(
                path.join(stateDir, "TOOL_GAPS.json"),
                JSON.stringify(gapsJson, null, 2)
            )

            const result = checkConstraints(tmpDir)
            assert.equal(result.allowed, true)
            assert.equal(result.warnings.length, 0)
        })

        // --- Pipeline stage enforcement tests ---

        function createPipelineState(stage: string) {
            const stateDir = path.join(tmpDir, ".cpp_refactory", "state")
            fs.mkdirSync(stateDir, { recursive: true })
            fs.writeFileSync(path.join(stateDir, "REFACTOR_STATE.md"), "# State")
            fs.writeFileSync(path.join(stateDir, "PARTITION_LEDGER.md"), "# Ledger")
            fs.writeFileSync(path.join(stateDir, "TOOL_GAPS.md"), "# Gaps")

            const pipelineJson = {
                id: "test-pipeline",
                projectDir: tmpDir,
                currentStage: stage,
                status: "active",
                stages: {
                    scan: { status: "completed", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                    analyze: { status: "completed", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                    plan: { status: "completed", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                    execute: { status: stage === "execute" ? "running" : "completed", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                    verify: { status: "pending", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                    record: { status: "pending", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                },
                stageOrder: ["scan", "analyze", "plan", "execute", "verify", "record"],
                createdAt: "2026-05-29T00:00:00Z",
                updatedAt: "2026-05-29T00:00:00Z",
            }
            fs.writeFileSync(
                path.join(stateDir, "PIPELINE_STATE.json"),
                JSON.stringify(pipelineJson, null, 2)
            )
        }

        it("warns when cpp-characterize used before execute stage", () => {
            createPipelineState("plan")
            const result = checkConstraints(tmpDir, "cpp-characterize")
            assert.equal(result.allowed, true) // warning only, not blocking
            assert.ok(result.warnings.some((w) => w.includes("cpp-characterize")))
            assert.ok(result.warnings.some((w) => w.includes("execute")))
        })

        it("warns when cpp-pipeline used before verify stage", () => {
            createPipelineState("execute")
            const result = checkConstraints(tmpDir, "cpp-pipeline")
            assert.equal(result.allowed, true)
            assert.ok(result.warnings.some((w) => w.includes("cpp-pipeline")))
            assert.ok(result.warnings.some((w) => w.includes("verify")))
        })

        it("no pipeline warning when stage is sufficient", () => {
            createPipelineState("execute")
            const result = checkConstraints(tmpDir, "cpp-characterize")
            assert.equal(result.allowed, true)
            // No pipeline-related warnings (execute >= execute)
            const pipelineWarnings = result.warnings.filter((w) => w.includes("stage"))
            assert.equal(pipelineWarnings.length, 0)
        })

        it("no pipeline warning when tool has no stage requirement", () => {
            createPipelineState("scan")
            const result = checkConstraints(tmpDir, "cpp-scan")
            assert.equal(result.allowed, true)
            const pipelineWarnings = result.warnings.filter((w) => w.includes("stage"))
            assert.equal(pipelineWarnings.length, 0)
        })

        it("no pipeline warning when no pipeline exists", () => {
            // Only create state dir, no PIPELINE_STATE.json
            const stateDir = path.join(tmpDir, ".cpp_refactory", "state")
            fs.mkdirSync(stateDir, { recursive: true })
            fs.writeFileSync(path.join(stateDir, "REFACTOR_STATE.md"), "# State")
            fs.writeFileSync(path.join(stateDir, "PARTITION_LEDGER.md"), "# Ledger")
            fs.writeFileSync(path.join(stateDir, "TOOL_GAPS.md"), "# Gaps")

            const result = checkConstraints(tmpDir, "cpp-characterize")
            assert.equal(result.allowed, true)
            const pipelineWarnings = result.warnings.filter((w) => w.includes("stage"))
            assert.equal(pipelineWarnings.length, 0)
        })

        it("backward compatible: no toolName still works", () => {
            createPipelineState("scan")
            const result = checkConstraints(tmpDir)
            assert.equal(result.allowed, true)
        })
    })
})
