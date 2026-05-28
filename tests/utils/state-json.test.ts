import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import {
    createStateStore,
    loadStateStore,
    renderStateMarkdown,
    type StateStore,
} from "../../lib/utils/state-json.js"

describe("state-json", () => {
    let tmpDir: string
    let stateDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-state-json-test-"))
        stateDir = path.join(tmpDir, ".cpp_refactory", "state")
        fs.mkdirSync(stateDir, { recursive: true })
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    // ─── createStateStore ────────────────────────────────────────────
    describe("createStateStore", () => {
        it("creates a new state store with default values", () => {
            const store = createStateStore(tmpDir)

            assert.ok(store.id)
            assert.equal(store.projectDir, tmpDir)
            assert.ok(store.createdAt)
            assert.ok(store.updatedAt)
            assert.equal(store.refactorPhase, "discovery")
            assert.deepEqual(store.activeGoals, [])
            assert.deepEqual(store.blockers, [])
            assert.deepEqual(store.completedItems, [])
        })

        it("persists to JSON file", () => {
            createStateStore(tmpDir)

            const jsonPath = path.join(stateDir, "PROJECT_STATE.json")
            assert.ok(fs.existsSync(jsonPath))

            const loaded = JSON.parse(fs.readFileSync(jsonPath, "utf-8"))
            assert.equal(loaded.projectDir, tmpDir)
        })
    })

    // ─── loadStateStore ──────────────────────────────────────────────
    describe("loadStateStore", () => {
        it("loads a previously created state store", () => {
            const created = createStateStore(tmpDir)
            const loaded = loadStateStore(tmpDir)

            assert.ok(loaded)
            assert.equal(loaded!.id, created.id)
            assert.equal(loaded!.projectDir, created.projectDir)
        })

        it("returns null when no state store exists", () => {
            const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-empty-"))
            const loaded = loadStateStore(emptyDir)
            assert.equal(loaded, null)
            fs.rmSync(emptyDir, { recursive: true, force: true })
        })
    })

    // ─── renderStateMarkdown ─────────────────────────────────────────
    describe("renderStateMarkdown", () => {
        it("renders state store to Markdown format", () => {
            const store = createStateStore(tmpDir)
            store.refactorPhase = "execution"
            store.activeGoals = ["拆分 processData 函数", "消除全局状态"]
            store.blockers = ["缺少 compile_commands.json"]
            store.completedItems = ["项目扫描完成", "接缝分析完成"]

            const md = renderStateMarkdown(store)

            assert.ok(md.includes("# 重构状态"))
            assert.ok(md.includes("执行阶段") || md.includes("execution"))
            assert.ok(md.includes("拆分 processData"))
            assert.ok(md.includes("消除全局状态"))
            assert.ok(md.includes("缺少 compile_commands"))
            assert.ok(md.includes("项目扫描完成"))
        })

        it("renders empty state gracefully", () => {
            const store = createStateStore(tmpDir)
            const md = renderStateMarkdown(store)

            assert.ok(md.includes("# 重构状态"))
            assert.ok(md.includes("发现阶段") || md.includes("discovery"))
        })

        it("includes timestamp in rendered output", () => {
            const store = createStateStore(tmpDir)
            const md = renderStateMarkdown(store)

            assert.ok(md.includes(store.updatedAt))
        })

        it("renders next steps section", () => {
            const store = createStateStore(tmpDir)
            store.refactorPhase = "planning"
            store.activeGoals = ["生成分区计划"]

            const md = renderStateMarkdown(store)
            assert.ok(md.includes("下一步") || md.includes("Next"))
        })
    })
})
