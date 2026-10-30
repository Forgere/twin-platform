# 通用 Introspector

阶段 3 之后的收口：**不用为每个外部模型各写一个解析器**，也能先把工件看清楚。
`adapters/introspector/` 对外部模型做只读取样的 introspection，产出模型事实、可运行场景草案和审计发现。

## 三条纪律

1. **不执行外部代码**：Python 模型只做 AST 静态分析；FMU 只读 `modelDescription.xml` 与压缩包条目，不加载二进制；OpenSCENARIO 只解析 XML。
2. **不假装覆盖**：不支持的构造、缺失二进制、挂钟 / 全局随机，都进 findings，不静默忽略。
3. **产物可复核**：introspection 与 report 不写挂钟时间，同输入逐字节一致。

## 支持的目标

| 目标 | 识别 | 抽取事实 | 场景草案 |
| --- | --- | :---: | --- |
| `.fmu` / 解包 FMU / `modelDescription.xml` | `fmi` | FMI 版本、变量、causality、start、平台二进制 | 有（`fmi.co-simulation.v1`） |
| OpenSCENARIO `.xosc` / `.xml` | `openscenario` | 版本、车辆、车道 / 里程、动作、触发时刻 | 有（`openscenario.importer.v1`） |
| OpenDRIVE `.xodr` | `opendrive` | 版本、道路长度、几何类型、车道、路口、连接边 | 有（`opendrive.network.v1`） |
| SimPy / Python `.py` | `simpy` / `python` | imports、`Resource` 容量、常量 timeout、指数分布均值、进程函数、入口函数 | 有（`simpy.generic.v1`，需发现 `run / main / simulate` 入口） |
| 运行场景 `.json` | `scene-spec` | adapter 与字段清单 | 原样回传 |
| 其它 | `unknown` | 无 | 无 |

草案不是文档：OpenSCENARIO 与 OpenDRIVE 草案会被单测直接拿去 `run_scenario()` / `run_network()`，必须真的跑通并通过不变量。

## 运行

```bash
python3 adapters/introspector/run.py \
  --target adapters/openscenario/scenes/follow-and-accelerate.xosc \
  --out .scene-ci/introspect/osc \
  --emit-spec .scene-ci/introspect/osc-spec.json

python3 adapters/introspector/run.py \
  --target adapters/fmu/models/tank/modelDescription.xml \
  --out .scene-ci/introspect/fmu

python3 adapters/introspector/run.py \
  --target adapters/opendrive/scenes/two-road-curve.xodr \
  --out .scene-ci/introspect/odr --emit-spec .scene-ci/introspect/odr-spec.json
```

根脚本：`bun run scene:introspect`、`bun run test:introspect`。

## 审计发现与检查

findings 分三级：`error`（不可运行 / 不确定性来源）、`warning`（需要人工确认）、`info`（已做什么）。
report 的四条检查：

- `introspector.detected`：目标属于已知模型族。
- `introspector.supported-subset`：不支持构造与缺失依赖都被显式列出。
- `introspector.determinism`：未发现挂钟 / 全局随机。
- `introspector.evidence`：抽取到变量 / 实体 / 资源等可核对事实。

## 当前边界

- SimPy 侧有通用执行器（`adapters/simpy`，`simpy.generic.v1`），但 introspector 只生成草案：空 `params` 与 `until=60` 需要人工核对，且模型必须只用注入 `rng` 才可复现。
- FMU 草案只跟踪第一个 output 变量。
- OpenDRIVE 草案只生成“位置 + 路由”查询，不推断车道级行驶路径；路网求解细节见 [OpenDRIVE 文档](../opendrive/README.md)。
- introspection 不替代运行：最终证据仍然来自 adapter 跑出来的 `SceneTrace`。
