import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import {
    recordBaseline,
    loadBaseline,
    compareWithBaseline,
    getAffectedFiles,
    type QualityBaseline,
    type QualityDelta,
} from "../../lib/utils/quality-gate.js"

describe("quality-gate", () => {
    let tmpDir: string
    let stateDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-quality-test-"))
        stateDir = path.join(tmpDir, ".cpp_refactory", "state")
        fs.mkdirSync(stateDir, { recursive: true })
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    // ─── Baseline Recording ──────────────────────────────────────────
    describe("recordBaseline", () => {
        it("records a baseline with warning counts and test status", () => {
            const baseline = recordBaseline(tmpDir, {
                warnings: { clangTidy: 5, cppcheck: 2 },
                tests: { total: 10, passed: 10, failed: 0 },
                compilation: { errors: 0, warnings: 3 },
            })

            assert.ok(baseline.id, "should have ID")
            assert.ok(baseline.timestamp, "should have timestamp")
            assert.equal(baseline.projectDir, tmpDir)
            assert.equal(baseline.metrics.warnings.clangTidy, 5)
            assert.equal(baseline.metrics.warnings.cppcheck, 2)
            assert.equal(baseline.metrics.tests.total, 10)
        })

        it("persists baseline to disk", () => {
            recordBaseline(tmpDir, {
                warnings: { clangTidy: 0, cppcheck: 0 },
                tests: { total: 0, passed: 0, failed: 0 },
                compilation: { errors: 0, warnings: 0 },
            })

            const baselineFile = path.join(stateDir, "QUALITY_BASELINE.json")
            assert.ok(fs.existsSync(baselineFile), "baseline file should exist")
        })

        it("overwrites previous baseline", () => {
            recordBaseline(tmpDir, {
                warnings: { clangTidy: 5, cppcheck: 2 },
                tests: { total: 10, passed: 10, failed: 0 },
                compilation: { errors: 0, warnings: 3 },
            })

            const updated = recordBaseline(tmpDir, {
                warnings: { clangTidy: 3, cppcheck: 1 },
                tests: { total: 12, passed: 12, failed: 0 },
                compilation: { errors: 0, warnings: 1 },
            })

            assert.equal(updated.metrics.warnings.clangTidy, 3)
            assert.equal(updated.metrics.tests.total, 12)
        })
    })

    // ─── Baseline Loading ────────────────────────────────────────────
    describe("loadBaseline", () => {
        it("loads a previously recorded baseline", () => {
            recordBaseline(tmpDir, {
                warnings: { clangTidy: 5, cppcheck: 2 },
                tests: { total: 10, passed: 10, failed: 0 },
                compilation: { errors: 0, warnings: 3 },
            })

            const loaded = loadBaseline(tmpDir)
            assert.ok(loaded)
            assert.equal(loaded!.metrics.warnings.clangTidy, 5)
            assert.equal(loaded!.metrics.tests.total, 10)
        })

        it("returns null when no baseline exists", () => {
            const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-empty-"))
            const loaded = loadBaseline(emptyDir)
            assert.equal(loaded, null)
            fs.rmSync(emptyDir, { recursive: true, force: true })
        })
    })

    // ─── Delta Comparison ────────────────────────────────────────────
    describe("compareWithBaseline", () => {
        it("reports zero delta when current matches baseline", () => {
            recordBaseline(tmpDir, {
                warnings: { clangTidy: 5, cppcheck: 2 },
                tests: { total: 10, passed: 10, failed: 0 },
                compilation: { errors: 0, warnings: 3 },
            })

            const delta = compareWithBaseline(tmpDir, {
                warnings: { clangTidy: 5, cppcheck: 2 },
                tests: { total: 10, passed: 10, failed: 0 },
                compilation: { errors: 0, warnings: 3 },
            })

            assert.equal(delta.warningsDelta.clangTidy, 0)
            assert.equal(delta.warningsDelta.cppcheck, 0)
            assert.equal(delta.newErrors, 0)
            assert.equal(delta.passed, true)
        })

        it("detects new warnings", () => {
            recordBaseline(tmpDir, {
                warnings: { clangTidy: 5, cppcheck: 2 },
                tests: { total: 10, passed: 10, failed: 0 },
                compilation: { errors: 0, warnings: 3 },
            })

            const delta = compareWithBaseline(tmpDir, {
                warnings: { clangTidy: 8, cppcheck: 2 },
                tests: { total: 10, passed: 10, failed: 0 },
                compilation: { errors: 0, warnings: 3 },
            })

            assert.equal(delta.warningsDelta.clangTidy, 3)
            assert.equal(delta.warningsDelta.cppcheck, 0)
            assert.equal(delta.passed, false)
        })

        it("detects new compilation errors", () => {
            recordBaseline(tmpDir, {
                warnings: { clangTidy: 0, cppcheck: 0 },
                tests: { total: 10, passed: 10, failed: 0 },
                compilation: { errors: 0, warnings: 0 },
            })

            const delta = compareWithBaseline(tmpDir, {
                warnings: { clangTidy: 0, cppcheck: 0 },
                tests: { total: 10, passed: 10, failed: 0 },
                compilation: { errors: 2, warnings: 0 },
            })

            assert.equal(delta.newErrors, 2)
            assert.equal(delta.passed, false)
        })

        it("detects test regressions", () => {
            recordBaseline(tmpDir, {
                warnings: { clangTidy: 0, cppcheck: 0 },
                tests: { total: 10, passed: 10, failed: 0 },
                compilation: { errors: 0, warnings: 0 },
            })

            const delta = compareWithBaseline(tmpDir, {
                warnings: { clangTidy: 0, cppcheck: 0 },
                tests: { total: 10, passed: 8, failed: 2 },
                compilation: { errors: 0, warnings: 0 },
            })

            assert.equal(delta.testRegressions, 2)
            assert.equal(delta.passed, false)
        })

        it("supports custom thresholds (allow N new warnings)", () => {
            recordBaseline(tmpDir, {
                warnings: { clangTidy: 5, cppcheck: 2 },
                tests: { total: 10, passed: 10, failed: 0 },
                compilation: { errors: 0, warnings: 3 },
            })

            const delta = compareWithBaseline(
                tmpDir,
                {
                    warnings: { clangTidy: 7, cppcheck: 2 },
                    tests: { total: 10, passed: 10, failed: 0 },
                    compilation: { errors: 0, warnings: 3 },
                },
                { maxNewWarnings: 5 }
            )

            assert.equal(delta.warningsDelta.clangTidy, 2)
            assert.equal(delta.passed, true) // within threshold
        })

        it("returns delta with no baseline as all-new", () => {
            const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-empty-"))
            const delta = compareWithBaseline(emptyDir, {
                warnings: { clangTidy: 3, cppcheck: 1 },
                tests: { total: 5, passed: 5, failed: 0 },
                compilation: { errors: 0, warnings: 2 },
            })

            assert.equal(delta.warningsDelta.clangTidy, 3)
            assert.equal(delta.warningsDelta.cppcheck, 1)
            assert.equal(delta.hasBaseline, false)
            fs.rmSync(emptyDir, { recursive: true, force: true })
        })
    })

    // ─── Affected Files Detection ────────────────────────────────────
    describe("getAffectedFiles", () => {
        it("returns empty array when not in a git repo", () => {
            const files = getAffectedFiles(tmpDir)
            assert.ok(Array.isArray(files))
            assert.equal(files.length, 0)
        })

        it("returns C++ source files from a list", () => {
            const allFiles = [
                "src/main.cpp",
                "src/utils.h",
                "README.md",
                "src/core.cc",
                "package.json",
                "include/types.hpp",
            ]

            const cppFiles = getAffectedFiles(tmpDir, allFiles)
            assert.equal(cppFiles.length, 4)
            assert.ok(cppFiles.includes("src/main.cpp"))
            assert.ok(cppFiles.includes("src/utils.h"))
            assert.ok(cppFiles.includes("src/core.cc"))
            assert.ok(cppFiles.includes("include/types.hpp"))
        })
    })
})
