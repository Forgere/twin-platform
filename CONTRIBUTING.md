# 贡献指南：写规则、场景与 adapter

本项目占位的不是“数字孪生大屏”，而是**可验证仿真场景的基础设施**：场景像代码一样可测试、可回放、可审计、可进 CI。
贡献请围绕这条边界，而不是先加面板或渲染特效。

## 先读什么

| 想做什么 | 先读 |
| --- | --- |
| 新增行业设备 / 物流行为 | `.agents/skills/device-plugin/SKILL.md`、`packages/plugin-sdk` |
| 新增工厂 / 产线场景 | `.agents/skills/factory-scene/SKILL.md`、`packages/plugins-logistics/src/template.ts` |
| 新增可验证规则 / 指标 | `packages/scene-audit`、`packages/analytics-core` |
| 新增 runtime adapter | `adapters/simpy`、`adapters/fmu`、`adapters/openscenario` |
| 新增插件 | `packages/plugin-sdk`、`packages/plugin-conformance` |

内核边界：`world-kernel` 不依赖 DOM / Solid / Three / 数据库；行业语义进 `plugins-<domain>`，展示进 `plugins-<domain>/studio`。
确定性铁律：固定步长；随机只来自注入的 `ctx.rng`；禁止裸 `Math.random`、`Date.now`、`new Date`、`performance.now`、真实定时器；新增状态必须进快照。

## 1. 写一条规则（invariant）

好的规则是**只读 trace / 世界状态就能判真伪**的断言，不是“看起来没报错”。

```ts
export const conservationCheck = {
  id: 'domain.conservation',
  description: '输入 = 输出 + 在制',
  check(world) {
    return produced === consumed + wip
      ? { notes: ['账实一致'] }
      : { violations: [{ where: 'goods', message: '物料不守恒' }] };
  },
};
```

规则要求：

- id 稳定、可读，描述说清“什么会骗人”；
- 不修改世界、不读挂钟、不使用随机；
- 违例带 `where`（实体 / 参数 / 事件位置），人能直接定位；
- 观察窗不足要给警告，不把“没观察到”包装成“没差异”；
- 用 `runAudit` / `runTwinScene` 跑通，并写正反两例（能过、必须抓得住 bug）。

## 2. 写一个场景 / scene package

一个 scene package 是一次可验证运行的全部输入 + 黄金基线：

```text
<package>/
  scene.json            必填：版本化场景（可迁移 + 校验）
  plugins.lock.json     必填：[{ id, version, configHash? }]
  seed.json             必填：{ seed?, step?, seconds | steps, observation? }
  actions.json          可选：外部输入 / 动作脚本
  invariants.json       可选：该验什么（挂 check 就真执行）
  metrics.json          可选：指标口径
  expected/trace.json   可选：黄金基线
```

流程（`--package` 一次带齐输入与断言，seed/时间网格取自 `seed.json`）：

```bash
# 1) 写场景，校验可迁移、可运行
bun run scene package <dir>

# 2) 生成黄金基线（用包自己的时间网格）
bun run scene run --package <dir> --out <dir>/expected

# 3) 以后都走门禁：跑包里挂的不变量 + 比对基线，变了要能说出第一处分歧
bun run scene replay --package <dir>
```

### 在 invariants.json 里挂可执行断言

条目不写 `check` 只是登记（声明"以后该验什么"）；写了 `"check": "<内置 id>"` 就**真执行**，失败即 exit 1。
挂了 `check` 却指向未注册的 id，该条**判失败**而不是静默跳过——没执行的断言不算通过。

```jsonc
[
  { "id": "loop", "description": "包裹绕圈不算出货", "check": "logistics.line.loop" },
  { "id": "no-teleport", "check": "logistics.line.no-teleport" },
  { "id": "flow", "check": "logistics.center.flow" },
  { "id": "quiet", "check": "scene.deterministic.quiet", "params": { "maxEvents": 0 } }
]
```

可用内置 id（实现见 `packages/scene-cli/src/invariants.ts`，参数默认值见 `examples/packages/README.md`）：

| id | 断言什么 |
|---|---|
| `logistics.line.loop` | 环线包裹 `exit == enter − 1`：仍在环上，绕圈不算出货 |
| `logistics.line.no-teleport` | 包裹沿闭环路径连续运动（`loop` 必须 `repeat`、弧长不越界、速度非负） |
| `logistics.center.flow` | 闭环中心全链路都有事件：产出 → 打包 → 入库 → 出库 → 运走 |
| `logistics.center.conservation` | 小货物与托盘在全链路中守恒 |
| `scene.deterministic.quiet` | 观察窗内事件数不超上限，且随机源没被消耗 |

`logistics.center.*` 是**从 `plugins-logistics` 借的引用**（与 Studio 审计面板同一份对象，惰性 import），
不是 CLI 里抄的副本——别给非闭环场景硬挂，否则会把"这条链路本来就没有"报成违例。
想加新的场景类型，优先在插件侧写运行时不变量（见 §1），再注册进内置表，**不要复制规则**。

示例：`examples/packages/hello`（挂 `scene.deterministic.quiet`）、`examples/community/mini-line`（挂 `loop` / `no-teleport`）。

### 手上已有模型？先 introspect，不必从 0 手搭

外部贡献最常见的痛点是"对接麻烦、要从零搭场景"。这一层不解决"怎么建孪生"（那是 Ditto / FIWARE 的地盘，见 README「不是什么」），
但已有一条**把现有工件搬进验证链**的路：`adapters/introspector` 只读识别工件（不执行外部代码），产出可运行场景草案，
喂给对应适配器跑出公共 trace，再用 `bun run scene verify` 从 TypeScript 侧**重算**哈希（外部产物不自证）：

```bash
python3 adapters/introspector/run.py --target <你的.xosc|.fmu|.py|.csv> \
  --out .scene-ci/introspect --emit-spec .scene-ci/introspect/spec.json
python3 adapters/openscenario/run.py --spec .scene-ci/introspect/spec.json --out .scene-ci/introspect/run
bun run scene verify .scene-ci/introspect/run/trace.json
```

草案**不是文档**：OpenSCENARIO / OpenDRIVE 草案被单测直接拿去真跑并通过不变量。边界见 §3 与 [通用 introspector 文档](./adapters/introspector/README.md)。

## 3. 写一个 runtime adapter

adapter 的契约是**外部 runtime → SceneTrace → 不变量 → 报告 / CI**，不要求继承 `TwinWorld`。
参考三类：

- `adapters/simpy`：离散事件模型；`simpy.generic.v1` 还能在受限沙箱里跑任意模型文件；
- `adapters/fmu`：FMI 2.0 Co-Simulation，真加载 FMU 二进制；
- `adapters/openscenario`：外部场景格式导入；`adapters/opendrive` 负责路网解算。

adapter 必须做到：

1. 输入可锁定：场景 / 配置 / 插件版本 / seed 都进 trace；
2. 只产出 plain JSON，复用 `adapters/scene_spec.py` 的 canonical JSON 与 FNV-1a；
3. 不变量只读 trace，不信模型自报“成功”；
4. 不支持的构造明确拒绝，不静默降级；
5. 至少包含：同输入确定性测试、异输入分叉测试、一个会被抓住的篡改测试。

## 4. 写一个插件

- manifest 声明的能力必须与实际贡献一致；
- `activate()` 必须同步；
- 行为顺序即契约，注册顺序不要乱改；
- 新行为必须能过 `packages/plugin-conformance` 的全部检查；

```ts
import { runConformance } from '@twin-platform/plugin-conformance';
const report = runConformance({ plugin, scene, steps: 240, sources });
if (!report.passed) throw new Error('插件还不该进公共验证链');
```

设备 / 产线插件有仓库自带 skill，先读再动手；`plugins-<domain>/studio` 只放展示，不放业务真相。

## 5. 提交前门槛

```bash
bun run test
bun run typecheck:packages
bun run typecheck:apps
cd apps/studio && bun x vitest run

# 有外部 adapter 改动时（需要 Python + 可选 SimPy）
python -m unittest discover -s adapters/simpy -p 'test_*.py'
python -m unittest discover -s adapters/fmu -p 'test_*.py'
python -m unittest discover -s adapters/openscenario -p 'test_*.py'
python -m unittest discover -s adapters/opendrive -p 'test_*.py'
python -m unittest discover -s adapters/introspector -p 'test_*.py'
```

场景改动请同时交：场景、规则、至少一条反例、基线（如需要更新，说明为什么）。
不接受只加“能动的演示”却没有不变量的 PR。

## 不想让你先做的事

- 先加云数据库 / 权限 / 多租户；
- 先做 LLM 自动生成世界，却没有可复核的 trace；
- 先加复杂 3D 资产，而没有设备语义与确定性测试。

先交一条**别人能复现、能证伪**的规则或场景，社区就好接下去。
