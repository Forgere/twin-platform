# 故障注入演练：篡改一条证据，看门禁能不能抓住

这个目录不跑新场景，只回答一个问题：**有人改了一条事件再声称"复现通过"时，验证链会怎样反应？**

- `tampered.json` —— 以 `examples/community/mini-line/expected/trace.json` 为源，只把
  `/events/2/payload/status` 从 `idle` 改成 `busy`，**故意不重算** `eventHash` / `stateHash`
  （伪造证据的典型形态：改了内容，忘了重算指纹）。
- `injection.json` —— 注入点、改前值、改后值，供 `check.ts` 断言。
- `generate.ts` —— 从黄金 trace 重新生成 `tampered.json`，改一行就能换注入点。
- `check.ts` —— 端到端门禁：黄金基线必须一致，篡改基线必须被拦下，且首个分歧精确到 pointer。

## 运行

```bash
bun examples/fault-injection/generate.ts          # 改了注入点之后重新生成
bun examples/fault-injection/check.ts /tmp/fault  # 默认输出到 .scene-ci/fault-injection
```

`check.ts` 会跑两遍同一场景（`--plugin logistics --seed 1 --seconds 30`）：

| 基线 | 期望 | 断言 |
| --- | --- | --- |
| `examples/community/mini-line/expected/trace.json` | exit 0 | 输出「基线一致」 |
| `examples/fault-injection/tampered.json` | exit 1 | 输出「基线分歧：`/events/2/payload/status`」 |

产物落在 `<out>/golden/` 与 `<out>/tampered/`：`trace.json`、`report.html`、`junit.xml`。
篡改那份的 JUnit 里 `firstDivergence` 属性就是 pointer，报告 HTML 也内嵌同一处分歧——
可以直接拿去做评审材料，而不是让人相信一张截图。

## 为什么用 pointer 而不是"不一致"三个字

`scene diff` 走的是键排序、深度优先的 JSON 比对（RFC 6901 pointer）。
同一条事件的 `payload.status` 改了，报告必须指出 `/events/2/payload/status`，
而不是"trace 不同"。注入点漂移（场景变了、事件顺序变了）时，
`check.ts` 会因为 pointer 对不上而失败——这正是我们要的：**证据结构变了，演练本身要重新校准**。
