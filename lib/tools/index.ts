import { resolveScriptPath } from "../utils/paths.js"

/**
 * Minimal tool definition interface compatible with @opencode-ai/plugin.
 * We define our own to avoid importing the full plugin package in tests.
 */
export interface ToolDefinition {
    description: string
    args: Record<string, any>
    execute: (args: any, context?: any) => Promise<string>
}

/**
 * Create a shell script tool definition.
 */
function shellTool(
    scriptName: string,
    description: string,
    args: Record<string, any>,
    buildArgs: (args: any, projectDir: string) => string[]
): ToolDefinition {
    return {
        description,
        args,
        async execute(toolArgs: any, context?: any) {
            const scriptPath = resolveScriptPath(scriptName)
            const cmdArgs = buildArgs(toolArgs, context?.directory ?? "")
            const { execFile } = await import("node:child_process")
            const { promisify } = await import("node:util")
            const execFileAsync = promisify(execFile)
            try {
                const { stdout, stderr } = await execFileAsync("bash", [scriptPath, ...cmdArgs], {
                    maxBuffer: 10 * 1024 * 1024,
                    timeout: 300_000,
                })
                return stdout + (stderr ? `\n[stderr] ${stderr}` : "")
            } catch (err: any) {
                const stdout = err.stdout ?? ""
                const stderr = err.stderr ?? ""
                const exitCode = err.code ?? "unknown"
                if (stdout) {
                    return stdout + (stderr ? `\n[stderr] ${stderr}` : "") + `\n[exit code: ${exitCode}]`
                }
                return `[ERROR] Command failed with exit code ${exitCode}\n${stderr}`
            }
        },
    }
}

// Zod-like schema helpers (lightweight, no zod dependency needed)
const schema = {
    string: () => ({ type: "string" as const, _def: { typeName: "ZodString" } }),
    boolean: () => ({ type: "boolean" as const, _def: { typeName: "ZodBoolean" } }),
    optional: (s: any) => ({ ...s, optional: true }),
}

/**
 * Create all cpp_refactory tool definitions.
 */
export function createTools(projectDir: string): Record<string, ToolDefinition> {
    return {
        "cpp-scan": shellTool(
            "cpp-scan.sh",
            "Run this FIRST on any C++ project. " +
            "Why not just grep? Because grep cannot tell you: the ACTUAL C++ standard in use " +
            "(CMakeLists may claim C++17 but code only uses C++11 features), " +
            "which files are the real hotspots by line count, " +
            "the #include dependency graph, or per-file #ifdef density. " +
            "This tool produces a structured 7-section report covering: C++ standard detection, " +
            "file size ranking, god functions (>100 lines), include heat map, " +
            "#ifdef jungle index, code smell metrics (raw new/delete, goto, friend, C-casts), " +
            "and codegraph index status. One call replaces ~20 grep commands. " +
            "CONSTRAINT DISCOVERY: After reviewing the report, save discovered constraints to hindsight " +
            "via the hindsight_retain tool (bank_id is auto-managed per project): C++ standard ceiling, platform-specific flags, " +
            "module boundaries revealed by include patterns, and any 'do not touch' zones.",
            { target: schema.string() },
            (args) => [args.target]
        ),

        "cpp-seam-finder": shellTool(
            "cpp-seam-finder.sh",
            "Find refactoring seams in C++ code across 9 categories. " +
            "Why not just grep? Because grep misses: anonymous-namespace globals, " +
            "class-static members with dynamic initialization (SIOF risk), " +
            "function pointers hidden behind typedefs, Meyer's singletons, " +
            "and the new/delete balance ratio. This tool catches all of those. " +
            "Categories: (1) global variables with linkage classification, " +
            "(2) macro jungles with nesting depth, (3) singletons (getInstance + static local + global ptr), " +
            "(4) raw pointers with new/delete balance check, (5) function pointers and callbacks, " +
            "(6) friend declarations and public data members, (7) dangerous casts (const_cast/reinterpret_cast), " +
            "(8) UB risks (iterator invalidation, dangling refs, uninitialized vars), " +
            "(9) codegraph impact analysis on key symbols if .codegraph index exists. " +
            "NOTE: regex heuristics have ~30% false positive rate. " +
            "Cross-validate with clang_ast_globals MCP tool when compile_commands.json is available. " +
            "CONSTRAINT DISCOVERY: Save architectural constraints to hindsight via the hindsight_retain tool (bank_id is auto-managed per project): " +
            "global state boundaries that must not be crossed, singleton lifecycle requirements, " +
            "memory ownership patterns, and any 'danger zones' revealed by the analysis.",
            { target: schema.string() },
            (args) => [args.target]
        ),

        "cpp-bigfile-map": shellTool(
            "cpp-bigfile-map.sh",
            "For any C++ file >500 lines: DO NOT Read the whole file — you will lose track of structure " +
            "in 50K+ tokens of code. This tool gives you the map instead. " +
            "Generates: (1) paragraph sections with line ranges, (2) complete function index with exact boundaries, " +
            "(3) god function detection, (4) type/class hierarchy, (5) #ifdef regions, " +
            "(6) include list, (7) suggested cut points at function boundaries, " +
            "(8) codegraph caller/callee analysis for top god functions. " +
            "Workflow: run this first → identify the section you need → Read only that section. " +
            "Why not grep for functions? grep counts braces wrong with nested lambdas, " +
            "macros that contain braces, and string literals with braces. " +
            "This tool uses ctags for precise boundaries. " +
            "CONSTRAINT DISCOVERY: Save structural constraints to hindsight via the hindsight_retain tool (bank_id is auto-managed per project): " +
            "god functions that must not be modified without full test coverage, " +
            "critical sections revealed by #ifdef patterns, and module boundaries visible in the section map.",
            { file: schema.string() },
            (args) => [args.file]
        ),

        "cpp-verify-tools": shellTool(
            "verify-tools.sh",
            "Check which analysis tools are installed (clang-tidy, cppcheck, bear, ccache, codegraph, etc). " +
            "Run this to know what's available before planning your analysis strategy. " +
            "Reports PASS/FAIL/SKIP for each tool with version info.",
            { project: schema.optional(schema.string()) },
            (args, dir) => [args.project || dir]
        ),

        "cpp-bootstrap": shellTool(
            "bootstrap-project.sh",
            "Initialize a C++ project for cpp_refactory: creates .cpp_refactory/state/ directory, " +
            "generates/merges opencode.json (plugin + MCP config), checks compile_commands.json, " +
            "runs initial scan. Run this once per project before any other cpp-refactory tool.",
            { project: schema.optional(schema.string()) },
            (args, dir) => [args.project || dir]
        ),

        "cpp-characterize": shellTool(
            "characterize.sh",
            "Generate gtest characterization test skeletons that LOCK existing behavior before refactoring. " +
            "Without characterization tests, you cannot prove your refactor preserved behavior. " +
            "Produces test files with normal-case + boundary + error-handling test stubs.",
            { target: schema.string() },
            (args) => [args.target]
        ),

        "cpp-ast-cache": shellTool(
            "clang-ast-cache.sh",
            "AST disk cache management: stats (view hit/miss counters and disk usage) / " +
            "clean (clear cached .tu files) / list (show cached files). " +
            "Use 'stats' to verify caching is working across MCP sessions.",
            { action: schema.string() },
            (args) => [args.action]
        ),

        // Ledger tools (multi-export)
        "ledger-init": shellTool(
            "ledger.sh",
            "Initialize the three-layer refactoring ledger (Wave/Batch/Partition). " +
            "Run once at project start to create the tracking structure.",
            {},
            () => ["init"]
        ),

        "ledger-wave-add": shellTool(
            "ledger.sh",
            "Create a Wave (campaign-level goal, e.g. 'eliminate global state in module X').",
            { description: schema.string() },
            (args) => ["wave-add", args.description]
        ),

        "ledger-batch-add": shellTool(
            "ledger.sh",
            "Create a Batch (single-session goal) under a Wave.",
            { waveId: schema.string(), description: schema.string() },
            (args) => ["batch-add", args.waveId, args.description]
        ),

        "ledger-partition-add": shellTool(
            "ledger.sh",
            "Create a Partition (smallest execution unit, ~4h work) under a Batch.",
            {
                batchId: schema.string(),
                description: schema.string(),
                risk: schema.string(),
            },
            (args) => ["partition-add", args.batchId, args.description, args.risk]
        ),

        "ledger-promote": shellTool(
            "ledger.sh",
            "Advance partition state: PLANNED→IN_PROGRESS→VERIFIED→DONE.",
            { id: schema.string(), status: schema.string() },
            (args) => ["promote", args.id, args.status]
        ),

        "ledger-status": shellTool(
            "ledger.sh",
            "View current ledger status: all waves, batches, partitions and their states.",
            {},
            () => ["status"]
        ),

        "ledger-list": shellTool(
            "ledger.sh",
            "List all partition details with full history.",
            {},
            () => ["list"]
        ),

        "cpp-diagnose": shellTool(
            "diagnose.sh",
            "One-click environment diagnosis: checks 17 items including toolchain availability, " +
            "compile_commands.json validity and path correctness, Docker/MCP connectivity. " +
            "Returns structured JSON report + human-readable summary with fix suggestions. " +
            "Run this when tools fail or before starting work on a new machine.",
            { project: schema.optional(schema.string()) },
            (args, dir) => [args.project || dir]
        ),

        "cpp-pipeline": shellTool(
            "pipeline-verify.sh",
            "Refactoring pipeline verification: runs compilation + tests + static analysis (clang-tidy, cppcheck) " +
            "on changed files. Returns structured pass/fail result. " +
            "Use after code changes to verify nothing broke before moving to the next partition.",
            {
                project: schema.optional(schema.string()),
                stage: schema.optional(schema.string()),
            },
            (args, dir) => [args.project || dir, args.stage || "verify"]
        ),

        "cpp-quality-gate": shellTool(
            "quality-gate.sh",
            "Incremental quality gate: records a baseline of current warnings/tests/errors, " +
            "then after changes compares and reports ONLY new issues (delta). " +
            "Actions: 'baseline' (record current state), 'check' (compare with baseline), 'status' (show baseline). " +
            "This prevents 'everything is broken' panic on legacy projects with thousands of existing warnings.",
            {
                action: schema.string(),
                project: schema.optional(schema.string()),
            },
            (args, dir) => [args.action, args.project || dir]
        ),

        "cpp-extract": shellTool(
            "cpp-extract.sh",
            "Extract a function from one C++ source file to another. " +
            "Uses ctags to find precise function boundaries (no brace-counting errors). " +
            "Default: dry-run preview — shows the function code, dependency hints, and a diff patch " +
            "WITHOUT modifying any files. Add --apply to actually move the function. " +
            "Workflow: preview first → review the patch → apply → verify compilation. " +
            "Requires Universal Ctags installed (check with cpp-verify-tools).",
            {
                source: schema.string(),
                function: schema.string(),
                target: schema.optional(schema.string()),
                apply: schema.optional(schema.boolean()),
            },
            (args) => {
                const cmdArgs = [args.source, args.function]
                if (args.target) cmdArgs.push("--to", args.target)
                if (args.apply) cmdArgs.push("--apply")
                return cmdArgs
            }
        ),
    }
}
