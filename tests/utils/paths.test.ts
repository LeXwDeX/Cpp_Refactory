import { describe, it } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"
import { resolveScriptPath, getScriptsDir, getResourcesDir } from "../../lib/utils/paths.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, "..", "..")

describe("paths", () => {
    describe("getScriptsDir", () => {
        it("returns absolute path to scripts directory", () => {
            const dir = getScriptsDir()
            assert.ok(path.isAbsolute(dir))
            assert.ok(dir.endsWith("scripts"))
        })

        it("returns existing directory with known scripts", () => {
            const dir = getScriptsDir()
            assert.ok(fs.existsSync(dir))
            assert.ok(fs.existsSync(path.join(dir, "cpp-scan.sh")))
            assert.ok(fs.existsSync(path.join(dir, "ledger.sh")))
        })
    })

    describe("getResourcesDir", () => {
        it("returns absolute path to resources directory", () => {
            const dir = getResourcesDir()
            assert.ok(path.isAbsolute(dir))
            assert.ok(dir.endsWith("resources"))
        })

        it("returns existing directory", () => {
            const dir = getResourcesDir()
            assert.ok(fs.existsSync(dir))
        })
    })

    describe("resolveScriptPath", () => {
        it("resolves a known script name to absolute path", () => {
            const p = resolveScriptPath("cpp-scan.sh")
            assert.ok(path.isAbsolute(p))
            assert.ok(p.endsWith("cpp-scan.sh"))
        })

        it("resolves another known script", () => {
            const p = resolveScriptPath("ledger.sh")
            assert.ok(p.endsWith("ledger.sh"))
        })

        it("throws for unknown script name", () => {
            assert.throws(() => resolveScriptPath("nonexistent.sh"), {
                message: /not found/,
            })
        })
    })

    describe("dist mode (tsup bundle)", () => {
        it("dist __dirname resolves to project root scripts", () => {
            const distIndex = path.join(projectRoot, "dist", "index.js")
            if (!fs.existsSync(distIndex)) {
                // Skip if dist not built
                return
            }
            // Verify the path logic directly: dist/index.js __dirname = <root>/dist
            // 1 up from dist = <root>/scripts should exist
            const distDir = path.join(projectRoot, "dist")
            const scriptsFromDist = path.resolve(distDir, "..", "scripts")
            assert.ok(fs.existsSync(scriptsFromDist), `scripts should exist at ${scriptsFromDist}`)
            assert.ok(
                fs.existsSync(path.join(scriptsFromDist, "cpp-scan.sh")),
                "cpp-scan.sh should exist in scripts resolved from dist"
            )
        })

        it("dist __dirname resolves to project root resources", () => {
            const distIndex = path.join(projectRoot, "dist", "index.js")
            if (!fs.existsSync(distIndex)) {
                return
            }
            const distDir = path.join(projectRoot, "dist")
            const resourcesFromDist = path.resolve(distDir, "..", "resources")
            assert.ok(fs.existsSync(resourcesFromDist), `resources should exist at ${resourcesFromDist}`)
        })

        it("dist plugin can be imported without errors", () => {
            const distIndex = path.join(projectRoot, "dist", "index.js")
            if (!fs.existsSync(distIndex)) {
                return
            }
            // Verify the plugin can be imported (path resolution happens at runtime)
            const result = execSync(
                `node --input-type=module -e "
                    import plugin from './dist/index.js';
                    console.log(JSON.stringify({ ok: typeof plugin === 'function' }));
                "`,
                { cwd: projectRoot, encoding: "utf-8" }
            ).trim()
            const parsed = JSON.parse(result)
            assert.ok(parsed.ok, "plugin should be importable as a function")
        })
    })
})
