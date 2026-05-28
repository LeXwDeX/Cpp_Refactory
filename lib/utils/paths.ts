import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Resolve the scripts directory path.
 * In dev: __dirname = <root>/lib/utils -> 2 ups to <root>/scripts
 * In prod (dist): tsup bundles to single dist/index.js, __dirname = <root>/dist -> 1 up to <root>/scripts
 */
export function getScriptsDir(): string {
    // Try dist layout first (tsup single-file bundle: dist/index.js)
    const distCandidate = path.resolve(__dirname, "..", "scripts")
    if (fs.existsSync(distCandidate)) {
        return distCandidate
    }
    // Dev layout (running from lib/utils/paths.ts)
    const devCandidate = path.resolve(__dirname, "..", "..", "scripts")
    if (fs.existsSync(devCandidate)) {
        return devCandidate
    }
    // Fallback: relative to package root
    return path.resolve(__dirname, "..", "scripts")
}

/**
 * Resolve the resources directory path.
 * In dev: __dirname = <root>/lib/utils -> 2 ups to <root>/resources
 * In prod (dist): tsup bundles to single dist/index.js, __dirname = <root>/dist -> 1 up to <root>/resources
 */
export function getResourcesDir(): string {
    // Try dist layout first (tsup single-file bundle: dist/index.js)
    const distCandidate = path.resolve(__dirname, "..", "resources")
    if (fs.existsSync(distCandidate)) {
        return distCandidate
    }
    // Dev layout (running from lib/utils/paths.ts)
    const devCandidate = path.resolve(__dirname, "..", "..", "resources")
    if (fs.existsSync(devCandidate)) {
        return devCandidate
    }
    return path.resolve(__dirname, "..", "resources")
}

/**
 * Resolve a script name to its absolute path.
 * Throws if the script does not exist.
 */
export function resolveScriptPath(scriptName: string): string {
    const scriptsDir = getScriptsDir()
    const scriptPath = path.join(scriptsDir, scriptName)
    if (!fs.existsSync(scriptPath)) {
        throw new Error(`Script not found: ${scriptName} (looked in ${scriptsDir})`)
    }
    return scriptPath
}
