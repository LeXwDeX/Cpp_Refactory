import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// Import the plugin factory directly
import pluginFactory from "../index.js"

describe("plugin integration", () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-refactory-integration-"))
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it("plugin factory is a function", () => {
        assert.equal(typeof pluginFactory, "function")
    })

    it("plugin factory returns object with hooks and tools", async () => {
        // Simulate the plugin context that OpenCode provides
        const mockCtx = {
            project: { id: "test-project" },
            client: {
                app: { log: async () => true },
                session: { prompt: async () => ({}) },
            },
            $: async () => ({ stdout: "", exitCode: 0 }),
            directory: tmpDir,
            worktree: tmpDir,
        }

        const result = await pluginFactory(mockCtx as any)

        // Should have event hook
        assert.ok(result.event, "should have event hook")
        assert.equal(typeof result.event, "function")

        // Should have tool.execute.before hook
        assert.ok(result["tool.execute.before"], "should have tool.execute.before hook")
        assert.equal(typeof result["tool.execute.before"], "function")

        // Should have shell.env hook
        assert.ok(result["shell.env"], "should have shell.env hook")
        assert.equal(typeof result["shell.env"], "function")

        // Should have tools
        assert.ok(result.tool, "should have tool definitions")
        assert.ok(result.tool["cpp-scan"], "should have cpp-scan tool")
        assert.ok(result.tool["cpp-bootstrap"], "should have cpp-bootstrap tool")
        assert.ok(result.tool["ledger-init"], "should have ledger-init tool")
    })

    it("event hook handles session.created for uninitialized project", async () => {
        const logs: string[] = []
        const mockCtx = {
            project: { id: "test" },
            client: {
                app: { log: async (input: any) => { logs.push(input.body?.message ?? ""); return true } },
                session: { prompt: async () => ({}) },
            },
            $: async () => ({ stdout: "", exitCode: 0 }),
            directory: tmpDir,
            worktree: tmpDir,
        }

        const result = await pluginFactory(mockCtx as any)
        await (result.event as Function)({
            event: { type: "session.created", properties: { id: "sess-1" } },
        })

        // Should log that cpp_refactory is not installed
        assert.ok(logs.some((l) => l.includes("not installed") || l.includes("bootstrap")))
    })

    it("shell.env hook injects CPP_REFACTORY_ROOT", async () => {
        const mockCtx = {
            project: { id: "test" },
            client: { app: { log: async () => true }, session: { prompt: async () => ({}) } },
            $: async () => ({ stdout: "", exitCode: 0 }),
            directory: tmpDir,
            worktree: tmpDir,
        }

        const result = await pluginFactory(mockCtx as any)
        const input = { cwd: tmpDir }
        const output = { env: {} as Record<string, string> }
        await (result["shell.env"] as Function)(input, output)

        assert.ok(output.env.CPP_REFACTORY_ROOT)
        assert.ok(output.env.CPP_REFACTORY_ROOT.includes(".cpp_refactory"))
    })

    it("tool.execute.before blocks when cpp_refactory not installed", async () => {
        const mockCtx = {
            project: { id: "test" },
            client: { app: { log: async () => true }, session: { prompt: async () => ({}) } },
            $: async () => ({ stdout: "", exitCode: 0 }),
            directory: tmpDir,
            worktree: tmpDir,
        }

        const result = await pluginFactory(mockCtx as any)

        // Should throw when trying to use a cpp-refactory tool without installation
        await assert.rejects(
            async () => {
                await (result["tool.execute.before"] as Function)(
                    { tool: "cpp-scan", sessionID: "s1", callID: "c1" },
                    { args: { target: "." } }
                )
            },
            { message: /not installed|bootstrap/ }
        )
    })

    it("tool.execute.before skips non-cpp-refactory tools", async () => {
        const mockCtx = {
            project: { id: "test" },
            client: { app: { log: async () => true }, session: { prompt: async () => ({}) } },
            $: async () => ({ stdout: "", exitCode: 0 }),
            directory: tmpDir,
            worktree: tmpDir,
        }

        const result = await pluginFactory(mockCtx as any)

        // Should NOT throw for non-cpp-refactory tools
        await (result["tool.execute.before"] as Function)(
            { tool: "some-other-tool", sessionID: "s1", callID: "c1" },
            { args: {} }
        )
    })

    it("tool.execute.before skips cpp-bootstrap (allowed without install)", async () => {
        const mockCtx = {
            project: { id: "test" },
            client: { app: { log: async () => true }, session: { prompt: async () => ({}) } },
            $: async () => ({ stdout: "", exitCode: 0 }),
            directory: tmpDir,
            worktree: tmpDir,
        }

        const result = await pluginFactory(mockCtx as any)

        // Should NOT throw for bootstrap
        await (result["tool.execute.before"] as Function)(
            { tool: "cpp-bootstrap", sessionID: "s1", callID: "c1" },
            { args: {} }
        )
    })

    it("tool.execute.before skips cpp-diagnose (allowed without install)", async () => {
        const mockCtx = {
            project: { id: "test" },
            client: { app: { log: async () => true }, session: { prompt: async () => ({}) } },
            $: async () => ({ stdout: "", exitCode: 0 }),
            directory: tmpDir,
            worktree: tmpDir,
        }

        const result = await pluginFactory(mockCtx as any)

        // Should NOT throw for diagnose
        await (result["tool.execute.before"] as Function)(
            { tool: "cpp-diagnose", sessionID: "s1", callID: "c1" },
            { args: {} }
        )
    })

    it("tool.execute.before allows cpp-scan when state exists and logs warnings", async () => {
        // Create state directory so checkConstraints passes
        const stateDir = path.join(tmpDir, ".cpp_refactory", "state")
        fs.mkdirSync(stateDir, { recursive: true })
        fs.writeFileSync(path.join(stateDir, "REFACTOR_STATE.md"), "# State")
        fs.writeFileSync(path.join(stateDir, "PARTITION_LEDGER.md"), "# Ledger")
        // Write TOOL_GAPS with an OPEN gap to trigger warning
        fs.writeFileSync(path.join(stateDir, "TOOL_GAPS.md"), "### GAP-001\n状态: OPEN\n")

        const logs: any[] = []
        const mockCtx = {
            project: { id: "test" },
            client: {
                app: { log: async (input: any) => { logs.push(input.body); return true } },
                session: { prompt: async () => ({}) },
            },
            $: async () => ({ stdout: "", exitCode: 0 }),
            directory: tmpDir,
            worktree: tmpDir,
        }

        const result = await pluginFactory(mockCtx as any)

        // Should NOT throw since state exists
        await (result["tool.execute.before"] as Function)(
            { tool: "cpp-scan", sessionID: "s1", callID: "c1" },
            { args: { target: "." } }
        )

        // Should have logged a warning about open tool gaps
        assert.ok(logs.some(l => l.level === "warn" && l.message.includes("open tool gap")))
    })

    it("tool.execute.before provides AST routing advice for analysis tools", async () => {
        // Create state directory
        const stateDir = path.join(tmpDir, ".cpp_refactory", "state")
        fs.mkdirSync(stateDir, { recursive: true })
        fs.writeFileSync(path.join(stateDir, "REFACTOR_STATE.md"), "# State")
        fs.writeFileSync(path.join(stateDir, "PARTITION_LEDGER.md"), "# Ledger")
        fs.writeFileSync(path.join(stateDir, "TOOL_GAPS.md"), "# Gaps")

        const logs: any[] = []
        const mockCtx = {
            project: { id: "test" },
            client: {
                app: { log: async (input: any) => { logs.push(input.body); return true } },
                session: { prompt: async () => ({}) },
            },
            $: async () => ({ stdout: "", exitCode: 0 }),
            directory: tmpDir,
            worktree: tmpDir,
        }

        const result = await pluginFactory(mockCtx as any)

        // Call with an analysis tool and target — no compile_commands.json → should warn about regex fallback
        await (result["tool.execute.before"] as Function)(
            { tool: "cpp-seam-finder", sessionID: "s1", callID: "c1" },
            { args: { target: path.join(tmpDir, "main.cpp") } }
        )

        // Should have logged AST routing warning about regex fallback
        assert.ok(logs.some(l => l.level === "warn" && l.message.includes("AST路由")))
    })

    it("tool.execute.before skips AST advice for non-analysis tools", async () => {
        const stateDir = path.join(tmpDir, ".cpp_refactory", "state")
        fs.mkdirSync(stateDir, { recursive: true })
        fs.writeFileSync(path.join(stateDir, "REFACTOR_STATE.md"), "# State")
        fs.writeFileSync(path.join(stateDir, "PARTITION_LEDGER.md"), "# Ledger")
        fs.writeFileSync(path.join(stateDir, "TOOL_GAPS.md"), "# Gaps")

        const logs: any[] = []
        const mockCtx = {
            project: { id: "test" },
            client: {
                app: { log: async (input: any) => { logs.push(input.body); return true } },
                session: { prompt: async () => ({}) },
            },
            $: async () => ({ stdout: "", exitCode: 0 }),
            directory: tmpDir,
            worktree: tmpDir,
        }

        const result = await pluginFactory(mockCtx as any)

        // cpp-characterize is NOT an analysis tool
        await (result["tool.execute.before"] as Function)(
            { tool: "cpp-characterize", sessionID: "s1", callID: "c1" },
            { args: { target: "." } }
        )

        // Should NOT have AST routing log
        assert.ok(!logs.some(l => l.message?.includes("AST路由")))
    })

    it("event hook handles session.idle", async () => {
        const logs: any[] = []
        const mockCtx = {
            project: { id: "test" },
            client: {
                app: { log: async (input: any) => { logs.push(input.body); return true } },
                session: { prompt: async () => ({}) },
            },
            $: async () => ({ stdout: "", exitCode: 0 }),
            directory: tmpDir,
            worktree: tmpDir,
        }

        const result = await pluginFactory(mockCtx as any)
        await (result.event as Function)({
            event: { type: "session.idle", properties: {} },
        })

        assert.ok(logs.some(l => l.message.includes("Session ending")))
    })

    it("event hook ignores unknown event types", async () => {
        const logs: any[] = []
        const mockCtx = {
            project: { id: "test" },
            client: {
                app: { log: async (input: any) => { logs.push(input.body); return true } },
                session: { prompt: async () => ({}) },
            },
            $: async () => ({ stdout: "", exitCode: 0 }),
            directory: tmpDir,
            worktree: tmpDir,
        }

        const result = await pluginFactory(mockCtx as any)
        // Should not throw
        await (result.event as Function)({
            event: { type: "unknown.event", properties: {} },
        })
    })

    it("shell.env hook handles empty cwd (falls back to directory)", async () => {
        const mockCtx = {
            project: { id: "test" },
            client: { app: { log: async () => true }, session: { prompt: async () => ({}) } },
            $: async () => ({ stdout: "", exitCode: 0 }),
            directory: tmpDir,
            worktree: tmpDir,
        }

        const result = await pluginFactory(mockCtx as any)
        const input = { cwd: "" }
        const output = { env: {} as Record<string, string> }
        await (result["shell.env"] as Function)(input, output)

        assert.ok(output.env.CPP_REFACTORY_ROOT)
    })

    it("event hook session.created logs product status advice for initialized project", async () => {
        // Create state so it's "ready"
        const stateDir = path.join(tmpDir, ".cpp_refactory", "state")
        fs.mkdirSync(stateDir, { recursive: true })
        fs.writeFileSync(path.join(stateDir, "REFACTOR_STATE.md"), "# State")
        fs.writeFileSync(path.join(stateDir, "PARTITION_LEDGER.md"), "# Ledger")
        fs.writeFileSync(path.join(stateDir, "TOOL_GAPS.md"), "# Gaps")

        const logs: any[] = []
        const mockCtx = {
            project: { id: "test" },
            client: {
                app: { log: async (input: any) => { logs.push(input.body); return true } },
                session: { prompt: async () => ({}) },
            },
            $: async () => ({ stdout: "", exitCode: 0 }),
            directory: tmpDir,
            worktree: tmpDir,
        }

        const result = await pluginFactory(mockCtx as any)
        await (result.event as Function)({
            event: { type: "session.created", properties: { id: "sess-2" } },
        })

        // Should log product status with analysis mode info
        assert.ok(logs.some(l => l.message?.includes("产品状态") || l.message?.includes("分析模式")))
    })
})
