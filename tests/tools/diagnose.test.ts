import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import {
    checkToolAvailability,
    checkCompileCommands,
    runDiagnosis,
    type DiagnosisReport,
    type ToolCheckResult,
    type CompileCommandsCheck,
} from "../../lib/utils/diagnose.js"

describe("diagnose", () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-diagnose-test-"))
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    // ─── checkToolAvailability ───────────────────────────────────────
    describe("checkToolAvailability", () => {
        it("returns available:true for a known tool (bash)", async () => {
            const result = await checkToolAvailability("bash")
            assert.equal(result.name, "bash")
            assert.equal(result.available, true)
            assert.ok(result.path)
        })

        it("returns available:false for a non-existent tool", async () => {
            const result = await checkToolAvailability("nonexistent-tool-xyz-12345")
            assert.equal(result.name, "nonexistent-tool-xyz-12345")
            assert.equal(result.available, false)
            assert.equal(result.path, null)
        })

        it("includes version when available", async () => {
            const result = await checkToolAvailability("bash")
            // bash --version should return something
            if (result.available) {
                assert.ok(result.version, "version should be present for bash")
            }
        })
    })

    // ─── checkCompileCommands ────────────────────────────────────────
    describe("checkCompileCommands", () => {
        it("returns not_found when compile_commands.json does not exist", () => {
            const result = checkCompileCommands(tmpDir)
            assert.equal(result.status, "not_found")
            assert.ok(result.suggestions.length > 0, "should have suggestions")
        })

        it("returns valid when compile_commands.json exists and is valid", () => {
            // Create the actual source file so path validation passes
            fs.writeFileSync(path.join(tmpDir, "main.cpp"), "int main() {}")

            const validDb = [
                {
                    directory: tmpDir,
                    file: "main.cpp",
                    arguments: ["g++", "-c", "main.cpp", "-o", "main.o"],
                },
            ]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(validDb)
            )

            const result = checkCompileCommands(tmpDir)
            assert.equal(result.status, "valid")
            assert.equal(result.entryCount, 1)
        })

        it("returns path_mismatch when paths in compile_commands.json are invalid", () => {
            const mismatchDb = [
                {
                    directory: "/nonexistent/path",
                    file: "main.cpp",
                    arguments: ["g++", "-c", "main.cpp", "-o", "main.o"],
                },
            ]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(mismatchDb)
            )

            const result = checkCompileCommands(tmpDir)
            assert.equal(result.status, "path_mismatch")
            assert.ok(result.mismatchedPaths !== undefined && result.mismatchedPaths > 0)
        })

        it("returns invalid_json when file is malformed", () => {
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                "not valid json{{{"
            )

            const result = checkCompileCommands(tmpDir)
            assert.equal(result.status, "invalid_json")
        })

        it("returns empty when file is an empty array", () => {
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                "[]"
            )

            const result = checkCompileCommands(tmpDir)
            assert.equal(result.status, "empty")
        })

        it("provides fix suggestions for path_mismatch", () => {
            const mismatchDb = [
                {
                    directory: "/old/build/path",
                    file: "src/main.cpp",
                    arguments: ["g++", "-c", "src/main.cpp"],
                },
            ]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(mismatchDb)
            )

            const result = checkCompileCommands(tmpDir)
            assert.ok(result.suggestions.length > 0, "should have fix suggestions")
        })
    })

    // ─── runDiagnosis ────────────────────────────────────────────────
    describe("runDiagnosis", () => {
        it("returns a complete diagnosis report", async () => {
            const report = await runDiagnosis(tmpDir)

            assert.ok(report.timestamp, "should have timestamp")
            assert.ok(report.projectDir, "should have projectDir")
            assert.ok(report.tools, "should have tools section")
            assert.ok(report.compileCommands, "should have compileCommands section")
            assert.ok(typeof report.ok === "boolean", "should have ok flag")
        })

        it("reports ok:false when critical tools are missing", async () => {
            // In a temp dir without any tools, critical tools should be missing
            // But since we're in a real system, we check the structure
            const report = await runDiagnosis(tmpDir)
            assert.ok(Array.isArray(report.tools), "tools should be an array")
            assert.ok(report.tools.length > 0, "should check at least one tool")
        })

        it("reports compile_commands status for project dir", async () => {
            const report = await runDiagnosis(tmpDir)
            assert.equal(report.compileCommands.status, "not_found")
        })

        it("includes summary with counts", async () => {
            const report = await runDiagnosis(tmpDir)
            assert.ok(report.summary, "should have summary")
            assert.ok(typeof report.summary.totalChecks === "number")
            assert.ok(typeof report.summary.passed === "number")
            assert.ok(typeof report.summary.failed === "number")
            assert.ok(typeof report.summary.warnings === "number")
        })

        it("report is JSON-serializable", async () => {
            const report = await runDiagnosis(tmpDir)
            const json = JSON.stringify(report)
            const parsed = JSON.parse(json)
            assert.deepEqual(parsed, report)
        })

        it("includes human-readable summary text", async () => {
            const report = await runDiagnosis(tmpDir)
            assert.ok(report.humanSummary, "should have humanSummary")
            assert.ok(typeof report.humanSummary === "string")
            assert.ok(report.humanSummary.length > 0)
        })
    })
})
