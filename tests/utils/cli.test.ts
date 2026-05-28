import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import {
    parseCliArgs,
    executeCliCommand,
    type CliArgs,
} from "../../lib/utils/cli.js"

describe("cli", () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-cli-test-"))
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    // ─── parseCliArgs ────────────────────────────────────────────────
    describe("parseCliArgs", () => {
        it("parses 'diagnose' command", () => {
            const args = parseCliArgs(["diagnose"])
            assert.equal(args.command, "diagnose")
            assert.equal(args.project, ".")
        })

        it("parses 'diagnose /path/to/project'", () => {
            const args = parseCliArgs(["diagnose", "/path/to/project"])
            assert.equal(args.command, "diagnose")
            assert.equal(args.project, "/path/to/project")
        })

        it("parses 'init' command", () => {
            const args = parseCliArgs(["init"])
            assert.equal(args.command, "init")
        })

        it("parses 'status' command", () => {
            const args = parseCliArgs(["status"])
            assert.equal(args.command, "status")
        })

        it("parses 'verify' command", () => {
            const args = parseCliArgs(["verify"])
            assert.equal(args.command, "verify")
        })

        it("parses --json flag", () => {
            const args = parseCliArgs(["diagnose", "--json"])
            assert.equal(args.json, true)
        })

        it("parses --help flag", () => {
            const args = parseCliArgs(["--help"])
            assert.equal(args.help, true)
        })

        it("defaults to help when no command given", () => {
            const args = parseCliArgs([])
            assert.equal(args.help, true)
        })

        it("rejects unknown commands", () => {
            assert.throws(() => parseCliArgs(["unknown"]), /unknown command/i)
        })
    })

    // ─── executeCliCommand ─────────────────────────────────────────
    describe("executeCliCommand", () => {
        it("executes 'init' and creates project structure", async () => {
            const result = await executeCliCommand({
                command: "init",
                project: tmpDir,
                json: false,
                help: false,
            })

            assert.equal(result.exitCode, 0)
            assert.ok(result.output.includes("opencode.json") || result.output.includes("state"))
            assert.ok(fs.existsSync(path.join(tmpDir, ".cpp_refactory", "state")))
        })

        it("executes 'status' and returns product status", async () => {
            const result = await executeCliCommand({
                command: "status",
                project: tmpDir,
                json: false,
                help: false,
            })

            assert.equal(result.exitCode, 0)
            assert.ok(result.output.includes("分析模式") || result.output.includes("analysis"))
        })

        it("executes 'status --json' and returns valid JSON", async () => {
            const result = await executeCliCommand({
                command: "status",
                project: tmpDir,
                json: true,
                help: false,
            })

            assert.equal(result.exitCode, 0)
            const parsed = JSON.parse(result.output)
            assert.ok(parsed.projectDir)
            assert.ok(parsed.analysisMode)
        })

        it("executes 'diagnose' and returns diagnosis report", async () => {
            const result = await executeCliCommand({
                command: "diagnose",
                project: tmpDir,
                json: false,
                help: false,
            })

            // exitCode may be 0 or 1 depending on tool availability
            assert.ok([0, 1].includes(result.exitCode))
            assert.ok(result.output.length > 0)
        })

        it("executes 'diagnose --json' and returns valid JSON", async () => {
            const result = await executeCliCommand({
                command: "diagnose",
                project: tmpDir,
                json: true,
                help: false,
            })

            // exitCode may be 0 or 1 depending on tool availability
            assert.ok([0, 1].includes(result.exitCode))
            const parsed = JSON.parse(result.output)
            assert.ok(parsed.tools)
            assert.ok(parsed.compileCommands)
        })

        it("returns help text when help flag is set", async () => {
            const result = await executeCliCommand({
                command: "diagnose",
                project: tmpDir,
                json: false,
                help: true,
            })

            assert.equal(result.exitCode, 0)
            assert.ok(result.output.includes("cpp-refactory"))
            assert.ok(result.output.includes("diagnose"))
            assert.ok(result.output.includes("init"))
            assert.ok(result.output.includes("status"))
        })

        it("verify without baseline returns error", async () => {
            const result = await executeCliCommand({
                command: "verify",
                project: tmpDir,
                json: false,
                help: false,
            })

            assert.equal(result.exitCode, 1)
            assert.ok(result.output.includes("baseline"))
        })

        it("verify --json without baseline returns JSON error", async () => {
            const result = await executeCliCommand({
                command: "verify",
                project: tmpDir,
                json: true,
                help: false,
            })

            assert.equal(result.exitCode, 1)
            const parsed = JSON.parse(result.output)
            assert.equal(parsed.ok, false)
            assert.ok(parsed.error)
        })

        it("verify with baseline returns success", async () => {
            // Create baseline
            const stateDir = path.join(tmpDir, ".cpp_refactory", "state")
            fs.mkdirSync(stateDir, { recursive: true })
            const baseline = {
                id: "test",
                projectDir: tmpDir,
                timestamp: new Date().toISOString(),
                metrics: {
                    warnings: { clangTidy: 0, cppcheck: 0 },
                    tests: { total: 0, passed: 0, failed: 0 },
                    compilation: { errors: 0, warnings: 0 },
                },
            }
            fs.writeFileSync(
                path.join(stateDir, "QUALITY_BASELINE.json"),
                JSON.stringify(baseline)
            )

            const result = await executeCliCommand({
                command: "verify",
                project: tmpDir,
                json: false,
                help: false,
            })

            assert.equal(result.exitCode, 0)
            assert.ok(result.output.includes("基线已记录"))
        })

        it("verify --json with baseline returns JSON success", async () => {
            const stateDir = path.join(tmpDir, ".cpp_refactory", "state")
            fs.mkdirSync(stateDir, { recursive: true })
            const baseline = {
                id: "test",
                projectDir: tmpDir,
                timestamp: new Date().toISOString(),
                metrics: {
                    warnings: { clangTidy: 0, cppcheck: 0 },
                    tests: { total: 0, passed: 0, failed: 0 },
                    compilation: { errors: 0, warnings: 0 },
                },
            }
            fs.writeFileSync(
                path.join(stateDir, "QUALITY_BASELINE.json"),
                JSON.stringify(baseline)
            )

            const result = await executeCliCommand({
                command: "verify",
                project: tmpDir,
                json: true,
                help: false,
            })

            assert.equal(result.exitCode, 0)
            const parsed = JSON.parse(result.output)
            assert.equal(parsed.ok, true)
            assert.equal(parsed.hasBaseline, true)
        })

        it("init --json returns structured result", async () => {
            const result = await executeCliCommand({
                command: "init",
                project: tmpDir,
                json: true,
                help: false,
            })

            assert.equal(result.exitCode, 0)
            const parsed = JSON.parse(result.output)
            assert.ok(parsed.projectDir)
            assert.ok(Array.isArray(parsed.created))
            assert.ok(Array.isArray(parsed.nextSteps))
        })
    })
})
