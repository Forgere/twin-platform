# 社区示例：迷你输送线场景包

这是给外部贡献者的**最小可复现场景包**：不改内核，只改场景参数，就能把一条新产线送进公共验证链。
`generate.ts` 是唯一需要动的生成入口（`parcels=2`、`length=16`、`baseSpeed=1.4`）。

## 复现

```bash
bun examples/community/mini-line/generate.ts
bun run scene package examples/community/mini-line

# 重新生成黄金基线
bun run scene run --scene examples/community/mini-line/scene.json \
  --plugin logistics --seed 1 --seconds 30 --out examples/community/mini-line/expected

# 门禁
bun run scene replay --scene examples/community/mini-line/scene.json \
  --plugin logistics --seed 1 --seconds 30 \
  --baseline examples/community/mini-line/expected/trace.json
```

## 它证明什么

- 场景是数据，不是藏在 TS 常量里的布局；
- 插件锁写进 `plugins.lock.json`，不是“我本地装的那个版本”；
- 指标口径显式登记：`parcel:exit` 在环线上是**绕圈**，不是实际出货；
- 改布局后，基线 diff 能指出第一处变化，而不是只换一张截图。
