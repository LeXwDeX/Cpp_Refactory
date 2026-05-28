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

        it("routes virtual-calls to AST virtual call analysis", () => {
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

            const decision = routeAnalysisTool("virtual-calls", tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(decision.toolName, "clang_ast_virtual_calls")
            assert.equal(decision.mode, "ast")
        })

        it("routes list-functions to AST list functions", () => {
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

            const decision = routeAnalysisTool("list-functions", tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(decision.toolName, "clang_ast_list_functions")
            assert.equal(decision.mode, "ast")
        })

        it("routes to regex fallback for partial_ast mode", () => {
            // compile_commands.json exists but target file not in it
            fs.writeFileSync(path.join(tmpDir, "other.cpp"), "void other() {}")
            const db = [
                {
                    directory: tmpDir,
                    file: "other.cpp",
                    arguments: ["g++", "-c", "other.cpp"],
                },
            ]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(db)
            )

            const decision = routeAnalysisTool("seam-finder", tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(decision.mode, "partial_ast")
            assert.equal(decision.toolName, "cpp-seam-finder")
            assert.ok(decision.fallbackReason, "should have fallback reason")
        })

        it("handles unknown tool type with cpp- prefix fallback", () => {
            const decision = routeAnalysisTool("custom-analysis", tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(decision.toolName, "cpp-custom-analysis")
            assert.equal(decision.mode, "regex_fallback")
        })

        it("routes list-functions to bigfile-map in regex fallback", () => {
            const decision = routeAnalysisTool("list-functions", tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(decision.toolName, "cpp-bigfile-map")
            assert.equal(decision.mode, "regex_fallback")
        })

        it("determineAnalysisMode returns compileDbPath and entry counts for valid db", () => {
            fs.writeFileSync(path.join(tmpDir, "main.cpp"), "int main() {}")
            const db = [
                {
                    directory: tmpDir,
                    file: "main.cpp",
                    arguments: ["g++", "-c", "main.cpp"],
                },
                {
                    directory: tmpDir,
                    file: "other.cpp",
                    arguments: ["g++", "-c", "other.cpp"],
                },
            ]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(db)
            )

            const result = determineAnalysisMode(tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(result.mode, "ast")
            assert.ok(result.compileDbPath)
            assert.equal(result.totalEntries, 2)
            assert.ok(result.validEntries! >= 1)
        })

        it("determineAnalysisMode returns empty db for empty array", () => {
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                "[]"
            )

            const result = determineAnalysisMode(tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(result.mode, "regex_fallback")
            assert.ok(result.reason!.includes("为空"))
        })

        it("determineAnalysisMode handles non-array JSON (object)", () => {
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify({ not: "an array" })
            )

            const result = determineAnalysisMode(tmpDir, path.join(tmpDir, "main.cpp"))
            assert.equal(result.mode, "regex_fallback")
            assert.ok(result.reason!.includes("无效"))
        })

        it("determineAnalysisMode handles absolute file paths in compile_commands", () => {
            const srcFile = path.join(tmpDir, "main.cpp")
            fs.writeFileSync(srcFile, "int main() {}")

            const db = [
                {
                    directory: tmpDir,
                    file: srcFile, // absolute path
                    arguments: ["g++", "-c", srcFile],
                },
            ]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(db)
            )

            const result = determineAnalysisMode(tmpDir, srcFile)
            assert.equal(result.mode, "ast")
            assert.equal(result.confidence, 1.0)
        })

        it("countValidEntries handles absolute file paths", () => {
            const srcFile = path.join(tmpDir, "main.cpp")
            fs.writeFileSync(srcFile, "int main() {}")
            const missingFile = path.join(tmpDir, "missing.cpp")

            const db = [
                {
                    directory: tmpDir,
                    file: srcFile, // absolute, exists
                    arguments: ["g++", "-c", srcFile],
                },
                {
                    directory: tmpDir,
                    file: missingFile, // absolute, doesn't exist
                    arguments: ["g++", "-c", missingFile],
                },
            ]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(db)
            )

            // Use a file not in the db to trigger partial_ast with countValidEntries
            const otherFile = path.join(tmpDir, "other.cpp")
            fs.writeFileSync(otherFile, "void other() {}")
            const result = determineAnalysisMode(tmpDir, otherFile)
            assert.equal(result.mode, "partial_ast")
            assert.equal(result.totalEntries, 2)
            assert.equal(result.validEntries, 1)
        })
    })
})
