import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import {
    getProductStatus,
    buildAnalysisAdvice,
    buildVerifyReport,
    type ProductStatus,
} from "../../lib/utils/orchestrator.js"

describe("orchestrator", () => {
    let tmpDir: string
    let stateDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-orchestrator-test-"))
        stateDir = path.join(tmpDir, ".cpp_refactory", "state")
        fs.mkdirSync(stateDir, { recursive: true })
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    // ─── getProductStatus ────────────────────────────────────────────
    describe("getProductStatus", () => {
        it("returns a complete product status for a fresh project", () => {
            const status = getProductStatus(tmpDir)

            assert.ok(status.projectDir)
            assert.equal(status.analysisMode, "regex_fallback")
            assert.equal(status.pipelineActive, false)
            assert.equal(status.hasBaseline, false)
            assert.ok(status.environment)
            assert.ok(status.advice)
        })

        it("detects AST mode when compile_commands.json is valid", () => {
            fs.writeFileSync(path.join(tmpDir, "main.cpp"), "int main() {}")
            const db = [{
                directory: tmpDir,
                file: "main.cpp",
                arguments: ["g++", "-c", "main.cpp"],
            }]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(db)
            )

            const status = getProductStatus(tmpDir)
            assert.equal(status.analysisMode, "ast")
            assert.equal(status.analysisConfidence, 1.0)
        })

        it("detects active pipeline", () => {
            // Create a pipeline state file
            const pipelineState = {
                id: "test-pipeline",
                projectDir: tmpDir,
                currentStage: "analyze",
                status: "active",
                stages: {
                    scan: { status: "completed", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                    analyze: { status: "pending", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                    plan: { status: "pending", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                    execute: { status: "pending", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                    verify: { status: "pending", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                    record: { status: "pending", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                },
                stageOrder: ["scan", "analyze", "plan", "execute", "verify", "record"],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            fs.writeFileSync(
                path.join(stateDir, "PIPELINE_STATE.json"),
                JSON.stringify(pipelineState)
            )

            const status = getProductStatus(tmpDir)
            assert.equal(status.pipelineActive, true)
            assert.equal(status.pipelineStage, "analyze")
        })

        it("detects quality baseline", () => {
            const baseline = {
                id: "test-baseline",
                projectDir: tmpDir,
                timestamp: new Date().toISOString(),
                metrics: {
                    warnings: { clangTidy: 5, cppcheck: 2 },
                    tests: { total: 10, passed: 10, failed: 0 },
                    compilation: { errors: 0, warnings: 3 },
                },
            }
            fs.writeFileSync(
                path.join(stateDir, "QUALITY_BASELINE.json"),
                JSON.stringify(baseline)
            )

            const status = getProductStatus(tmpDir)
            assert.equal(status.hasBaseline, true)
            assert.ok(status.baselineTimestamp)
        })

        it("generates contextual advice based on status", () => {
            const status = getProductStatus(tmpDir)
            assert.ok(status.advice.length > 0)
            // Fresh project should advise running diagnose or bootstrap
            assert.ok(
                status.advice.some(a => a.includes("diagnose") || a.includes("bootstrap")),
                "should advise diagnose or bootstrap for fresh project"
            )
        })

        it("advises generating compile_commands.json when in regex mode", () => {
            const status = getProductStatus(tmpDir)
            assert.equal(status.analysisMode, "regex_fallback")
            assert.ok(
                status.advice.some(a => a.includes("compile_commands")),
                "should advise generating compile_commands.json"
            )
        })

        it("advises recording baseline when pipeline is active but no baseline", () => {
            // Create active pipeline
            const pipelineState = {
                id: "test",
                projectDir: tmpDir,
                currentStage: "execute",
                status: "active",
                stages: {
                    scan: { status: "completed", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                    analyze: { status: "completed", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                    plan: { status: "completed", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                    execute: { status: "pending", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                    verify: { status: "pending", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                    record: { status: "pending", result: null, startedAt: null, completedAt: null, retryCount: 0 },
                },
                stageOrder: ["scan", "analyze", "plan", "execute", "verify", "record"],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            fs.writeFileSync(
                path.join(stateDir, "PIPELINE_STATE.json"),
                JSON.stringify(pipelineState)
            )

            const status = getProductStatus(tmpDir)
            assert.ok(
                status.advice.some(a => a.includes("baseline") || a.includes("quality")),
                "should advise recording baseline before verify"
            )
        })

        it("detects partial_ast mode when compile_commands has path_mismatch with some valid paths", () => {
            // Create a compile_commands.json with one valid and one invalid path
            fs.writeFileSync(path.join(tmpDir, "valid.cpp"), "int valid() {}")
            const db = [
                {
                    directory: tmpDir,
                    file: "valid.cpp",
                    arguments: ["g++", "-c", "valid.cpp"],
                },
                {
                    directory: "/nonexistent/path",
                    file: "missing.cpp",
                    arguments: ["g++", "-c", "missing.cpp"],
                },
            ]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(db)
            )

            const status = getProductStatus(tmpDir)
            assert.equal(status.analysisMode, "partial_ast")
            assert.ok(status.analysisConfidence > 0 && status.analysisConfidence < 1)
            assert.ok(
                status.advice.some(a => a.includes("路径失效")),
                "should advise about path mismatch"
            )
        })
    })

    // ─── buildAnalysisAdvice ─────────────────────────────────────────
    describe("buildAnalysisAdvice", () => {
        it("returns AST routing advice when compile_commands.json available", () => {
            fs.writeFileSync(path.join(tmpDir, "main.cpp"), "int main() {}")
            const db = [{
                directory: tmpDir,
                file: "main.cpp",
                arguments: ["g++", "-c", "main.cpp"],
            }]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(db)
            )

            const advice = buildAnalysisAdvice(tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(advice.mode, "ast")
            assert.ok(advice.recommendedTool)
            assert.ok(advice.description.includes("AST"))
        })

        it("returns fallback advice with clear warning when no compile_commands.json", () => {
            const advice = buildAnalysisAdvice(tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(advice.mode, "regex_fallback")
            assert.ok(advice.warning, "should have warning about regex limitations")
            assert.ok(advice.fixSuggestion, "should suggest how to enable AST")
        })

        it("includes confidence score in advice", () => {
            const advice = buildAnalysisAdvice(tmpDir, path.join(tmpDir, "main.cpp"))
            assert.ok(typeof advice.confidence === "number")
            assert.ok(advice.confidence >= 0 && advice.confidence <= 1)
        })

        it("returns partial_ast advice when target file not in compile_commands", () => {
            // Create compile_commands.json with a different file
            fs.writeFileSync(path.join(tmpDir, "other.cpp"), "void other() {}")
            const db = [{
                directory: tmpDir,
                file: "other.cpp",
                arguments: ["g++", "-c", "other.cpp"],
            }]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(db)
            )

            const advice = buildAnalysisAdvice(tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(advice.mode, "partial_ast")
            assert.ok(advice.warning)
            assert.ok(advice.warning!.includes("不在"))
            assert.ok(advice.fixSuggestion)
        })
    })

    // ─── buildVerifyReport ───────────────────────────────────────────
    describe("buildVerifyReport", () => {
        it("generates a combined verify + quality-gate report", () => {
            // Create baseline
            const baseline = {
                id: "test",
                projectDir: tmpDir,
                timestamp: new Date().toISOString(),
                metrics: {
                    warnings: { clangTidy: 5, cppcheck: 2 },
                    tests: { total: 10, passed: 10, failed: 0 },
                    compilation: { errors: 0, warnings: 3 },
                },
            }
            fs.writeFileSync(
                path.join(stateDir, "QUALITY_BASELINE.json"),
                JSON.stringify(baseline)
            )

            const report = buildVerifyReport(tmpDir, {
                warnings: { clangTidy: 7, cppcheck: 2 },
                tests: { total: 10, passed: 9, failed: 1 },
                compilation: { errors: 0, warnings: 3 },
            })

            assert.ok(report.qualityDelta)
            assert.equal(report.qualityDelta.warningsDelta.clangTidy, 2)
            assert.equal(report.qualityDelta.testRegressions, 1)
            assert.equal(report.qualityDelta.passed, false)
            assert.ok(report.summary)
            assert.ok(report.summary.includes("clangTidy") || report.summary.includes("clang-tidy"))
        })

        it("handles missing baseline gracefully", () => {
            const report = buildVerifyReport(tmpDir, {
                warnings: { clangTidy: 3, cppcheck: 1 },
                tests: { total: 5, passed: 5, failed: 0 },
                compilation: { errors: 0, warnings: 0 },
            })

            assert.equal(report.hasBaseline, false)
            assert.ok(report.summary.includes("baseline"))
        })

        it("reports pass when within thresholds", () => {
            const baseline = {
                id: "test",
                projectDir: tmpDir,
                timestamp: new Date().toISOString(),
                metrics: {
                    warnings: { clangTidy: 5, cppcheck: 2 },
                    tests: { total: 10, passed: 10, failed: 0 },
                    compilation: { errors: 0, warnings: 3 },
                },
            }
            fs.writeFileSync(
                path.join(stateDir, "QUALITY_BASELINE.json"),
                JSON.stringify(baseline)
            )

            const report = buildVerifyReport(tmpDir, {
                warnings: { clangTidy: 5, cppcheck: 2 },
                tests: { total: 10, passed: 10, failed: 0 },
                compilation: { errors: 0, warnings: 3 },
            })

            assert.equal(report.qualityDelta.passed, true)
            assert.ok(report.summary.includes("通过") || report.summary.includes("pass"))
        })

        it("reports new compilation errors in summary", () => {
            const baseline = {
                id: "test",
                projectDir: tmpDir,
                timestamp: new Date().toISOString(),
                metrics: {
                    warnings: { clangTidy: 0, cppcheck: 0 },
                    tests: { total: 10, passed: 10, failed: 0 },
                    compilation: { errors: 0, warnings: 0 },
                },
            }
            fs.writeFileSync(
                path.join(stateDir, "QUALITY_BASELINE.json"),
                JSON.stringify(baseline)
            )

            const report = buildVerifyReport(tmpDir, {
                warnings: { clangTidy: 0, cppcheck: 0 },
                tests: { total: 10, passed: 10, failed: 0 },
                compilation: { errors: 3, warnings: 0 },
            })

            assert.equal(report.qualityDelta.newErrors, 3)
            assert.ok(report.summary.includes("新增编译错误"))
            assert.ok(report.summary.includes("+3"))
        })

        it("reports test regressions in summary", () => {
            const baseline = {
                id: "test",
                projectDir: tmpDir,
                timestamp: new Date().toISOString(),
                metrics: {
                    warnings: { clangTidy: 0, cppcheck: 0 },
                    tests: { total: 10, passed: 10, failed: 0 },
                    compilation: { errors: 0, warnings: 0 },
                },
            }
            fs.writeFileSync(
                path.join(stateDir, "QUALITY_BASELINE.json"),
                JSON.stringify(baseline)
            )

            const report = buildVerifyReport(tmpDir, {
                warnings: { clangTidy: 0, cppcheck: 0 },
                tests: { total: 10, passed: 7, failed: 3 },
                compilation: { errors: 0, warnings: 0 },
            })

            assert.equal(report.qualityDelta.testRegressions, 3)
            assert.ok(report.summary.includes("测试回归"))
        })
    })
})
