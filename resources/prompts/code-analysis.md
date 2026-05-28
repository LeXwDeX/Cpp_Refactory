# 代码分析约束 — code-analysis

对 C++ 文件执行任何修改之前，必须理解其结构、依赖和风险点。适用于重构和开发。

---

## 硬约束

1. **未分析不修改** — 对目标文件执行任何代码修改工具之前，必须先完成结构分析。违反即停止，回到分析。
2. **AST 优先，正则降级** — 有 MCP（clang-ast-mcp）可用时，必须用 AST 精确分析。MCP 不可用时才降级到 `cpp-seam-finder.sh`（正则启发式，误报率 >30%）。降级时必须在输出中标注 `[降级路径]`。
3. **影响范围必须量化** — 修改任何符号之前，必须通过 `codegraph_codegraph_impact` 或等效工具确认上游调用方数量。调用方 ≥3 处的符号视为高风险。
4. **全局变量必须登记** — 发现的全局变量/静态变量必须记录到分析报告，标注 SIOF（Static Initialization Order Fiasco）风险等级。

---

## 输出契约

分析完成后产出决策表，必须包含以下列：

| 列 | 内容 | 来源 |
|----|------|------|
| `symbol` | 函数/类/变量名 | AST 或正则 |
| `lines` | 行数 | AST |
| `complexity` | 圈复杂度 | `clang_ast_list_functions` |
| `globals` | 依赖的全局变量数 | `clang_ast_globals` |
| `virtual_calls` | 虚调用站点数 | `clang_ast_virtual_calls` |
| `macro_depth` | 宏嵌套深度 | `clang_ast_macro_jungle` |
| `callers` | 上游调用方数量 | `codegraph_codegraph_impact` |
| `risk` | 综合风险等级（LOW/MED/HIGH） | 计算 |

风险计算：
- HIGH：complexity ≥20 或 callers ≥5 或 globals ≥3
- MED：complexity ≥10 或 callers ≥3 或 globals ≥1
- LOW：其余

---

## 记忆写入

```
subject = "{文件名}"
predicate = "analysis"
object = "{symbol_count}|{high_risk_count}|{analysis_date}"
```

追加一条到持久记忆抽屉：
- wing = "architecture"
- room = "{项目名}"
- content = 高风险符号列表 + 关键依赖关系（一段话）

---

## 纠错规则

- **MCP 工具返回空结果** → 检查 compile_commands.json 是否包含目标文件。不包含则重新生成，不跳过分析。
- **降级路径误报** → 在输出中标注 `[待 AST 确认]`，不直接作为修改依据。
- **codegraph_codegraph_impact 无结果** → 可能是新符号或索引未更新。运行 `codegraph_codegraph_status` 检查索引状态，不假设无调用方。
- **同一文件分析 3 次仍不完整** → 停止，记录工具缺口（GAP），上报用户。

---

## 适用场景

| 场景 | 分析重点 |
|------|----------|
| 重构：找切分点 | 高复杂度函数、全局依赖、虚调用热点 |
| 重构：评估影响 | callers 数量、跨文件依赖链 |
| 开发：新功能插入点 | 现有架构入口、数据流路径、命名约定 |
| 开发：理解遗留代码 | 函数边界、宏展开结果、所有权模式 |
