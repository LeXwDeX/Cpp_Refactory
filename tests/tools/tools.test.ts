import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createTools } from "../../lib/tools/index.js"

describe("tools", () => {
    const tools = createTools("/tmp/test-project")

    describe("createTools", () => {
        it("returns an object with all expected tools", () => {
            assert.ok(tools["cpp-scan"])
            assert.ok(tools["cpp-seam-finder"])
            assert.ok(tools["cpp-bigfile-map"])
            assert.ok(tools["cpp-verify-tools"])
            assert.ok(tools["cpp-bootstrap"])
            assert.ok(tools["cpp-characterize"])
            assert.ok(tools["cpp-ast-cache"])
            assert.ok(tools["cpp-extract"])
            assert.ok(tools["ledger-init"])
            assert.ok(tools["ledger-wave-add"])
            assert.ok(tools["ledger-batch-add"])
            assert.ok(tools["ledger-partition-add"])
            assert.ok(tools["ledger-promote"])
            assert.ok(tools["ledger-status"])
            assert.ok(tools["ledger-list"])
        })
    })

    describe("tool shapes", () => {
        it("cpp-scan has description and args", () => {
            const tool = tools["cpp-scan"]
            assert.ok(tool.description)
            assert.ok(tool.args)
            assert.ok(tool.args.target)
            assert.ok(typeof tool.execute === "function")
        })

        it("cpp-seam-finder has description and args", () => {
            const tool = tools["cpp-seam-finder"]
            assert.ok(tool.description)
            assert.ok(tool.args.target)
            assert.ok(typeof tool.execute === "function")
        })

        it("cpp-bigfile-map has description and args", () => {
            const tool = tools["cpp-bigfile-map"]
            assert.ok(tool.description)
            assert.ok(tool.args.file)
            assert.ok(typeof tool.execute === "function")
        })

        it("ledger-init has description and no required args", () => {
            const tool = tools["ledger-init"]
            assert.ok(tool.description)
            assert.ok(typeof tool.execute === "function")
        })

        it("ledger-wave-add has description arg", () => {
            const tool = tools["ledger-wave-add"]
            assert.ok(tool.description)
            assert.ok(tool.args.description)
            assert.ok(typeof tool.execute === "function")
        })

        it("ledger-promote has id and status args", () => {
            const tool = tools["ledger-promote"]
            assert.ok(tool.args.id)
            assert.ok(tool.args.status)
            assert.ok(typeof tool.execute === "function")
        })

        it("cpp-bootstrap has description", () => {
            const tool = tools["cpp-bootstrap"]
            assert.ok(tool.description)
            assert.ok(typeof tool.execute === "function")
        })

        it("cpp-extract has source, function args and optional target/apply", () => {
            const tool = tools["cpp-extract"]
            assert.ok(tool.description)
            assert.ok(tool.args.source)
            assert.ok(tool.args.function)
            assert.ok(tool.args.target)
            assert.ok(tool.args.target.optional)
            assert.ok(tool.args.apply)
            assert.ok(tool.args.apply.optional)
            assert.ok(typeof tool.execute === "function")
        })
    })
})
