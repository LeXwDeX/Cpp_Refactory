import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import {
    runBootstrap,
    generateOpenCodeConfig,
    type BootstrapResult,
} from "../../lib/utils/bootstrap.js"

describe("bootstrap-enhanced", () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-bootstrap-test-"))
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    // ─── generateOpenCodeConfig ──────────────────────────────────────
    describe("generateOpenCodeConfig", () => {
        it("generates a valid opencode.json with MCP and plugin config", () => {
            const config = generateOpenCodeConfig(tmpDir)

            assert.ok(config.plugins)
            assert.ok(config.plugins.includes("opencode-cpp-refactory"))
            assert.ok(config.mcp)
            assert.ok(config.mcp["clang-ast-mcp"])
            assert.ok(config.mcp["clang-ast-mcp"].command)
        })

        it("uses docker command for MCP by default", () => {
            const config = generateOpenCodeConfig(tmpDir)
            assert.equal(config.mcp["clang-ast-mcp"].command, "docker")
        })

        it("preserves existing config when merging", () => {
            // Write existing config
            const existing = {
                plugins: ["some-other-plugin"],
                customSetting: true,
            }
            fs.writeFileSync(
                path.join(tmpDir, "opencode.json"),
                JSON.stringify(existing)
            )

            const config = generateOpenCodeConfig(tmpDir)
            assert.ok(config.plugins.includes("some-other-plugin"))
            assert.ok(config.plugins.includes("opencode-cpp-refactory"))
            assert.equal(config.customSetting, true)
        })

        it("does not overwrite existing MCP config for clang-ast-mcp", () => {
            const existing = {
                mcp: {
                    "clang-ast-mcp": {
                        command: "custom-command",
                        args: ["--custom"],
                    },
                },
            }
            fs.writeFileSync(
                path.join(tmpDir, "opencode.json"),
                JSON.stringify(existing)
            )

            const config = generateOpenCodeConfig(tmpDir)
            assert.equal(config.mcp["clang-ast-mcp"].command, "custom-command")
        })
    })

    // ─── runBootstrap ────────────────────────────────────────────────
    describe("runBootstrap", () => {
        it("creates .cpp_refactory/state directory structure", () => {
            const result = runBootstrap(tmpDir)

            const stateDir = path.join(tmpDir, ".cpp_refactory", "state")
            assert.ok(fs.existsSync(stateDir), "state directory should exist")
            assert.ok(result.created.includes("state/"))
        })

        it("generates opencode.json if missing", () => {
            const result = runBootstrap(tmpDir)

            const configPath = path.join(tmpDir, "opencode.json")
            assert.ok(fs.existsSync(configPath), "opencode.json should be created")

            const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
            assert.ok(config.plugins.includes("opencode-cpp-refactory"))
            assert.ok(config.mcp["clang-ast-mcp"])
        })

        it("does not overwrite existing opencode.json plugin config", () => {
            const existing = {
                plugins: ["my-plugin"],
                mcp: { "clang-ast-mcp": { command: "my-cmd", args: [] } },
            }
            fs.writeFileSync(
                path.join(tmpDir, "opencode.json"),
                JSON.stringify(existing)
            )

            runBootstrap(tmpDir)

            const config = JSON.parse(
                fs.readFileSync(path.join(tmpDir, "opencode.json"), "utf-8")
            )
            assert.ok(config.plugins.includes("my-plugin"))
            assert.equal(config.mcp["clang-ast-mcp"].command, "my-cmd")
        })

        it("returns structured result with created/skipped/warnings", () => {
            const result = runBootstrap(tmpDir)

            assert.ok(Array.isArray(result.created))
            assert.ok(Array.isArray(result.skipped))
            assert.ok(Array.isArray(result.warnings))
            assert.ok(Array.isArray(result.nextSteps))
            assert.ok(result.projectDir)
        })

        it("includes compile_commands.json advice in next steps", () => {
            const result = runBootstrap(tmpDir)
            assert.ok(
                result.nextSteps.some(s => s.includes("compile_commands")),
                "should advise about compile_commands.json"
            )
        })

        it("includes diagnose suggestion in next steps", () => {
            const result = runBootstrap(tmpDir)
            assert.ok(
                result.nextSteps.some(s => s.includes("diagnose")),
                "should suggest running diagnose"
            )
        })

        it("is idempotent (running twice does not duplicate)", () => {
            runBootstrap(tmpDir)
            const result2 = runBootstrap(tmpDir)

            // Second run should skip everything
            assert.ok(result2.skipped.length > 0, "second run should skip existing items")
        })

        it("detects compile_commands.json and reports status", () => {
            const result = runBootstrap(tmpDir)
            assert.ok(
                result.warnings.some(w => w.includes("compile_commands")),
                "should warn about missing compile_commands.json"
            )

            // Create compile_commands.json and run again
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify([{ directory: tmpDir, file: "a.cpp", arguments: ["g++", "-c", "a.cpp"] }])
            )
            const result2 = runBootstrap(tmpDir)
            assert.ok(
                !result2.warnings.some(w => w.includes("compile_commands.json 不存在")),
                "should not warn when compile_commands.json exists"
            )
        })

        it("handles invalid JSON in existing opencode.json", () => {
            fs.writeFileSync(
                path.join(tmpDir, "opencode.json"),
                "not valid json{{{"
            )

            const result = runBootstrap(tmpDir)
            // Should still create a valid config
            const config = JSON.parse(
                fs.readFileSync(path.join(tmpDir, "opencode.json"), "utf-8")
            )
            assert.ok(config.plugins.includes("opencode-cpp-refactory"))
        })

        it("warns about empty compile_commands.json", () => {
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                "[]"
            )

            const result = runBootstrap(tmpDir)
            assert.ok(
                result.warnings.some(w => w.includes("为空")),
                "should warn about empty compile_commands.json"
            )
        })

        it("warns about invalid compile_commands.json", () => {
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                "not valid json{{{"
            )

            const result = runBootstrap(tmpDir)
            assert.ok(
                result.warnings.some(w => w.includes("格式无效")),
                "should warn about invalid compile_commands.json"
            )
        })

        it("skips writing opencode.json when content unchanged", () => {
            // First run creates the config
            runBootstrap(tmpDir)

            // Read the file and note its content
            const content1 = fs.readFileSync(path.join(tmpDir, "opencode.json"), "utf-8")

            // Second run should not change the file
            const result2 = runBootstrap(tmpDir)
            const content2 = fs.readFileSync(path.join(tmpDir, "opencode.json"), "utf-8")

            assert.equal(content1, content2, "file content should be unchanged")
            assert.ok(
                result2.skipped.some(s => s.includes("配置无变化")),
                "should report config unchanged"
            )
        })
    })
})
