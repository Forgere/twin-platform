---
name: device-plugin
description: "新增一类设备或扩展物流领域插件：设备工厂 + 3D 模型 + 行为 + 注册 + 测试。用在用户说\"加个新设备\"\"加一台 XX 站 / 机器 / 传感器\"\"写个新行为\"\"新增插件能力\"，或任何要动 packages/plugins-logistics 的 devices.ts、行为文件、插件 manifest 的时候。"
---

# 新增设备与领域插件

一句话：设备 = **声明**（工厂）+ **外观**（模型）+ **逻辑**（行为）+ **契约**（注册与测试）。
内核不认识"输送线""堆垛机"，只认 `capabilities` 数组。

## 流程

### 1. 声明设备（`devices.ts`）
工厂函数返回 `TwinEntity`：`id / kind / transform / capabilities / visual / config`。

- `kind` 给渲染层分派模型；`capabilities` 给行为分派逻辑（内核只认这个数组）。
- **config 就是行为契约**：行为要用到的每个数字与路径都写进 config（尺寸、层高、路径、速度、容量、归属 id），行为里不出现场景常量。
- 派生部件用后缀约定（`-carriage` / `-fork` / `-cassette` / `-load`），行为按 config 里的后缀 `ctx.entity(base + suffix)` 去找。
- config 里给"跨行为配对"用的字段（如 `craneId` / `carrier` / `side`）要显式声明，别让行为靠坐标猜。

**完成标准**：模板里能生成新 kind，`visual.size` 与 config 里的尺寸自洽，`bun test packages/plugins-logistics` 通过。

### 2. 建模（`apps/studio/src/scene/entityMeshes.ts`）
`buildEntityMesh` 的 switch 加一个 case + 一个 `build<X>` 函数。

- 复用 `rbox / cyl / sphere / at / statusLamp / material`，颜色一律走 `getActiveTheme()` 令牌。
- 挂 `userData.codePath`（点中后能回答"它由哪段代码渲染"）；需要按状态动起来就挂 `userData.anim`。
- 模型**只画结构**：数量、有无货物、忙闲这些业务真相由实体与 attrs 决定，不烘焙进几何。
- `groundY = -baseY` 让模型落地；可动子部件拆成独立实体（和堆垛机拆门架 / 载货台 / 货叉同理）。

**完成标准**：dev server 里新设备位置正确、可选中，检视面板"渲染来源"显示 `entityMeshes.ts:build<X>`。

### 3. 写行为
一个 `create<X>Behavior(config)`，返回 `{ id, step(ctx) }`。

- `id` 全局唯一；只用 `ctx.time` / `ctx.dt` / `ctx.rng`，确定性规则见根 `AGENTS.md`。
- 跨步状态写 `attrs`（随快照恢复），内部计数器用 `__` 前缀（如 `__lap` 做圈次幂等）。
- 对外发布**只读状态 attrs**（`task` / `stock` / `queueFree` / `used` / `capacity`…），UI 与别的行为都读它。
- 值没变就别写 attrs，避免每步刷帧差量（位姿本来就每步变的实体除外）。
- 产出 / 消耗用 `ctx.spawn` / `ctx.despawn`：id 由确定性规则派生（计数器存 attrs），本步生成的实体下一步才进 `ctx.entities`。

**完成标准**：能一句话讲清"读哪些 attrs/config → 写哪些 attrs / 位姿 / 事件"，且这个文件不 import 场景模板。

### 4. 注册
`packages/plugins-logistics/src/index.ts`：behaviors 数组（**顺序即契约**）+ 导出；manifest 的 `version` / `description` 同步；有指标 / 模板就一并登记。

**完成标准**：`index.test.ts` 的行为清单断言同步更新并通过。

### 5. 测试
- 行为测试用**自建最小场景**（几个工厂函数 + 一个行为），几秒钟验语义，别等真实场景跑几分钟。
- 同种子跑两遍 + 快照恢复后继续跑，指纹逐位一致。
- 参与真实场景的再加一条端到端断言：守恒（产出 = 消耗 + 在制）、比值（如 2 合 1）、背压上限。

**完成标准**：`bun test packages` 全绿；关键包 `tsc --noEmit` 干净。

### 6. 接进工作台
- `apps/studio/src/scene/entityState.ts`：新 kind 的实时状态行（纯函数，配单测）。
- 要进 HUD 就在 `studioSession.ts` 的 `telemetry()` 里派生字段。

**完成标准**：`apps/studio` 的 `bun x vitest run` 通过。

## 参考

### 契约速查
| 层 | 唯一真相 | 不要做的事 |
| --- | --- | --- |
| 工厂 `devices.ts` | 能力、外观尺寸、config | 在工厂里写运动逻辑 |
| 模型 `entityMeshes.ts` | 造型、主题色、anim 句柄 | 在模型里存业务状态 |
| 行为 `<x>.ts` | 状态机、位姿、事件 | 读场景模板、硬编码坐标 |
| 注册 `index.ts` | 行为顺序、导出、manifest | 悄悄改已有行为顺序 |
| 内核 | 沿路径运动、attrs、事件、快照 | 认识"输送线"这类词 |

### 坑
1. **单一位姿来源**：带 `motion` 的实体每步都被内核写位姿。行为要自己管位姿就别给它 motion；实在要两者共存，行为必须每步覆盖写。
2. **读自己刚写的 attrs 会失效**：`ctx.setAttr` 直接改的是活对象，`if (since !== num(attrs.since, ctx.time)) ctx.setAttr(...)` 这种写法永远不成立（兜底值等于刚算出的值）。比较用局部变量 + 哨兵默认值（`-1` / `''`），或干脆无条件写。
3. **行为抛错 = 整个行为停摆**：`SafeBehavior` 捕获后把该行为永久停用（其余继续跑）。"不该发生"的分支宁可 `continue`，别 `throw`。
4. **运行时生成的实体要带声明**：`spawn` 出去的实体若没有 `visual` / `config`，快照恢复后就是"野实体"（渲染成默认方块、行为认不出来）。
5. **新包要登记两处**：根 `tsconfig.json` 的 `paths` 与根 `package.json` 的 `typecheck:packages`。
6. **测试不在 `tsc` 范围里**：各包 tsconfig 把 `src/*.test.ts` 排除在类型检查外（仓库没装 `bun-types`），所以测试必须真的跑一遍。

### 相关文件
- 设备工厂：`packages/plugins-logistics/src/devices.ts`
- 行为样板：`asrs.ts`（状态机 + 队列 + 事件）、`packing.ts`（spawn/despawn + 缓存位）、`truck.ts`（沿路线走 + 装车）、`bufferFill.ts`（最简形态）
- 插件契约与故障隔离：`packages/plugin-sdk/src/registry.ts`（`SafeBehavior`）
- 行为上下文 API：`packages/world-kernel/src/behaviors.ts`
- 场景模板：`packages/plugins-logistics/src/template.ts`（排布局看 `factory-scene` skill）
- 确定性规则：仓库根 `AGENTS.md`
