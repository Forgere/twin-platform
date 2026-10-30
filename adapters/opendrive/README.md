# OpenDRIVE 路网求解

OpenSCENARIO importer 之前偷懒的一步：把 `LanePosition(roadId, laneId, s, offset)` **真解算**成世界坐标。
`adapters/opendrive/` 解析 OpenDRIVE 1.x 的显式子集，计算参考线几何、车道横向偏移、路网连通性与路由。

## 支持子集

| 支持 | 不支持（明确拒绝） |
| --- | --- |
| `planView/geometry`：`line`、`arc`（常数曲率） | `spiral`、`poly3`、`paramPoly3` |
| `lanes/laneOffset`、`laneSection/lane/width`（三次多项式） | 高程 `elevationProfile`、超高 `lateralProfile` |
| `road/link` 前驱 / 后继 | 路口内部的车道级路径 |
| `junction/connection` 的进出口连接（用于连通性与路由） | 复杂路口几何求解 |

坐标约定：正 `t` 在参考线左侧；车道中心偏移由车道宽度逐条累加得到，`offset` 相对车道中心。

## 与 OpenSCENARIO importer 的接线

没有路网时，importer 退回直线假设（`x = s`、`z = laneId * laneWidth`）。
场景 spec 里给 `opendrive` 后，importer 会：

- 按 `roadId` 逐车取道路长度与可用车道做边界检查；
- 采样里额外产出解算后的 `x / y / heading`；
- 同车道车距按 `(roadId, laneId)` 分组，不再把不同道路的同号车道混在一起。

组合场景：`adapters/openscenario/scenes/follow-on-opendrive.json`。

## 运行

```bash
python3 adapters/opendrive/run.py \
  --spec adapters/opendrive/scenes/two-road-curve.json \
  --out .scene-ci/odr

bun run scene verify .scene-ci/odr/trace.json
bun run scene diff .scene-ci/odr/trace.json adapters/opendrive/expected/trace.json
bun run scene report .scene-ci/odr/trace.json .scene-ci/odr/report.json --html .scene-ci/odr/report.html
```

根脚本：`bun run scene:opendrive`、`bun run test:opendrive`。

参考路网 `scenes/two-road-curve.xodr`：Road 0 是 100m 直线 + 100m 圆弧，Road 1 接在其末端；查询同时覆盖直线段、圆弧段、另一条道路与 0 → 1 的路由。

## 不变量

| id | 检查 |
| --- | --- |
| `opendrive.geometry-continuity` | 几何段首尾相接、总长等于 `road.length`、端点坐标一致 |
| `opendrive.lane-widths` | 车道宽度为正，首个 `laneSection` 从 `s=0` 开始 |
| `opendrive.queries-resolved` | 位置 / 路由查询都解出有限结果 |
| `opendrive.connectivity` | 每条道路至少有出边或入边，或属于某个路口 |

审计只读 trace 与解析结果；不支持几何（`spiral` / `paramPoly3`）在解析阶段就拒绝，不静默降级。

## 当前边界

- 不做高程与超高，因此 `LanePosition` 的 `z` 语义仍由调用方决定；
- 车辆跨道路行驶不做车道级自动换路：`s` 超出当前道路长度会被边界检查抓住；
- 路由按道路级 Dijkstra，权重是道路长度，不是车道级路径长度。
