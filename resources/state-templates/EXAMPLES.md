# PARTITION_LEDGER 条目示例

> 这些示例**不会**被 ledger.sh 解析（不在 PARTITION_LEDGER.md 中），仅供人类参考格式。
> 实际条目由 `ledger.sh wave-add / batch-add / partition-add` 自动追加到 ledger。

## Wave 示例

```markdown
### W-001: 拆分 GodModule.cpp 5万行

- **目标**：将 50k 行单文件拆分为 ≤ 1000 行/文件 的责任域模块
- **范围**：src/legacy/
- **预计 Batches**：8
- **预计 Partitions**：32
- **状态**：PLANNED
- **启动日期**：2026-05-06
- **完成日期**：-
- **驱动指标**：max(file LOC) < 1000，max(cyclomatic) < 15

#### Batches in W-001

| Batch ID | 目标 | Partitions | 状态 | 会话日期 |
|----------|------|------------|------|----------|
| B-001 | 提取第 1-3 责任域 | 4 | PLANNED | 2026-05-06 |
```

## Batch 示例

```markdown
### B-001 (W-001): 提取第 1-3 责任域

- **目标**：在一次会话内拆出 LegacyParser / NetworkLayer / ConfigLoader
- **预算**：4 partitions / 4h
- **依赖 Batches**：-
- **状态**：PLANNED
- **会话日期**：2026-05-06
- **AST 缓存预热**：`clang_ast_load(file="src/legacy/GodModule.cpp")`

#### Partitions in B-001

| ID | 文件 | 行范围 | 状态 | 风险 | 备注 |
|----|------|--------|------|------|------|
| P-001 | src/legacy/GodModule.cpp | L100-L350 | PLANNED | med | LegacyParser |
```

## Partition 示例

```markdown
### P-001 (B-001 / W-001): Extract LegacyParser

- **状态**：PLANNED
- **文件**：src/legacy/GodModule.cpp
- **行范围**：L100-L350（251 行）
- **关联符号**：parseHeader, parseBody, validateChecksum
- **风险**：med
- **依赖 Partitions**：-
- **重构策略**：Extract to new file legacy/LegacyParser.cpp + .h
- **影响分析**（impact）：
  - 直接调用方（d=1）：12 个
  - 受影响 process：UserLogin, ConfigReload
  - 风险等级：MEDIUM
- **特征化测试**：tests/legacy/test_parser.cpp
- **验证步骤**：
  1. 编译：`cmake --build build --target legacy_unit_tests`
  2. 测试：`./build/tests/legacy_unit_tests --gtest_filter=Parser.*`
  3. impact 校验：`codegraph_codegraph_impact`
- **验证结果**：未执行
- **耗时**：-

最后更新：2026-05-06
```
