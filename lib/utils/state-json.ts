import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

// ─── Types ───────────────────────────────────────────────────────────

export type RefactorPhase =
    | "discovery"
    | "planning"
    | "execution"
    | "verification"
    | "completed"

export interface StateStore {
    id: string
    projectDir: string
    createdAt: string
    updatedAt: string
    refactorPhase: RefactorPhase
    activeGoals: string[]
    blockers: string[]
    completedItems: string[]
    metrics: {
        totalFiles: number
        analyzedFiles: number
        refactorTargets: number
        completedTargets: number
    }
}

const STATE_FILE = "PROJECT_STATE.json"

// ─── State Store Creation ────────────────────────────────────────────

/**
 * Create a new state store for a project.
 * JSON is the source of truth; Markdown is rendered from it.
 */
export function createStateStore(projectDir: string): StateStore {
    const normalizedDir = path.resolve(projectDir)
    const now = new Date().toISOString()

    const store: StateStore = {
        id: crypto.randomUUID(),
        projectDir: normalizedDir,
        createdAt: now,
        updatedAt: now,
        refactorPhase: "discovery",
        activeGoals: [],
        blockers: [],
        completedItems: [],
        metrics: {
            totalFiles: 0,
            analyzedFiles: 0,
            refactorTargets: 0,
            completedTargets: 0,
        },
    }

    saveStateStore(normalizedDir, store)
    return store
}

// ─── State Store Loading ─────────────────────────────────────────────

/**
 * Load state store from disk.
 * Returns null if no state store exists.
 */
export function loadStateStore(projectDir: string): StateStore | null {
    const filePath = getStateFilePath(path.resolve(projectDir))

    if (!fs.existsSync(filePath)) {
        return null
    }

    try {
        const content = fs.readFileSync(filePath, "utf-8")
        return JSON.parse(content) as StateStore
    } catch {
        return null
    }
}

// ─── Markdown Rendering ─────────────────────────────────────────────

/**
 * Render state store to Markdown format.
 * Markdown is a VIEW of the JSON state, not the source of truth.
 */
export function renderStateMarkdown(store: StateStore): string {
    const lines: string[] = []

    lines.push("# 重构状态")
    lines.push("")
    lines.push(`> 自动生成于 ${store.updatedAt} — 请勿手动编辑`)
    lines.push(`> 数据源: .cpp_refactory/state/PROJECT_STATE.json`)
    lines.push("")

    // Phase
    const phaseLabels: Record<RefactorPhase, string> = {
        discovery: "🔍 发现阶段",
        planning: "📋 计划阶段",
        execution: "🔧 执行阶段",
        verification: "✅ 验证阶段",
        completed: "🎉 已完成",
    }
    lines.push(`## 当前阶段: ${phaseLabels[store.refactorPhase]}`)
    lines.push("")

    // Metrics
    lines.push("## 指标")
    lines.push("")
    lines.push(`| 指标 | 值 |`)
    lines.push(`|---|---|`)
    lines.push(`| 总文件数 | ${store.metrics.totalFiles} |`)
    lines.push(`| 已分析 | ${store.metrics.analyzedFiles} |`)
    lines.push(`| 重构目标 | ${store.metrics.refactorTargets} |`)
    lines.push(`| 已完成 | ${store.metrics.completedTargets} |`)
    lines.push("")

    // Active Goals
    if (store.activeGoals.length > 0) {
        lines.push("## 当前目标")
        lines.push("")
        for (const goal of store.activeGoals) {
            lines.push(`- [ ] ${goal}`)
        }
        lines.push("")
    }

    // Blockers
    if (store.blockers.length > 0) {
        lines.push("## 阻塞项")
        lines.push("")
        for (const blocker of store.blockers) {
            lines.push(`- ⚠ ${blocker}`)
        }
        lines.push("")
    }

    // Completed Items
    if (store.completedItems.length > 0) {
        lines.push("## 已完成")
        lines.push("")
        for (const item of store.completedItems) {
            lines.push(`- [x] ${item}`)
        }
        lines.push("")
    }

    // Next Steps
    lines.push("## 下一步")
    lines.push("")
    const nextSteps = getNextSteps(store.refactorPhase)
    for (let i = 0; i < nextSteps.length; i++) {
        lines.push(`${i + 1}. ${nextSteps[i]}`)
    }
    lines.push("")

    lines.push("---")
    lines.push(`*ID: ${store.id} | 创建: ${store.createdAt} | 更新: ${store.updatedAt}*`)

    return lines.join("\n")
}

// ─── Helpers ─────────────────────────────────────────────────────────

function getStateFilePath(projectDir: string): string {
    return path.join(projectDir, ".cpp_refactory", "state", STATE_FILE)
}

function saveStateStore(projectDir: string, store: StateStore): void {
    const filePath = getStateFilePath(projectDir)
    const dir = path.dirname(filePath)

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8")
}

function getNextSteps(phase: RefactorPhase): string[] {
    switch (phase) {
        case "discovery":
            return [
                "运行 cpp-diagnose 检测环境",
                "运行 cpp-scan 扫描项目结构",
                "生成 compile_commands.json",
            ]
        case "planning":
            return [
                "运行 cpp-seam-finder 发现接缝",
                "生成分区计划 (PARTITION_LEDGER)",
                "记录质量基线 (cpp-quality-gate baseline)",
            ]
        case "execution":
            return [
                "使用 cpp-characterize 生成特征化测试",
                "执行小步改造",
                "运行 cpp-pipeline verify 验证",
            ]
        case "verification":
            return [
                "运行增量质量门禁",
                "确认零回归",
                "更新状态并进入下一批次",
            ]
        case "completed":
            return ["所有重构目标已完成 🎉"]
    }
}
