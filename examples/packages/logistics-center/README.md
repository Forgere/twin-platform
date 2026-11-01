# 工厂参考场景包：智能物流中心

这是「可验证仿真场景」的旗舰示例。一条闭环输送线串起
**产出 → 打包 → 入库 → 出库 → 卡车运走**，并把一次运行所需的全部输入
（场景 / 插件锁 / seed / 不变量）与黄金基线固化成一个目录。

## 5 分钟上手

不装数据库、不开浏览器，直接从克隆跑到一份 HTML 审计报告：

```bash
bun install
bun run scene run --package examples/packages/logistics-center --out .scene-ci/logistics-center
# 打开 .scene-ci/logistics-center/report.html
```

`seed 7 / step 1/60 / 300s` 全部取自包内 `seed.json`。`run` 会跑固定步长仿真、
执行 2 条运行时不变式（全链路 + 物料守恒，由 `runtimeInvariantsFor(scene)` 选出），
并写出 `trace.json` / `report.json` / `report.html`。

## 门禁

```bash
# 契约校验（不跑仿真）
bun run scene package examples/packages/logistics-center

# 与黄金基线比对：分歧即退出 1（默认基线就是包内 expected/trace.json）
bun run scene replay --package examples/packages/logistics-center
```

## 它证明什么

- 场景是数据（`scene.json`），不是藏在 TS 常量里的布局；
- 插件锁写进 `plugins.lock.json`，不是「我本地装的那个版本」；
- 不变量与 Studio 审计面板走同一个执行器（`runtimeInvariantsFor`）——
  CI 里挡你的和页面上看到的是同一口径；
- 黄金基线由 `scene-spec` 重算哈希、不自报自证；改布局后 `diff` 能指出第一处变化。

## 重新生成

```bash
bun examples/packages/logistics-center/generate.ts   # 重写 scene.json
bun run scene run --package examples/packages/logistics-center \
  --baseline examples/packages/logistics-center/expected/trace.json --update
```

目录约定见 [`examples/packages/README.md`](../README.md)。
