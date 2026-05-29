import type { Plugin } from "@opencode-ai/plugin"
import { buildSessionContext, formatSessionContext, CTE_METHODOLOGY } from "./lib/hooks/session-lifecycle.js"
import { checkConstraints } from "./lib/hooks/tool-guard.js"
import { buildEnvVars } from "./lib/hooks/env-inject.js"
import { createTools } from "./lib/tools/index.js"
import { getProductStatus, buildAnalysisAdvice } from "./lib/utils/orchestrator.js"

const ANALYSIS_TOOLS = new Set(["cpp-seam-finder", "cpp-scan", "cpp-bigfile-map"])

const ANALYSIS_TOOL_TYPE_MAP: Record<string, string> = {
    "cpp-seam-finder": "seam-finder",
    "cpp-scan": "scan",
    "cpp-bigfile-map": "list-functions",
}

const CPP_REFACTORY_TOOLS = new Set([
    "cpp-scan",
    "cpp-seam-finder",
    "cpp-bigfile-map",
    "cpp-verify-tools",
    "cpp-bootstrap",
    "cpp-characterize",
    "cpp-ast-cache",
    "cpp-diagnose",
    "cpp-pipeline",
    "cpp-quality-gate",
    "cpp-extract",
    "ledger-init",
    "ledger-wave-add",
    "ledger-batch-add",
    "ledger-partition-add",
    "ledger-promote",
    "ledger-status",
    "ledger-list",
])

const server: Plugin = (async (ctx) => {
    const { directory, client } = ctx
    const tools = createTools(directory)

    return {
        // --- Event hook: session lifecycle ---
        event: async (input: { event: { type: string; properties: any } }) => {
            const event = input.event
            if (event.type === "session.created") {
                const sessionCtx = buildSessionContext(directory)
                const message = formatSessionContext(sessionCtx)

                await client.app.log({
                    body: {
                        service: "cpp-refactory",
                        level: sessionCtx.status === "ready" ? "info" : "warn",
                        message,
                    },
                })

                // Inject product status (pipeline + quality + analysis mode)
                try {
                    const productStatus = getProductStatus(directory)
                    if (productStatus.advice.length > 0) {
                        await client.app.log({
                            body: {
                                service: "cpp-refactory",
                                level: "info",
                                message: `[cpp-refactory] 产品状态: 分析模式=${productStatus.analysisMode}(${Math.round(productStatus.analysisConfidence * 100)}%), 流水线=${productStatus.pipelineActive ? productStatus.pipelineStage : "未激活"}, 基线=${productStatus.hasBaseline ? "已记录" : "未记录"}\n建议:\n${productStatus.advice.map(a => `  → ${a}`).join("\n")}`,
                            },
                        })
                    }
                } catch (err: any) {
                    // Non-critical: product status is advisory, but log unexpected errors
                    if (err?.code !== "ENOENT") {
                        await client.app.log({
                            body: {
                                service: "cpp-refactory",
                                level: "warn",
                                message: `[cpp-refactory] Failed to load product status: ${err?.message ?? err}`,
                            },
                        })
                    }
                }
            }

            if (event.type === "session.idle") {
                await client.app.log({
                    body: {
                        service: "cpp-refactory",
                        level: "info",
                        message:
                            "⚠ Session ending — remember to update state/ files and ledger before closing.",
                    },
                })
            }
        },

        // --- System prompt tail: inject CTE methodology ---
        "experimental.chat.system.transform": async (
            _input: { sessionID?: string },
            output: { system: string[] }
        ) => {
            output.system.push(CTE_METHODOLOGY)
        },

        // --- Tool guard: block cpp-refactory tools if not installed ---
        "tool.execute.before": async (
            input: { tool: string },
            output: { args: Record<string, any> }
        ) => {
            // Only guard cpp-refactory tools (except bootstrap/diagnose which initialize)
            if (!CPP_REFACTORY_TOOLS.has(input.tool)) return
            if (input.tool === "cpp-bootstrap" || input.tool === "cpp-diagnose") return

            const result = checkConstraints(directory, input.tool)
            if (!result.allowed) {
                throw new Error(
                    `[cpp-refactory] ${result.reasons.join("; ")}`
                )
            }

            // Log warnings
            for (const warning of result.warnings) {
                await client.app.log({
                    body: {
                        service: "cpp-refactory",
                        level: "warn",
                        message: warning,
                    },
                })
            }

            // Inject AST routing advice for analysis tools
            if (ANALYSIS_TOOLS.has(input.tool) && output.args?.target) {
                try {
                    const toolType = ANALYSIS_TOOL_TYPE_MAP[input.tool] || "seam-finder"
                    const advice = buildAnalysisAdvice(directory, output.args.target, toolType)
                    if (advice.warning) {
                        await client.app.log({
                            body: {
                                service: "cpp-refactory",
                                level: "warn",
                                message: `[AST路由] ${advice.warning}\n  推荐工具: ${advice.recommendedTool} (confidence: ${Math.round(advice.confidence * 100)}%)\n  修复: ${advice.fixSuggestion}`,
                            },
                        })
                    }
                } catch (err: any) {
                    // Non-critical: routing advice is advisory, but log unexpected errors
                    if (err?.code !== "ENOENT") {
                        await client.app.log({
                            body: {
                                service: "cpp-refactory",
                                level: "debug",
                                message: `[cpp-refactory] Analysis advice failed: ${err?.message ?? err}`,
                            },
                        })
                    }
                }
            }
        },

        // --- Shell env injection ---
        "shell.env": async (
            input: { cwd: string },
            output: { env: Record<string, string> }
        ) => {
            const vars = buildEnvVars(input.cwd || directory)
            Object.assign(output.env, vars)
        },

        // --- Custom tools ---
        tool: tools,
    }
}) satisfies Plugin

export default server
