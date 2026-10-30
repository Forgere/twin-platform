# SimPy → SceneTrace Adapter

这是阶段 3 的外部 runtime 证据：**同一条场景验证链不再只服务 `world-kernel`**。
模型由 Python + SimPy 推进，TypeScript 内核不参与仿真；公共 `scene-spec`、CLI、HTML 与 JUnit 直接消费它的产物。

## 两种运行方式

| adapter id | 对象 | 说明 |
| --- | --- | --- |
| `simpy.factory.v1` | 内置两段产线模型 | 不执行外部代码；参数化到料 / 加工 / 检测 |
| `simpy.generic.v1` | **任意** SimPy 模型文件 | AST 静态预检 + 受限沙箱执行 + 运行时自动追踪 |

### 通用执行器（`simpy.generic.v1`）

```json
{
  "adapter": "simpy.generic.v1",
  "sceneId": "simpy-generic-two-stage",
  "model": "adapters/simpy/models/two_stage.py",
  "entrypoint": "run",
  "seed": 23,
  "until": 240,
  "params": { "machineCapacity": 2, "inspectorCapacity": 1 }
}
```

```bash
python3 adapters/simpy/run.py \
  --spec adapters/simpy/scenes/two-stage-generic.json --out .scene-ci/simpy-generic
bun run scene diff .scene-ci/simpy-generic/trace.json adapters/simpy/expected-generic/trace.json
```

安全边界：

1. **AST 静态预检**：`os / sys / time / datetime / uuid / subprocess / socket` 等导入，以及 `open / eval / exec / compile / input` 调用直接拒绝。
2. **受限执行**：白名单导入（`simpy / random / math / itertools / statistics / json / typing / dataclasses`），危险 builtins 被禁用；`random` 换成代理，模块级随机函数抛错，只允许 `random.Random(seed)`。
3. **自动追踪**：`simpy.Environment` 与 `simpy.Resource` 换成带记录的子类，产出进程生命周期、资源请求 / 获得 / 释放与队列峰值事件，模型不需要自己打点。

入口函数按参数名注入：`env / rng / seed / params / until / recorder`。通用执行器的不变量是
`simpy.generic.static-safety`、`simpy.generic.executed`、`simpy.generic.resources`、`simpy.generic.determinism`、`simpy.generic.time-order`。

## 内置模型

`scenes/two-stage-cell.json` 描述一条两段产线：

```text
指数随机到料 → 加工（2 个并行资源）→ 检测（1 个资源）→ 完成
```

- 所有随机来自 `random.Random(seed)`，没有全局随机与挂钟；
- SimPy 的进程创建顺序就是同时刻事件的顺序；
- `step` 在外部 DES 中表示**观察网格**，不是强制积分步长；`duration` 必须是它的整数倍；
- 插件锁同时记录 `simpy` 版本、adapter 版本与配置 hash。

## 运行

```bash
python3 -m venv .venv-simpy
.venv-simpy/bin/pip install -r adapters/simpy/requirements.txt

# 外部 runtime 执行 + 原生不变量审计
.venv-simpy/bin/python adapters/simpy/run.py \
  --spec adapters/simpy/scenes/two-stage-cell.json \
  --out .scene-ci/simpy

# TypeScript 端重算哈希并验收事件序列（不信对端自报）
bun run scene verify .scene-ci/simpy/trace.json --junit .scene-ci/simpy/verify-junit.xml

# 现有 CLI 直接渲染外部报告与 JUnit
bun run scene report .scene-ci/simpy/trace.json .scene-ci/simpy/report.json \
  --html .scene-ci/simpy/report.html --junit .scene-ci/simpy/junit.xml

# 与黄金基线比对（首次用 --out adapters/simpy/expected 生成）
bun run scene diff .scene-ci/simpy/trace.json adapters/simpy/expected/trace.json \
  --junit .scene-ci/simpy/diff-junit.xml
```

根脚本等价：`bun run scene:simpy --spec ... --out ...`，`bun run test:simpy` 跑 Python 单测（当前 Python 环境需已安装依赖）。
黄金基线：内置模型在 `expected/`，通用执行器在 `expected-generic/`。

通用 introspector 会从 `params.get("key", default)` 的默认值**自动推断参数**，草案不再一律是空 `params`；没推断出的参数仍需人工补齐。

## 不变量

| id | 检查 |
| --- | --- |
| `simpy.factory.chain` | 每个工件都按到料 → 加工开始/结束 → 检测开始 → 完成；事件序号与时间单调 |
| `simpy.factory.capacity` | 由事件重算资源占用，任何时刻都不超过声明容量 |
| `simpy.factory.conservation` | `created = completed + wip`，且与事件中的工件数一致 |

审计只读 trace，不信模型自己声明的“成功”。测试会删掉完成事件、注入额外开工事件，确认报告能抓出篡改。观察窗内完成数不足只给警告，不把“没观察到”包装成“没有差异”。

## 跨语言契约

`adapters/scene_spec.py` 复刻 `packages/scene-spec` 的必要规则：对象键排序、JS 数字表示、UTF-16 code unit 上的 FNV-1a。`trace.json` 的 `sceneHash / eventHash / stateHash` 因而能与 TypeScript 端按同一算法复核。报告和 trace 都不写生成时间，同输入产物逐字节一致。

内置模型限定为 `simpy.factory.v1`；通用执行器可跑任意 SimPy 文件，但要求模型只用注入 `rng`。通用 introspector 见 `adapters/introspector`。新增外部模型时，应保持“场景输入 → trace → 不变量”的边界，不需要修改 `world-kernel`。
