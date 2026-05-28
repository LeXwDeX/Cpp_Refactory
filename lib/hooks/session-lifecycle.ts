import { readStateFiles, stateExists, type StateFiles } from "../utils/state.js"

export type SessionStatus = "notInstalled" | "ready"

export interface SessionContext {
    projectDir: string
    status: SessionStatus
    stateFiles: StateFiles
}

/**
 * Build session context by reading state files from the project directory.
 * Called on session.created to inject context into the conversation.
 */
export function buildSessionContext(projectDir: string): SessionContext {
    if (!stateExists(projectDir)) {
        return {
            projectDir,
            status: "notInstalled",
            stateFiles: {
                refactorState: null,
                partitionLedger: null,
                toolGaps: null,
            },
        }
    }

    return {
        projectDir,
        status: "ready",
        stateFiles: readStateFiles(projectDir),
    }
}

// ── CTE Methodology ─────────────────────────────────────────────────
// Code Triangulation Engineering — a reasoning framework, not rules.
// Exported for injection into system prompt tail via experimental.chat.system.transform.

export const CTE_METHODOLOGY = `
# CTE — Code Triangulation Engineering

在巨型 C++ 工程中系统性游走的方法论。

## 铁三角架构

三个支柱构成开发核心，缺一不可：

\`\`\`
        插件本体 (AST + Tools + Hooks)
        语义理解 · 结构扫描 · 行为验证
              /                    \\
             /                      \\
            /    铁三角：开发核心      \\
           /                          \\
    Hindsight ———————————————— codegraph
    人类知识 · 约束教训          符号关系 · 调用链
\`\`\`

| 支柱 | 提供什么 | 缺了会怎样 |
|------|---------|-----------|
| **插件本体** (clang_ast_* / cpp-scan / seam-finder / pipeline) | 代码语义真相：精确边界、类型、复杂度、行为验证 | 只能 grep 猜测，不懂模板/宏/虚函数 |
| **Hindsight** (持久记忆) | 人类积累：项目约束、架构决策、历史教训、不能碰的模块 | 不知道历史教训，重复犯错 |
| **codegraph** (符号图谱) | 结构关系：谁调用谁、改了什么影响谁、符号爆炸半径 | 不知道影响范围，盲目修改 |

三者之间的信息流：
- 插件 → codegraph：用 callers/callees/impact 查关系，AST 精确验证 codegraph 的结论
- 插件 → Hindsight：发现约束/踩坑时写入，任务开始时查询已有知识
- codegraph → Hindsight：发现的结构模式（高扇入符号、循环依赖）存入持久记忆
- Hindsight → 插件+codegraph：人工约束指导查询方向和修改边界

## 核心原则

1. **单源不可信** — 任何单一信息源都有盲区。结论须 ≥2 个独立层级交叉确认。
2. **语义 > 文本** — C++ 真相在语义层（类型/继承/模板/宏展开），文本匹配是起点不是终点。
3. **地图 > 领土** — 大文件先建地图再导航，直接读原始代码会丢失结构感。
4. **量化 > 感觉** — 工具给你数字（行数/复杂度/调用方数），数字给你判断力。
5. **增量 > 全量** — 遗留项目有成千既有告警，只看你引入的增量。
6. **自洽性闭环** — 任何结构性变更（提取/移动/拆分/合并）必须证明结果能独立存活：依赖分析 → 执行变更 → 隔离环境编译 → 失败则补依赖 → 循环至通过。未通过闭环验证的结构变更不算完成。

## 信息源层级

信任度从低到高。高层否定低层时信高层，低层否定高层时怀疑低层。

| 层级 | 来源 | 看到什么 | 盲区 |
|------|------|---------|------|
| L0 | Hindsight / 持久记忆 | 人工植入的约束、架构决策、历史教训 | 可能过时 |
| L1 | grep/rg | 文本模式 | 不懂语义（模板/宏/虚函数/命名空间） |
| L2 | cpp-scan / bigfile-map / seam-finder | 结构骨架、规模排行 | 启发式，边界可能偏移 |
| L3 | clang_ast_* | 精确函数边界、圈复杂度、链接类型 | 依赖 compile_commands.json |
| L4 | codegraph callers/callees/impact | 跨文件调用链、影响范围 | 索引可能过时 |
| L5 | clang-tidy / cppcheck / quality-gate | 静态分析、增量质量变化 | 既有告警噪声大 |
| L6 | 编译 / 测试 / pipeline / characterize | 实际行为、等价性证明 | 测试覆盖不全时无法证明等价 |

## 推理模式

1. **查记忆** — 开始前查 Hindsight 是否有人工植入的约束或历史教训
2. **明确问题** — 边界？影响？依赖？风险？验证？
3. **选源组合** — ≥2 个层级，查决策表选推荐组合
4. **交叉比对** — 一致则行动；矛盾则信高层或引入第三源仲裁
5. **降级标注** — 高层不可用时降级，但标注置信度（高/中/低）
6. **行为验证** — 每次变更后回到 L6 确认安全
7. **自洽性闭环** — 结构性变更须在隔离环境编译验证，失败则回补依赖再验

## 决策表

| 场景 | 推荐组合 | 降级方案 |
|------|---------|---------|
| 陌生项目 | L0(Hindsight) + L2(cpp-scan) + L4(codegraph status) | L2 单独，标注"无索引" |
| 大文件(>500行) | L2(bigfile-map) → Read 段落 → L4(callers) | L2 + L1(grep)，标注"无关系图" |
| 抽取函数 | L3(AST边界) + L4(callers) + L2(段落) + **L6(隔离编译)** | L2 + L1，标注"边界可能偏移" |
| 改全局变量 | L3(globals分类) + L4(impact) + L6(characterize) | L2(seam-finder) + L1，标注"30%误报" |
| 清理#ifdef | L3(macro_jungle) + L2(seam-finder) + L1(clang -E) | L2 + L1，标注"无AST确认" |
| 评估重构方案 | L4(impact量化) + L3(虚调用) + L5(baseline) | L4 + L2，标注"无质量基线" |
| 结构变更(提取/移动/拆分/合并) | L4(依赖分析) → 执行 → L6(隔离编译) → 失败回L4补 → 循环 | L1(grep依赖) + L6编译，标注"隐式依赖可能遗漏" |
| 改完代码 | L6(pipeline) + L5(quality-gate check) | L6仅编译，标注"无测试覆盖" |

## 置信度

| 等级 | 条件 | 行动 |
|------|------|------|
| 高(≥80%) | ≥2 个 L3+ 来源一致 | 可以行动 |
| 中(50-80%) | 仅低层来源或来源分歧 | 行动但标注风险 |
| 低(<50%) | 仅 L1/L2 或前置条件不满足 | 不行动，先获取更多信息 |

## 反模式

- 一个 grep 就下结论 → 至少 2 层交叉验证
- Read 整个大文件 → 先建地图再导航
- 凭经验判断影响范围 → codegraph impact 量化
- 改完不验证 → pipeline + quality-gate 提供证据
- 全量看告警 → quality-gate baseline + check 只看增量
- 高层不可用就停 → 降级 + 标注置信度
- 不标注置信度 → 每次判断附带高/中/低
- 同一来源验证两次 → 必须跨层级
- 提取代码不验证完备性 → 隔离环境编译闭环，失败则补依赖再验
- 发现约束不保存 → 写入 Hindsight，下次 session 可查
- 不查记忆就开始工作 → 先查 Hindsight，可能有人留了关键信息
`.trim()

/**
 * Format session context for injection into conversation.
 * CTE methodology is injected separately via experimental.chat.system.transform.
 */
export function formatSessionContext(ctx: SessionContext): string {
    const parts: string[] = []

    if (ctx.status === "notInstalled") {
        parts.push(`[cpp-refactory] cpp_refactory not installed in this project. Call cpp-bootstrap tool to initialize.`)
        return parts.join("\n")
    }

    parts.push(`[cpp-refactory] Session context loaded.`)

    if (ctx.stateFiles.refactorState) {
        parts.push(`\n## REFACTOR_STATE\n${ctx.stateFiles.refactorState}`)
    }
    if (ctx.stateFiles.partitionLedger) {
        parts.push(`\n## PARTITION_LEDGER\n${ctx.stateFiles.partitionLedger}`)
    }
    if (ctx.stateFiles.toolGaps) {
        parts.push(`\n## TOOL_GAPS\n${ctx.stateFiles.toolGaps}`)
    }

    return parts.join("\n")
}
