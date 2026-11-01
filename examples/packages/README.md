# Scene package 目录约定

一个包 = **一次可验证运行所需的全部输入** + 黄金基线。目录形状：

```text
<package>/
  scene.json            必填：版本化场景（可迁移 + 校验）
  plugins.lock.json     必填：[{ id, version, configHash? }]
  seed.json             必填：{ seed?, step?, seconds | steps, observation? }
  actions.json          可选：外部输入 / 动作脚本
  invariants.json       可选：这个包该验什么（挂了 `check` 的会被真跑）
  metrics.json          可选：指标口径
  expected/trace.json   可选：黄金基线（sceneId 要对得上）
```

## 跑

```bash
bun run scene audit --package examples/packages/hello
bun run scene replay --package examples/community/mini-line
```

`--package` 一次带齐输入：`scene.json` 作场景、`plugins.lock.json` 的首条锁作插件、
`seed.json` 的 `seed / step / seconds` 作时间网格（命令行显式给了就覆盖包里的值）、
`actions.json` 作动作脚本。`replay` 的默认基线就是包内的 `expected/trace.json`。

`invariants.json` 的条目：

- 不写 `check`：纯登记，只声明"以后该验什么"，不执行；
- 写 `"check": "<id>"`：引用已注册的内置检查，**真跑**，失败即 exit 1；
- 写了 `check` 却指向未注册的 id：该条**判失败**，不静默跳过。

可用内置检查（`packages/scene-cli/src/invariants.ts`）：

| id | 断言什么 | 参数 |
|---|---|---|
| `logistics.line.loop` | 每个包裹 `exit == enter − 1`：仍在环上，绕圈不算出货 | `enterType`（默认 `parcel:enter`）、`exitType`（默认 `parcel:exit`） |
| `logistics.line.no-teleport` | 包裹沿闭环路径连续运动：`loop` 必须 `repeat`、弧长不越界、速度非负 | `kind`（默认 `parcel`）、`tolerance` |
| `logistics.center.flow` | 闭环中心全链路都有事件：产出 → 打包 → 入库 → 出库 → 运走 | 无（直接借 `plugins-logistics` 的 `centerFlowInvariant`，与 Studio 审计面板同一份） |
| `logistics.center.conservation` | 小货物与托盘在全链路中守恒 | 无（借 `centerConservationInvariant`） |
| `scene.deterministic.quiet` | 观察窗内事件数不超上限，且 `rngState` 没被推进（没有行为偷用随机） | `maxEvents`（默认 0） |

`logistics.center.*` 这两条是**从插件借来的引用**（惰性 import），不是 CLI 里抄的一份副本——
「CI 里挡你的」和「Studio 页面上看到的」永远是同一个口径。只在真的装了发生器 / 打包站 / 立库 / 卡车的
闭环场景里有意义；套在 `line` 模板上会把"这条链路本来就没有"报成违例，所以别给非闭环场景硬挂。

## 校验

```bash
bun run scene package examples/packages/hello --junit .scene-ci/package/junit.xml
```

`package` 命令只做契约校验，不跑仿真；报告检查是：

- `package.layout`：必填文件齐全且都是合法 JSON；
- `package.scene`：`scene.json` 可迁移并通过校验；
- `package.plugin-lock`：每条插件锁都有 `id` 与 `version`；
- `package.seed`：时间网格能落到整数固定步；
- `package.baseline`：有基线时，`sceneId` 一致，且 `eventHash / stateHash` 由本端按 `scene-spec` 重算（不自报自证）。

## 生成基线

```bash
bun run scene run --scene examples/packages/hello/scene.json \
  --seed 1 --step 0.016666666666666666 --seconds 2 \
  --out examples/packages/hello/expected
```

`--out` 会写 `trace.json`、`report.json` 与 `report.html`；作为包基线只需要里面的 `trace.json`。
用包自己的时间网格生成，就直接 `bun run scene run --package examples/packages/hello --out examples/packages/hello/expected`。
