import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import {
    determineAnalysisMode,
    routeAnalysisTool,
    type AnalysisMode,
    type RoutingDecision,
} from "../../lib/utils/analysis-router.js"

describe("analysis-router", () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-router-test-"))
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    // ─── determineAnalysisMode ───────────────────────────────────────
    describe("determineAnalysisMode", () => {
        it("returns 'ast' when compile_commands.json exists and target file has entry", () => {
            // Create source file
            fs.writeFileSync(path.join(tmpDir, "main.cpp"), "int main() {}")

            // Create valid compile_commands.json
            const db = [
                {
                    directory: tmpDir,
                    file: "main.cpp",
                    arguments: ["g++", "-c", "main.cpp", "-o", "main.o"],
                },
            ]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(db)
            )

            const result = determineAnalysisMode(tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(result.mode, "ast")
            assert.equal(result.confidence, 1.0)
            assert.equal(result.reason, undefined)
        })

        it("returns 'regex_fallback' when compile_commands.json does not exist", () => {
            const result = determineAnalysisMode(tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(result.mode, "regex_fallback")
            assert.ok(result.confidence < 1.0)
            assert.ok(result.reason, "should have degradation reason")
            assert.ok(result.reason!.includes("compile_commands.json"))
        })

        it("returns 'partial_ast' when compile_commands.json exists but target file has no entry", () => {
            // Create source files
            fs.writeFileSync(path.join(tmpDir, "main.cpp"), "int main() {}")
            fs.writeFileSync(path.join(tmpDir, "other.cpp"), "void other() {}")

            // Create compile_commands.json without the target file (main.cpp)
            const db = [
                {
                    directory: tmpDir,
                    file: "other.cpp",
                    arguments: ["g++", "-c", "other.cpp", "-o", "other.o"],
                },
            ]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(db)
            )

            const result = determineAnalysisMode(tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(result.mode, "partial_ast")
            assert.ok(result.confidence > 0 && result.confidence < 1.0)
            assert.ok(result.missingFiles, "should list missing files")
        })

        it("returns 'regex_fallback' when compile_commands.json is invalid", () => {
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                "not valid json"
            )

            const result = determineAnalysisMode(tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(result.mode, "regex_fallback")
            assert.ok(result.reason)
        })

        it("handles relative file paths in compile_commands.json", () => {
            // Create source file in subdirectory
            const srcDir = path.join(tmpDir, "src")
            fs.mkdirSync(srcDir)
            fs.writeFileSync(path.join(srcDir, "main.cpp"), "int main() {}")

            const db = [
                {
                    directory: tmpDir,
                    file: "src/main.cpp",
                    arguments: ["g++", "-c", "src/main.cpp", "-o", "main.o"],
                },
            ]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(db)
            )

            const result = determineAnalysisMode(tmpDir, path.join(srcDir, "main.cpp"))
            assert.equal(result.mode, "ast")
        })
    })

    // ─── routeAnalysisTool ───────────────────────────────────────────
    describe("routeAnalysisTool", () => {
        it("routes seam-finder to MCP AST when compile_commands.json available", () => {
            fs.writeFileSync(path.join(tmpDir, "main.cpp"), "int main() {}")
            const db = [
                {
                    directory: tmpDir,
                    file: "main.cpp",
                    arguments: ["g++", "-c", "main.cpp"],
                },
            ]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(db)
            )

            const decision = routeAnalysisTool("seam-finder", tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(decision.toolName, "clang_ast_globals")
            assert.equal(decision.mode, "ast")
            assert.ok(decision.description.includes("AST"))
        })

        it("routes seam-finder to regex when compile_commands.json unavailable", () => {
            const decision = routeAnalysisTool("seam-finder", tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(decision.toolName, "cpp-seam-finder")
            assert.equal(decision.mode, "regex_fallback")
            assert.ok(decision.description.includes("正则") || decision.description.includes("regex"))
        })

        it("routes scan to AST-enhanced scan when available", () => {
            fs.writeFileSync(path.join(tmpDir, "main.cpp"), "int main() {}")
            const db = [
                {
                    directory: tmpDir,
                    file: "main.cpp",
                    arguments: ["g++", "-c", "main.cpp"],
                },
            ]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(db)
            )

            const decision = routeAnalysisTool("scan", tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(decision.mode, "ast")
            assert.ok(decision.enhancedTools.length > 0, "should list enhanced tools")
        })

        it("includes confidence score in routing decision", () => {
            const decision = routeAnalysisTool("seam-finder", tmpDir, path.join(tmpDir, "main.cpp"))
            assert.ok(typeof decision.confidence === "number")
            assert.ok(decision.confidence >= 0 && decision.confidence <= 1)
        })

        it("includes fallback chain in routing decision", () => {
            const decision = routeAnalysisTool("seam-finder", tmpDir, path.join(tmpDir, "main.cpp"))
            assert.ok(decision.fallbackChain, "should have fallback chain")
            assert.ok(decision.fallbackChain.length >= 1)
        })

        it("routes macro-jungle to AST macro analysis when available", () => {
            fs.writeFileSync(path.join(tmpDir, "main.cpp"), "int main() {}")
            const db = [
                {
                    directory: tmpDir,
                    file: "main.cpp",
                    arguments: ["g++", "-c", "main.cpp"],
                },
            ]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(db)
            )

            const decision = routeAnalysisTool("macro-jungle", tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(decision.toolName, "clang_ast_macro_jungle")
            assert.equal(decision.mode, "ast")
        })
    })
})
