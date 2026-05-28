import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

// ─── Types ───────────────────────────────────────────────────────────

export interface WarningCounts {
    clangTidy: number
    cppcheck: number
    [key: string]: number
}

export interface TestStatus {
    total: number
    passed: number
    failed: number
}

export interface CompilationStatus {
    errors: number
    warnings: number
}

export interface QualityMetrics {
    warnings: WarningCounts
    tests: TestStatus
    compilation: CompilationStatus
}

export interface QualityBaseline {
    id: string
    projectDir: string
    timestamp: string
    metrics: QualityMetrics
}

export interface QualityDelta {
    hasBaseline: boolean
    baselineTimestamp: string | null
    warningsDelta: Record<string, number>
    newErrors: number
    testRegressions: number
    passed: boolean
    details: string[]
}

export interface QualityThresholds {
    maxNewWarnings: number
    maxNewErrors: number
    allowTestRegressions: boolean
}

const DEFAULT_THRESHOLDS: QualityThresholds = {
    maxNewWarnings: 0,
    maxNewErrors: 0,
    allowTestRegressions: false,
}

const BASELINE_FILE = "QUALITY_BASELINE.json"

// ─── C++ File Extensions ─────────────────────────────────────────────

const CPP_EXTENSIONS = new Set([
    ".cpp", ".cc", ".cxx", ".c",
    ".h", ".hpp", ".hxx", ".hh",
    ".ipp", ".inl",
])

// ─── Baseline Recording ──────────────────────────────────────────────

/**
 * Record a quality baseline for a project.
 * Captures current warning counts, test status, and compilation status.
 */
export function recordBaseline(
    projectDir: string,
    metrics: QualityMetrics
): QualityBaseline {
    const normalizedDir = path.resolve(projectDir)
    const baseline: QualityBaseline = {
        id: crypto.randomUUID(),
        projectDir: normalizedDir,
        timestamp: new Date().toISOString(),
        metrics,
    }

    saveBaseline(normalizedDir, baseline)
    return baseline
}

// ─── Baseline Loading ────────────────────────────────────────────────

/**
 * Load a previously recorded quality baseline.
 * Returns null if no baseline exists.
 */
export function loadBaseline(projectDir: string): QualityBaseline | null {
    const filePath = getBaselineFilePath(path.resolve(projectDir))

    if (!fs.existsSync(filePath)) {
        return null
    }

    try {
        const content = fs.readFileSync(filePath, "utf-8")
        return JSON.parse(content) as QualityBaseline
    } catch {
        return null
    }
}

// ─── Delta Comparison ─────────────────────────────────────────────────

/**
 * Compare current quality metrics against the baseline.
 * Returns a delta report showing new warnings, errors, and test regressions.
 */
export function compareWithBaseline(
    projectDir: string,
    currentMetrics: QualityMetrics,
    thresholds: Partial<QualityThresholds> = {}
): QualityDelta {
    const mergedThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds }
    const baseline = loadBaseline(projectDir)

    if (!baseline) {
        // No baseline: everything is "new"
        const warningsDelta: Record<string, number> = {}
        for (const [key, value] of Object.entries(currentMetrics.warnings)) {
            warningsDelta[key] = value
        }

        return {
            hasBaseline: false,
            baselineTimestamp: null,
            warningsDelta,
            newErrors: currentMetrics.compilation.errors,
            testRegressions: currentMetrics.tests.failed,
            passed: currentMetrics.compilation.errors === 0 && currentMetrics.tests.failed === 0,
            details: ["无 baseline 记录，所有指标视为新增"],
        }
    }

    // Calculate warnings delta
    const warningsDelta: Record<string, number> = {}
    const details: string[] = []

    for (const [key, currentValue] of Object.entries(currentMetrics.warnings)) {
        const baselineValue = baseline.metrics.warnings[key] ?? 0
        const delta = currentValue - baselineValue
        warningsDelta[key] = delta

        if (delta > 0) {
            details.push(`${key}: +${delta} 新增警告 (${baselineValue} → ${currentValue})`)
        } else if (delta < 0) {
            details.push(`${key}: ${delta} 减少 (${baselineValue} → ${currentValue})`)
        }
    }

    // Calculate new errors
    const newErrors = Math.max(
        0,
        currentMetrics.compilation.errors - baseline.metrics.compilation.errors
    )
    if (newErrors > 0) {
        details.push(`编译错误: +${newErrors} 新增`)
    }

    // Calculate test regressions
    const testRegressions = Math.max(
        0,
        currentMetrics.tests.failed - baseline.metrics.tests.failed
    )
    if (testRegressions > 0) {
        details.push(`测试回归: +${testRegressions} 新增失败`)
    }

    // Determine pass/fail
    const totalNewWarnings = Object.values(warningsDelta).reduce(
        (sum, d) => sum + Math.max(0, d),
        0
    )

    const passed =
        totalNewWarnings <= mergedThresholds.maxNewWarnings &&
        newErrors <= mergedThresholds.maxNewErrors &&
        (mergedThresholds.allowTestRegressions || testRegressions === 0)

    return {
        hasBaseline: true,
        baselineTimestamp: baseline.timestamp,
        warningsDelta,
        newErrors,
        testRegressions,
        passed,
        details,
    }
}

// ─── Affected Files Detection ────────────────────────────────────────

/**
 * Filter a list of files to only C++ source/header files.
 * If no file list is provided, returns empty array (git integration needed).
 */
export function getAffectedFiles(
    projectDir: string,
    files?: string[]
): string[] {
    if (!files || files.length === 0) {
        return []
    }

    return files.filter((f) => {
        const ext = path.extname(f).toLowerCase()
        return CPP_EXTENSIONS.has(ext)
    })
}

// ─── Persistence ─────────────────────────────────────────────────────

function getBaselineFilePath(projectDir: string): string {
    return path.join(projectDir, ".cpp_refactory", "state", BASELINE_FILE)
}

function saveBaseline(projectDir: string, baseline: QualityBaseline): void {
    const filePath = getBaselineFilePath(projectDir)
    const dir = path.dirname(filePath)

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(filePath, JSON.stringify(baseline, null, 2), "utf-8")
}
