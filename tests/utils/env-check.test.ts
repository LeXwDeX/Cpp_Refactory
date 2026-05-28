import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { checkTool, checkEnvironment, type ToolCheckResult } from "../../lib/utils/env-check.js"

describe("env-check", () => {
    describe("checkTool", () => {
        it("returns available for a known tool (node)", async () => {
            const result = await checkTool("node")
            assert.equal(result.available, true)
            assert.ok(result.path)
        })

        it("returns unavailable for a nonexistent tool", async () => {
            const result = await checkTool("definitely-not-a-real-tool-xyz")
            assert.equal(result.available, false)
            assert.equal(result.path, null)
        })

        it("extracts version string for tools that support --version", async () => {
            const result = await checkTool("node")
            assert.equal(result.available, true)
            // node --version returns something like "v20.x.x"
            assert.ok(result.version, "version should be present for node")
            assert.ok(result.version!.length > 0)
        })

        it("handles tools where --version fails gracefully", async () => {
            // 'which' exists but 'which --version' may not produce useful output
            const result = await checkTool("which")
            assert.equal(result.available, true)
            // version may or may not be present, but should not throw
        })

        it("returns version as undefined for unavailable tools", async () => {
            const result = await checkTool("definitely-not-a-real-tool-xyz")
            assert.equal(result.available, false)
            assert.equal(result.version, undefined)
        })
    })

    describe("checkEnvironment", () => {
        it("returns an array of tool check results", async () => {
            const results = await checkEnvironment()
            assert.ok(Array.isArray(results))
            assert.ok(results.length > 0)
        })

        it("checks all expected tools", async () => {
            const results = await checkEnvironment()
            const names = results.map(r => r.name)
            assert.ok(names.includes("rg"), "should check rg")
            assert.ok(names.includes("cmake"), "should check cmake")
        })

        it("each result has correct shape", async () => {
            const results = await checkEnvironment()
            for (const result of results) {
                assert.ok(typeof result.name === "string")
                assert.ok(typeof result.available === "boolean")
                assert.ok(result.path === null || typeof result.path === "string")
            }
        })
    })

    describe("ToolCheckResult type", () => {
        it("has correct shape", () => {
            const result: ToolCheckResult = {
                name: "test",
                available: true,
                path: "/usr/bin/test",
                version: "1.0",
            }
            assert.equal(result.name, "test")
            assert.equal(result.available, true)
        })
    })
})
