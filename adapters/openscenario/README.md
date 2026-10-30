# OpenSCENARIO → SceneTrace Importer

第三个外部 adapter：这次导入的是**别人的场景格式**（ASAM OpenSCENARIO 1.x XML），
转成确定性执行的车辆运动场景，再产出公共 `SceneTrace + AuditReport`。`TwinWorld` 不参与仿真。

## 支持的显式子集

| 支持 | 不支持（明确拒绝） |
| --- | --- |
| OpenSCENARIO 1.x（`FileHeader.revMajor=1`） | 0.9 / 2.x |
| `Entities/ScenarioObject` 中的车辆 | 行人、杂项对象 |
| `Init` 的 `SpeedAction` 与 `PositionAction / TeleportAction` | `WorldPosition`（需要 OpenDRIVE 路网换算） |
| Story 事件里的 `SpeedAction`（绝对 / 相对自身目标，`step` 或 `linear` dynamics） | 相对其它实体的速度目标 |
| Story 事件里的 `PositionAction / TeleportAction`（`LanePosition`） | `LateralAction`、`RoutingAction`、全局 / 环境动作 |
| 触发条件 `SimulationTimeCondition`（`rule=greaterThan`） | 其它触发器（距离、相对位置、自定义条件） |

不支持的构造会抛出带清单的错误，不静默忽略——导入器可以窄，但不能假装覆盖。

道路映射两种模式：

- **无路网（默认）**：本 importer 的直线约定，`LanePosition(roadId, laneId, s)` → `x = s`、`z = laneId * laneWidth`。
- **有 OpenDRIVE**：场景 JSON 加 `opendrive` 字段后，由 `adapters/opendrive` 真解算几何与车道宽度，采样里产出 `x / y / heading`，边界检查按每辆车所在道路的长度与可用车道判定。

```bash
python3 adapters/openscenario/run.py \
  --spec adapters/openscenario/scenes/follow-on-opendrive.json --out .scene-ci/osc-odr
```

## 运行

```bash
python3 adapters/openscenario/run.py \
  --spec adapters/openscenario/scenes/follow-and-accelerate.json \
  --out .scene-ci/osc

bun run scene verify .scene-ci/osc/trace.json --junit .scene-ci/osc/verify-junit.xml
bun run scene diff .scene-ci/osc/trace.json adapters/openscenario/expected/trace.json
bun run scene report .scene-ci/osc/trace.json .scene-ci/osc/report.json --html .scene-ci/osc/report.html
```

根脚本：`bun run scene:openscenario`、`bun run test:openscenario`。

`scenes/follow-and-accelerate.xosc` 是参考样例：ego 与前车同车道，4s 后 ego 提速、6s 后前车按线性 dynamics 提速拉开距离；旁车道另有一辆车。
`scenes/follow-on-opendrive.json` 是同一场景接 `adapters/opendrive/scenes/two-road-curve.xodr` 的组合样例，用来验证“不再靠直线假设”。

## 不变量

| id | 检查 |
| --- | --- |
| `openscenario.actions-applied` | 导入的每个动作在 trace 里逐条落地，值一致、无多余事件 |
| `openscenario.road-bounds` | 车辆始终在声明车道与里程范围内，采样时间单调 |
| `openscenario.speed-limit` | 速度不超过场景声明上限 |
| `openscenario.gap` | 同车道车辆保持最小纵向车距（穿模 / 追尾会被抓住） |

审计只读 trace，不信导入器自报。测试会删掉速度事件、把车放到路外、把 `minGap` 调到不可能，确认报告能抓出篡改。

样例最初用的是“ego 提速追上前车”，结果 `gap` 检查如实报违例；样例随后改成前车提速拉开距离。这正是这套设施要的效果：**模型说故事，不变量说真话**。

## 跨语言契约

`osc.py` 复用 `adapters/scene_spec.py`（与 SimPy / FMI adapter 同一份 canonical JSON 与 UTF-16 FNV-1a），因此 TypeScript `scene verify` 能重算导入场景 trace 的 `eventHash / stateHash`。报告和 trace 都不写挂钟时间，同输入产物逐字节一致。
