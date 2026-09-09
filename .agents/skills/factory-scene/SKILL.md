---
name: factory-scene
description: "搭建或改造工厂 / 产线 / 立库场景：写 SceneTemplateDescriptor、排皮带与设备布局、给行为接线、补测试与阶段文档。用在用户说\"搭个工厂场景\"\"加一条产线\"\"把 XX 装进场景\"\"改布局\"\"做一个闭环\"，或任何要动 packages/plugins-logistics/src/template.ts 的时候。"
---

# 搭建工厂场景

一句话：模板只声明**实体 + 配置**，物料怎么动全归行为插件；布局必须过 `layout.test.ts` 的铁律。

## 流程

### 1. 定物料流
先把流程画成一行 ASCII 图：谁产出 → 谁运输 → 谁加工 → 谁存储 → 谁消耗（在哪闭环），并标出每段的载体（皮带 / 站台 / 卡车 / 货位）。

**完成标准**：图上每个箭头都落到一个具体的 kind 或 capability 上，没有"然后货就消失了"的断头；产出口（`ctx.spawn`）和消耗口（`ctx.despawn`）都明确。

### 2. 选设备
先在 `packages/plugins-logistics/src/devices.ts` 里找现成工厂：`conveyorSegment` / `conveyorPolyline` / `goodsSource` / `packingStation` / `asrsRack` / `stackerCrane` / `stackerCarriage` / `stackerFork` / `liftTransfer` / `bufferRack` / `truck`。

找不到的设备**不要**在模板里凑几何——按 `device-plugin` skill 先新增一个工厂再回来。

**完成标准**：流程图上每个环节都对应到一个已存在的工厂函数；要新增的写成清单，先做完再排布局。

### 3. 排布局
按下面的「布局铁律」摆坐标，并把**走廊**先留出来：卡车 / AGV 的路线必须是一条不压任何皮带的通道。

**完成标准**：`bun test packages/plugins-logistics/src/layout.test.ts` 通过，新增路径的每个拐点都有皮带托着。

### 4. 接线（行为）
场景只声明 config，行为读 config；行为顺序即契约，跨行为信号走 attrs。

**完成标准**：把世界跑 2~5 分钟，事件流能串成完整闭环，且实体总数有界（没有越堆越多）。

### 5. 登记
`template.ts` 加模板 + `build<X>Scene`；`index.ts` 的 `templates` 数组与导出；插件 manifest 的 `version` / `description` 同步。

**完成标准**：`logisticsPlugin.activate().templates` 能看到新模板，`index.test.ts` 的模板清单断言同步更新并通过。

### 6. 验证与记录
依次跑：`bun test packages` → `apps/studio` 的 `bun x vitest run` → 关键包 `tsc --noEmit`（studio 的既有报错不算新引入）→ 起 dev server 看页面是否零报错；最后在 `docs/行动计划.md` 追加一条阶段记录（问题 / 做法表 / 测试 / 踩坑）。

**完成标准**：上面每一项都跑过并有结果；文档里有这一阶段的行。

## 参考

### 布局铁律
- **只贴边不叠面**：占地面实体（`transport` / `transfer` / `buffer` / `asrs`）之间不允许出现面积重叠，贴边相接可以；让位距离取半个带宽（`HALF_C = 0.7`）。
- **走向必须声明**：直行皮带写 `config.beltAxis: 'x' | 'z'`，渲染层绝不靠尺寸猜。
- **箭头按实际行进方向**：`beltDirection: 1` 顺 local +X；沿 Z 铺设时 local +X = 世界 **−Z**，所以"往 +Z 走"填 `-1`。
- **拐弯并进折线**：自带 90° 拐的线用 `conveyorPolyline`，`radius` 必须小于半个带宽（否则倒角会切到没皮带的地方）；纯过路的单线拐弯不用独立转角模块。
- **走廊**：卡车 / AGV 路线沿皮带之间的空走廊布置（先沿走廊开出场地再离场），落位点（缓存台等）同样要检查不与任何皮带叠面。

### 路径与高度
- 物料中心高度固定 `DECK_Y = 1.2`，皮带实体 `BELT_Y = 0.6`。
- `loop: 'repeat'` 的路径**必须首尾闭合**，否则到终点会瞬移回起点。
- 单向不回流用 `loop: 'none'`（工厂里落成 `clamp`），配合 `splitOpenPath` 错开起步点。
- 路径的每个拐点都要落在某段皮带 / 移栽机 / 货架的占地内。

### 接线约定
- **顺序即契约**：`index.ts` 里 behaviors 的注册顺序决定每步执行顺序，改顺序等于改结果。
- **声明即契约**：行为只读实体 `config`，场景常量不进行为代码（队列位置、站台尺寸、层高、出料路径都从 config 取）。
- **单一位姿来源**：带 `motion` 的实体每步都被内核写位姿；行为要自己管位姿就别给它 motion。
- **背压走 attrs**：消费者发布 `attrs.queueFree` / `attrs.used` / `attrs.stock`，生产者读它决定要不要继续产出。
- **状态进 attrs**：跨步状态全写 attrs（随快照恢复），内部计数器用 `__` 前缀（如 `__lap` 做圈次幂等）。

### 坑
1. **托盘带 motion 会飘**：打包站产出的托盘若声明 motion，内核每步把它拉回路径终点，覆盖掉货架行为写的货位——位姿只能有一个来源。
2. **"同时抓到 N 个货"永远不成立**：长环线上货间距远大于工位半径，工位要**缓存位**（先扣住，等下一个来）。
3. **装饰托盘点不中**：货架模型里烘焙的托盘不是实体，点不中也改不了数量——托盘必须是实体。
4. **回跳留幽灵**：`restore()` 会算实体增删差量，`restoreFrom()` 不能清掉它。
5. **删导出后 Vite 报错**：删掉某个导出后，正在跑的 dev server 可能还拿着旧模块图 → 硬刷新页面，不行就重启 `bun run dev`。

### 相关文件
- 设备工厂：`packages/plugins-logistics/src/devices.ts`
- 行为：`packages/plugins-logistics/src/{behavior,asrs,packing,source,truck,transfer,bufferFill}.ts`
- 场景模板：`packages/plugins-logistics/src/template.ts`
- 3D 模型：`apps/studio/src/scene/entityMeshes.ts`
- 布局 / 运行时 / 闭环测试：`packages/plugins-logistics/src/{layout,runtime,closedLoop}.test.ts`
- 确定性规则（内核侧唯一出处）：仓库根 `AGENTS.md`
- 阶段记录：`docs/行动计划.md`
