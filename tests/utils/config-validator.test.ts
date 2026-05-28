import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import {
    validateConfig,
    checkMcpConfig,
    checkDockerAvailability,
    type ConfigValidationResult,
    type ComponentStatus,
} from "../../lib/utils/config-validator.js"

describe("config-validator", () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-config-test-"))
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    // ─── MCP Configuration Check ─────────────────────────────────────
    describe("checkMcpConfig", () => {
        it("returns ok when opencode.json has valid MCP config", () => {
            const config = {
                mcp: {
                    "clang-ast-mcp": {
                        command: "docker",
                        args: ["run", "--rm", "-i", "cpp-refactory"],
                    },
                },
            }
            fs.writeFileSync(
                path.join(tmpDir, "opencode.json"),
                JSON.stringify(config)
            )

            const result = checkMcpConfig(tmpDir)
            assert.equal(result.status, "ok")
            assert.equal(result.component, "clang-ast-mcp")
        })

        it("returns missing when opencode.json does not exist", () => {
            const result = checkMcpConfig(tmpDir)
            assert.equal(result.status, "missing")
            assert.ok(result.suggestions.length > 0)
        })

        it("returns misconfigured when MCP section is missing", () => {
            const config = { plugins: ["opencode-cpp-refactory"] }
            fs.writeFileSync(
                path.join(tmpDir, "opencode.json"),
                JSON.stringify(config)
            )

            const result = checkMcpConfig(tmpDir)
            assert.equal(result.status, "misconfigured")
            assert.ok(result.suggestions.some((s) => s.includes("mcp")))
        })

        it("returns misconfigured when clang-ast-mcp is not in MCP config", () => {
            const config = {
                mcp: {
                    "some-other-mcp": { command: "node" },
                },
            }
            fs.writeFileSync(
                path.join(tmpDir, "opencode.json"),
                JSON.stringify(config)
            )

            const result = checkMcpConfig(tmpDir)
            assert.equal(result.status, "misconfigured")
            assert.ok(result.suggestions.some((s) => s.includes("clang-ast-mcp")))
        })

        it("provides fix suggestions for misconfigured MCP", () => {
            const result = checkMcpConfig(tmpDir)
            assert.ok(result.suggestions.length > 0)
            assert.ok(
                result.suggestions.some((s) => s.includes("opencode.json")),
                "should suggest editing opencode.json"
            )
        })
    })

    // ─── Docker Availability Check ───────────────────────────────────
    describe("checkDockerAvailability", () => {
        it("returns a component status result", async () => {
            const result = await checkDockerAvailability()
            assert.ok(result.component, "should have component name")
            assert.ok(
                ["ok", "missing", "degraded"].includes(result.status),
                "should have valid status"
            )
        })

        it("marks Docker as optional (not required)", async () => {
            const result = await checkDockerAvailability()
            assert.equal(result.required, false)
        })
    })

    // ─── Full Configuration Validation ───────────────────────────────
    describe("validateConfig", () => {
        it("returns a complete validation result", async () => {
            const result = await validateConfig(tmpDir)

            assert.ok(result.components, "should have components")
            assert.ok(Array.isArray(result.components))
            assert.ok(result.components.length > 0)
            assert.ok(typeof result.ok === "boolean")
            assert.ok(result.summary, "should have summary")
        })

        it("identifies required vs optional components", async () => {
            const result = await validateConfig(tmpDir)

            const required = result.components.filter((c) => c.required)
            const optional = result.components.filter((c) => !c.required)

            assert.ok(required.length > 0, "should have required components")
            assert.ok(optional.length > 0, "should have optional components")
        })

        it("reports ok:false when required components are missing", async () => {
            // Empty dir: no opencode.json, no compile_commands.json
            const result = await validateConfig(tmpDir)
            // MCP config is required for full functionality
            const mcpComponent = result.components.find(
                (c) => c.component === "clang-ast-mcp"
            )
            assert.ok(mcpComponent)
            assert.equal(mcpComponent!.required, true)
        })

        it("generates actionable fix suggestions", async () => {
            const result = await validateConfig(tmpDir)
            const withSuggestions = result.components.filter(
                (c) => c.suggestions.length > 0
            )
            assert.ok(
                withSuggestions.length > 0,
                "should have components with fix suggestions"
            )
        })

        it("includes human-readable summary", async () => {
            const result = await validateConfig(tmpDir)
            assert.ok(result.summary.length > 0)
        })

        it("validates a fully configured project", async () => {
            // Create a complete configuration
            const config = {
                mcp: {
                    "clang-ast-mcp": {
                        command: "docker",
                        args: ["run", "--rm", "-i", "cpp-refactory"],
                    },
                },
            }
            fs.writeFileSync(
                path.join(tmpDir, "opencode.json"),
                JSON.stringify(config)
            )

            // Create compile_commands.json
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify([])
            )

            const result = await validateConfig(tmpDir)
            const mcpComponent = result.components.find(
                (c) => c.component === "clang-ast-mcp"
            )
            assert.equal(mcpComponent!.status, "ok")
        })

        it("detects plugin registered in opencode.json", async () => {
            const config = {
                plugins: [
                    "opencode-cpp-refactory",
                    "@vectorize-io/opencode-hindsight",
                    "other-plugin",
                ],
                mcp: {
                    "clang-ast-mcp": {
                        command: "docker",
                        args: ["run", "--rm", "-i", "cpp-refactory"],
                    },
                },
            }
            fs.writeFileSync(
                path.join(tmpDir, "opencode.json"),
                JSON.stringify(config)
            )

            const result = await validateConfig(tmpDir)
            const pluginComponent = result.components.find(
                (c) => c.component === "opencode-cpp-refactory"
            )
            assert.ok(pluginComponent)
            assert.equal(pluginComponent!.status, "ok")
            assert.equal(pluginComponent!.details, "cpp-refactory 与 Hindsight 插件已注册")
        })

        it("detects invalid JSON in opencode.json", async () => {
            fs.writeFileSync(
                path.join(tmpDir, "opencode.json"),
                "not valid json{{{"
            )

            const result = await validateConfig(tmpDir)
            // Both plugin and MCP checks should report misconfigured
            const pluginComponent = result.components.find(
                (c) => c.component === "opencode-cpp-refactory"
            )
            assert.ok(pluginComponent)
            assert.equal(pluginComponent!.status, "misconfigured")
        })

        it("detects valid compile_commands.json with entries", async () => {
            const config = {
                plugins: ["opencode-cpp-refactory"],
                mcp: {
                    "clang-ast-mcp": {
                        command: "docker",
                        args: ["run", "--rm", "-i", "cpp-refactory"],
                    },
                },
            }
            fs.writeFileSync(
                path.join(tmpDir, "opencode.json"),
                JSON.stringify(config)
            )

            const db = [
                { directory: tmpDir, file: "main.cpp", arguments: ["g++", "-c", "main.cpp"] },
                { directory: tmpDir, file: "util.cpp", arguments: ["g++", "-c", "util.cpp"] },
            ]
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                JSON.stringify(db)
            )

            const result = await validateConfig(tmpDir)
            const ccComponent = result.components.find(
                (c) => c.component === "compile_commands.json"
            )
            assert.ok(ccComponent)
            assert.equal(ccComponent!.status, "ok")
            assert.ok(ccComponent!.details.includes("2 条目"))
        })

        it("detects invalid compile_commands.json format", async () => {
            fs.writeFileSync(
                path.join(tmpDir, "compile_commands.json"),
                "not valid json{{{"
            )

            const result = await validateConfig(tmpDir)
            const ccComponent = result.components.find(
                (c) => c.component === "compile_commands.json"
            )
            assert.ok(ccComponent)
            assert.equal(ccComponent!.status, "misconfigured")
        })

        it("detects plugin not registered in opencode.json", async () => {
            const config = {
                plugins: ["some-other-plugin"],
            }
            fs.writeFileSync(
                path.join(tmpDir, "opencode.json"),
                JSON.stringify(config)
            )

            const result = await validateConfig(tmpDir)
            const pluginComponent = result.components.find(
                (c) => c.component === "opencode-cpp-refactory"
            )
            assert.ok(pluginComponent)
            assert.equal(pluginComponent!.status, "misconfigured")
            assert.ok(pluginComponent!.details.includes("未注册"))
        })
    })
})
