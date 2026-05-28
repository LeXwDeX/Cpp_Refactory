import type { Plugin } from "@opencode-ai/plugin"
import { buildSessionContext, formatSessionContext } from "./lib/hooks/session-lifecycle.js"
import { checkConstraints } from "./lib/hooks/tool-guard.js"
import { buildEnvVars } from "./lib/hooks/env-inject.js"
import { createTools } from "./lib/tools/index.js"

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
            }

            if (event.type === "session.idle") {
                await client.app.log({
                    body: {
                        service: "cpp-refactory",
                        level: "info",
                        message:
                            "⚠ Session ending — remember to update state/ and evolution/CHANGELOG.md (Constraint #4)",
                    },
                })
            }
        },

        // --- Tool guard: block cpp-refactory tools if not installed ---
        "tool.execute.before": async (
            input: { tool: string },
            output: { args: Record<string, any> }
        ) => {
            // Only guard cpp-refactory tools (except bootstrap which initializes)
            if (!CPP_REFACTORY_TOOLS.has(input.tool)) return
            if (input.tool === "cpp-bootstrap") return

            const result = checkConstraints(directory)
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
