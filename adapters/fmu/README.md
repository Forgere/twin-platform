# FMI 2.0 → SceneTrace Adapter

阶段 3 的第二个外部 runtime：这次驱动的是 **FMU 二进制**（FMI 2.0 Co-Simulation），而不是自研内核或 Python 模型。
`TwinWorld` 全程不参与仿真；公共 `scene-spec`、`scene verify / diff / report` 直接消费产物。

## 支持范围

| 支持 | 不支持 |
| --- | --- |
| FMI 2.0 Co-Simulation | 模型交换（Model Exchange，需要外部求解器） |
| `real` 变量的输入 / 输出 / 参数 | 整型、布尔、字符串变量 |
| 固定步长 `doStep`，固定输入调度 | 变步长、事件模式、状态存取 / 回滚 |
| 解包目录与 `.fmu`（zip） | 需要 license / 加密保护的 FMU |

不支持的格式会被明确拒绝，不静默降级。

## 参考 FMU

仓库自带一个可编译的参考水箱，`ctypes` 会真的加载它：

```text
models/tank/modelDescription.xml   # 变量、valueReference、start、CoSimulation.modelIdentifier
models/tank/sources/tank.c         # fmi2Instantiate / SetupExperiment / DoStep / GetReal / SetReal
```

状态方程：`level += (inflow - outflow_coeff * level) * dt`，确定性、无随机。

## 运行

```bash
python3 adapters/fmu/scripts/build_reference_fmu.py \
  --out-dir .scene-ci/fmu/tank \
  --fmu .scene-ci/fmu/tank.fmu

python3 adapters/fmu/run.py --spec adapters/fmu/scenes/tank-step.json --out .scene-ci/fmu

bun run scene verify .scene-ci/fmu/trace.json --junit .scene-ci/fmu/verify-junit.xml
bun run scene diff .scene-ci/fmu/trace.json adapters/fmu/expected/trace.json
bun run scene report .scene-ci/fmu/trace.json .scene-ci/fmu/report.json --html .scene-ci/fmu/report.html
```

根脚本：`bun run build:fmu`、`bun run scene:fmu`、`bun run test:fmu`。
Python 单测会现编参考 FMU；没有 C 编译器时自动跳过。

Windows 需要 MSVC（`--compiler cl`），macOS 用 `clang`；二进制路径按 `binaries/<win64|darwin64|linux64>` 查找。

## 不变量

| id | 检查 |
| --- | --- |
| `fmu.input-applied` | 每次输入变更都在 trace 里有 `fmu:input:set`，值一致、无多余事件 |
| `fmu.output-range` | 输出采样始终有限且不越出声明区间 |
| `fmu.time-grid` | 末事件对齐 `stopTime`、采样时间不倒退、事件序号连续 |

审计只读 trace，不信 FMU 自报“成功”。测试会删掉输入事件、把上限压到峰值以下，确认报告能抓出篡改。样本不足只给警告，不把“没采到”包装成“没有变化”。

## 跨语言契约

`fmi.py` 复用 `adapters/scene_spec.py`（与 SimPy adapter 同一份 canonical JSON 与 UTF-16 FNV-1a），因此 TypeScript `scene verify` 能重算外部 FMU trace 的 `eventHash / stateHash`。报告和 trace 都不写挂钟时间，同输入产物逐字节一致。
