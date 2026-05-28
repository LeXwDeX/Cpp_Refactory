import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import {
    generateRefactorPlan,
    generateCharacterizeSkeleton,
    type RefactorPlan,
    type RefactorTarget,
    type CharacterizeSkeleton,
} from "../../lib/utils/refactor-planner.js"

describe("refactor-planner", () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-planner-test-"))
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    // ─── generateRefactorPlan ────────────────────────────────────────
    describe("generateRefactorPlan", () => {
        it("generates a plan from analysis results", () => {
            const targets: RefactorTarget[] = [
                {
                    file: "src/main.cpp",
                    function: "processData",
                    lineCount: 250,
                    complexity: 15,
                    issue: "god_function",
                    suggestion: "拆分为多个小函数",
                },
                {
                    file: "src/utils.cpp",
                    function: "globalState",
                    lineCount: 0,
                    complexity: 0,
                    issue: "global_variable",
                    suggestion: "封装为类成员或单例",
                },
            ]

            const plan = generateRefactorPlan(targets)

            assert.ok(plan.id)
            assert.ok(plan.timestamp)
            assert.equal(plan.targets.length, 2)
            assert.equal(plan.targets[0].priority, "high")
            assert.ok(plan.summary)
        })

        it("prioritizes high priority issues and sorts by effort within same priority", () => {
            const targets: RefactorTarget[] = [
                {
                    file: "a.cpp",
                    function: "globalVar",
                    lineCount: 0,
                    complexity: 0,
                    issue: "global_variable",
                    suggestion: "封装",
                },
                {
                    file: "b.cpp",
                    function: "bigFunc",
                    lineCount: 500,
                    complexity: 30,
                    issue: "god_function",
                    suggestion: "拆分",
                },
            ]

            const plan = generateRefactorPlan(targets)
            // Both are high priority; global_variable has lower effort so comes first (quick win)
            assert.equal(plan.targets[0].priority, "high")
            assert.equal(plan.targets[1].priority, "high")
            assert.equal(plan.targets[0].issue, "global_variable")
        })

        it("assigns medium priority to macro jungle issues", () => {
            const targets: RefactorTarget[] = [
                {
                    file: "c.cpp",
                    function: "ifdefMess",
                    lineCount: 100,
                    complexity: 5,
                    issue: "macro_jungle",
                    suggestion: "清理 #ifdef",
                },
            ]

            const plan = generateRefactorPlan(targets)
            assert.equal(plan.targets[0].priority, "medium")
        })

        it("generates human-readable summary", () => {
            const targets: RefactorTarget[] = [
                {
                    file: "src/main.cpp",
                    function: "processData",
                    lineCount: 250,
                    complexity: 15,
                    issue: "god_function",
                    suggestion: "拆分",
                },
            ]

            const plan = generateRefactorPlan(targets)
            assert.ok(plan.summary.includes("god_function") || plan.summary.includes("processData"))
        })

        it("estimates effort based on complexity", () => {
            const targets: RefactorTarget[] = [
                {
                    file: "a.cpp",
                    function: "simple",
                    lineCount: 50,
                    complexity: 3,
                    issue: "god_function",
                    suggestion: "拆分",
                },
                {
                    file: "b.cpp",
                    function: "complex",
                    lineCount: 500,
                    complexity: 30,
                    issue: "god_function",
                    suggestion: "拆分",
                },
            ]

            const plan = generateRefactorPlan(targets)
            assert.ok(plan.targets[0].estimatedEffort)
            assert.ok(plan.targets[1].estimatedEffort)
            // Complex function should have higher effort
            assert.ok(plan.targets[1].estimatedEffort! > plan.targets[0].estimatedEffort!)
        })

        it("handles unknown issue types with low priority fallback", () => {
            const targets: RefactorTarget[] = [
                {
                    file: "x.cpp",
                    function: "unknownIssue",
                    lineCount: 100,
                    complexity: 5,
                    issue: "some_new_issue" as any,
                    suggestion: "fix it",
                },
            ]

            const plan = generateRefactorPlan(targets)
            assert.equal(plan.targets[0].priority, "low")
            assert.equal(plan.targets[0].risk, "low")
        })

        it("sorts by effort when same priority", () => {
            const targets: RefactorTarget[] = [
                {
                    file: "a.cpp",
                    function: "bigFunc",
                    lineCount: 500,
                    complexity: 30,
                    issue: "god_function",
                    suggestion: "拆分",
                },
                {
                    file: "b.cpp",
                    function: "smallFunc",
                    lineCount: 50,
                    complexity: 3,
                    issue: "god_function",
                    suggestion: "拆分",
                },
            ]

            const plan = generateRefactorPlan(targets)
            // Same priority (high), smaller effort should come first
            assert.ok(plan.targets[0].estimatedEffort! <= plan.targets[1].estimatedEffort!)
        })

        it("handles empty targets array", () => {
            const plan = generateRefactorPlan([])
            assert.equal(plan.targets.length, 0)
            assert.equal(plan.totalEstimatedEffort, 0)
        })

        it("scales effort for high line count (>300)", () => {
            const targets: RefactorTarget[] = [
                {
                    file: "a.cpp",
                    function: "hugeFunc",
                    lineCount: 400,
                    complexity: 5,
                    issue: "god_function",
                    suggestion: "拆分",
                },
            ]

            const plan = generateRefactorPlan(targets)
            // Base effort for god_function is 2, lineCount > 300 → *1.5 = 3
            assert.ok(plan.targets[0].estimatedEffort! >= 3)
        })

        it("scales effort for high complexity (>20)", () => {
            const targets: RefactorTarget[] = [
                {
                    file: "a.cpp",
                    function: "complexFunc",
                    lineCount: 50,
                    complexity: 25,
                    issue: "god_function",
                    suggestion: "拆分",
                },
            ]

            const plan = generateRefactorPlan(targets)
            // Base effort for god_function is 2, complexity > 20 → *2 = 4
            assert.ok(plan.targets[0].estimatedEffort! >= 4)
        })

        it("scales effort for medium complexity (>10)", () => {
            const targets: RefactorTarget[] = [
                {
                    file: "a.cpp",
                    function: "medFunc",
                    lineCount: 50,
                    complexity: 15,
                    issue: "god_function",
                    suggestion: "拆分",
                },
            ]

            const plan = generateRefactorPlan(targets)
            // Base effort for god_function is 2, complexity > 10 → *1.5 = 3
            assert.ok(plan.targets[0].estimatedEffort! >= 3)
        })

        it("scales effort for medium line count (>100)", () => {
            const targets: RefactorTarget[] = [
                {
                    file: "a.cpp",
                    function: "medFunc",
                    lineCount: 150,
                    complexity: 3,
                    issue: "god_function",
                    suggestion: "拆分",
                },
            ]

            const plan = generateRefactorPlan(targets)
            // Base effort for god_function is 2, lineCount > 100 → *1.2 = 2.4
            assert.ok(plan.targets[0].estimatedEffort! >= 2.4)
        })
    })

    // ─── generateCharacterizeSkeleton ────────────────────────────────
    describe("generateCharacterizeSkeleton", () => {
        it("generates a gtest skeleton for a function", () => {
            const skeleton = generateCharacterizeSkeleton({
                file: "src/main.cpp",
                function: "processData",
                returnType: "int",
                params: ["const std::string& input", "int flags"],
            })

            assert.ok(skeleton.testCode)
            assert.ok(skeleton.testCode.includes("processData"))
            assert.ok(skeleton.testCode.includes("TEST"))
            assert.ok(skeleton.testCode.includes("EXPECT") || skeleton.testCode.includes("ASSERT"))
        })

        it("includes parameter documentation in skeleton", () => {
            const skeleton = generateCharacterizeSkeleton({
                file: "src/utils.cpp",
                function: "calculate",
                returnType: "double",
                params: ["double x", "double y"],
            })

            assert.ok(skeleton.testCode.includes("calculate"))
            assert.ok(skeleton.testCode.includes("double"))
        })

        it("generates multiple test cases for boundary conditions", () => {
            const skeleton = generateCharacterizeSkeleton({
                file: "src/math.cpp",
                function: "divide",
                returnType: "double",
                params: ["double a", "double b"],
            })

            // Should have at least normal + boundary test cases
            const testCount = (skeleton.testCode.match(/TEST/g) || []).length
            assert.ok(testCount >= 2, "should generate at least 2 test cases")
        })

        it("returns the file path for the test", () => {
            const skeleton = generateCharacterizeSkeleton({
                file: "src/main.cpp",
                function: "processData",
                returnType: "void",
                params: [],
            })

            assert.ok(skeleton.testFile)
            assert.ok(skeleton.testFile.includes("processData") || skeleton.testFile.includes("main"))
        })
    })
})
