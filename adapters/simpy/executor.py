"""通用 SimPy 执行器：让**任意** SimPy 模型文件直接跑成 SceneTrace。

安全边界（按顺序）：
1. **AST 静态预检**：危险导入（`os / sys / time / datetime / uuid / subprocess / socket`…）
   与 `open / eval / exec / compile / input` 调用直接拒绝；
2. **受限执行**：替换 `__import__` 与危险 builtins，模型只能用白名单模块；
   `random` 被换成代理：模块级随机函数抛错，只允许 `random.Random(seed)`；
3. **可追踪运行时**：`simpy.Environment` / `simpy.Resource` 换成带记录的子类，
   自动产出进程生命周期与资源排队 / 占用事件，不需要模型配合打点。

确定性来自 spec 的 seed 与固定 `until`，以及 SimPy 自身的事件队列顺序。
"""

from __future__ import annotations

import ast
import builtins as real_builtins
import importlib
import inspect
import json
from pathlib import Path
import sys
import types
from typing import Any

import simpy

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.append(str(Path(__file__).resolve().parents[1]))
from scene_spec import stable_hash  # noqa: E402

ADAPTER_ID = "simpy.generic.v1"
VERSION = "0.1.0"

SAFE_IMPORTS = {"simpy", "random", "math", "itertools", "statistics", "json", "typing", "dataclasses"}
DANGEROUS_MODULES = {"os", "sys", "time", "datetime", "uuid", "subprocess", "socket", "requests", "urllib", "threading", "asyncio"}
DANGEROUS_CALLS = {"open", "eval", "exec", "compile", "input", "__import__", "breakpoint"}


class ModelRejected(ValueError):
    pass


def static_precheck(source: str, path: Path) -> dict[str, Any]:
    tree = ast.parse(source)
    imports: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                imports.add(root)
                if root in DANGEROUS_MODULES:
                    raise ModelRejected(f"第 {node.lineno} 行导入了危险模块 {root}")
                if root not in SAFE_IMPORTS:
                    raise ModelRejected(f"第 {node.lineno} 行导入了白名单外的模块 {root}")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            imports.add(root)
            if root in DANGEROUS_MODULES:
                raise ModelRejected(f"第 {node.lineno} 行从危险模块 {root} 导入")
            if root and root not in SAFE_IMPORTS:
                raise ModelRejected(f"第 {node.lineno} 行从白名单外的模块 {root} 导入")
        elif isinstance(node, ast.Call):
            name = getattr(node.func, "id", getattr(node.func, "attr", ""))
            if name in DANGEROUS_CALLS:
                raise ModelRejected(f"第 {node.lineno} 行调用了被禁止的函数 {name}")
        elif isinstance(node, ast.Attribute):
            owner = getattr(node.value, "id", "")
            if owner in DANGEROUS_MODULES:
                raise ModelRejected(f"第 {node.lineno} 行访问了危险模块 {owner}.{node.attr}")
    return {"imports": sorted(imports), "path": str(path)}


class Recorder:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.resources: list[dict[str, Any]] = []
        self.processes: list[dict[str, Any]] = []

    def record(self, kind: str, time: float, entity: str = "", **payload: Any) -> None:
        self.events.append({
            "sequence": len(self.events) + 1,
            "occurredAt": time,
            "type": kind,
            **({"entityId": entity} if entity else {}),
            **({"payload": payload} if payload else {}),
        })


def make_simpy_proxy(recorder: Recorder) -> types.ModuleType:
    """构造带追踪能力的 simpy 代理模块；模型 `import simpy` 时拿到的就是它。"""
    proxy = types.ModuleType("simpy")
    for name in dir(simpy):
        if not name.startswith("_"):
            setattr(proxy, name, getattr(simpy, name))

    stats: dict[str, dict[str, Any]] = {}

    class TracedResource(simpy.Resource):
        def __init__(self, env, capacity: int = 1):
            super().__init__(env, capacity)
            self.traced_env = env
            self.traced_name = f"resource-{len(recorder.resources) + 1}"
            recorder.resources.append({
                "name": self.traced_name,
                "capacity": capacity,
                "requests": 0,
                "acquires": 0,
                "releases": 0,
                "queuePeak": 0,
                "maxUsers": 0,
            })
            stats[self.traced_name] = recorder.resources[-1]

        def request(self):
            event = super().request()
            entry = stats[self.traced_name]
            entry["requests"] += 1
            entry["queuePeak"] = max(entry["queuePeak"], len(self.queue))
            recorder.record("resource:request", self._env.now, self.traced_name, queue=len(self.queue), users=len(self.users), capacity=entry["capacity"])

            def on_acquired(_event):
                entry["acquires"] += 1
                entry["maxUsers"] = max(entry["maxUsers"], len(self.users))
                recorder.record("resource:acquire", self.traced_env.now, self.traced_name, queue=len(self.queue), users=len(self.users), capacity=entry["capacity"])

            event.callbacks.append(on_acquired)
            return event

        def release(self, request):
            entry = stats[self.traced_name]
            entry["releases"] += 1
            recorder.record("resource:release", self._env.now, self.traced_name, queue=len(self.queue), users=max(0, len(self.users) - 1), capacity=entry["capacity"])
            return super().release(request)

    class TracedEnvironment(simpy.Environment):
        def process(self, generator):
            name = getattr(generator, "__name__", "process")
            process_id = f"proc-{len(recorder.processes) + 1}"
            entry = {"id": process_id, "process": name, "starts": 0, "ends": 0, "errors": 0}
            recorder.processes.append(entry)

            def wrapped():
                recorder.record("sim:process:start", self.now, process_id, process=name)
                entry["starts"] += 1
                try:
                    result = yield from generator
                except GeneratorExit:
                    # 未跑完的进程被回收时会被 close()；这不是模型错误，不能补一条事件，
                    # 否则 trace 会在算完哈希后又被改写（GC 时机不确定 = 不可复现）。
                    raise
                except BaseException:
                    recorder.record("sim:process:error", self.now, process_id, process=name, ok=False)
                    entry["errors"] += 1
                    raise
                recorder.record("sim:process:end", self.now, process_id, process=name, ok=True)
                entry["ends"] += 1
                return result

            return super().process(wrapped())

        def run(self, until=None):
            result = super().run(until=until)
            recorder.record("sim:completed", self.now, "", now=self.now)
            return result

    proxy.Environment = TracedEnvironment
    proxy.Resource = TracedResource
    return proxy


def make_random_proxy(seed: int) -> types.ModuleType:
    import random as real_random

    proxy = types.ModuleType("random")
    for name in dir(real_random):
        if not name.startswith("_"):
            setattr(proxy, name, getattr(real_random, name))

    def blocked(name: str):
        def raise_error(*_args, **_kwargs):
            raise ModelRejected(f"模型调用了全局 random.{name}：不可复现，请改用 random.Random(seed) 注入的 rng")

        return raise_error

    for name in ("random", "randrange", "randint", "choice", "choices", "uniform", "expovariate", "gauss", "triangular", "shuffle", "sample", "seed"):
        setattr(proxy, name, blocked(name))
    proxy.seed_value = seed  # 只读信息，模型不该依赖它
    return proxy


def safe_builtins(simpy_proxy: types.ModuleType, random_proxy: types.ModuleType) -> dict[str, Any]:
    allowed = {
        name: getattr(real_builtins, name)
        for name in dir(real_builtins)
        if name not in {"open", "eval", "exec", "compile", "input", "breakpoint", "exit", "quit", "help", "memoryview"}
    }

    def restricted_import(name: str, globals=None, locals=None, fromlist=(), level=0):
        root = name.split(".")[0]
        if root in DANGEROUS_MODULES:
            raise ModelRejected(f"禁止导入模块 {root}")
        if root not in SAFE_IMPORTS:
            raise ModelRejected(f"模块 {root} 不在白名单内（允许：{', '.join(sorted(SAFE_IMPORTS))}）")
        if root == "simpy":
            return simpy_proxy
        if root == "random":
            return random_proxy
        return importlib.import_module(name)

    allowed["__import__"] = restricted_import
    allowed["open"] = lambda *args, **kwargs: (_ for _ in ()).throw(ModelRejected("模型禁止使用 open()"))
    return allowed


def validate_spec(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("通用 SimPy 场景必须是 JSON 对象")
    if raw.get("adapter") != ADAPTER_ID:
        raise ValueError(f"adapter 必须是 {ADAPTER_ID}")
    for key in ("sceneId", "model", "until"):
        if key not in raw:
            raise ValueError(f"缺少字段 {key}")
    if float(raw["until"]) <= 0:
        raise ValueError("until 必须是正数")
    if not isinstance(raw.get("seed", 0), int):
        raise ValueError("seed 必须是整数")
    return raw


def run_model(raw_spec: dict[str, Any], runs: int = 2) -> tuple[dict[str, Any], dict[str, Any]]:
    spec = validate_spec(raw_spec)
    path = Path(spec["model"])
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[2] / path
    if not path.exists():
        raise ValueError(f"找不到模型文件：{path}")
    source = path.read_text(encoding="utf-8")
    precheck = static_precheck(source, path)
    entrypoint_name = spec.get("entrypoint", "run")
    seed = int(spec.get("seed", 0))
    until = float(spec["until"])
    params = dict(spec.get("params", {}))

    def execute() -> tuple[Recorder, float, Any]:
        import random as real_random

        recorder = Recorder()
        proxy = make_simpy_proxy(recorder)
        random_proxy = make_random_proxy(seed)
        namespace: dict[str, Any] = {"__name__": "scene_model", "__builtins__": safe_builtins(proxy, random_proxy)}
        exec(compile(source, str(path), "exec"), namespace)
        if entrypoint_name not in namespace:
            raise ModelRejected(f"模型里没有入口函数 {entrypoint_name}")
        entrypoint = namespace[entrypoint_name]
        injected_env = proxy.Environment()
        rng = real_random.Random(seed)
        kwargs: dict[str, Any] = {}
        for name in inspect.signature(entrypoint).parameters:
            if name == "env":
                kwargs[name] = injected_env
            elif name in ("rng", "random"):
                kwargs[name] = rng
            elif name == "seed":
                kwargs[name] = seed
            elif name == "params":
                kwargs[name] = params
            elif name == "until":
                kwargs[name] = until
            elif name == "recorder":
                kwargs[name] = recorder.record
        result = entrypoint(**kwargs)
        env = result if hasattr(result, "run") and hasattr(result, "now") else injected_env
        if float(env.now) <= 0:
            env.run(until=until)
        return recorder, float(env.now), result

    recorder, env_now, result = execute()
    repeated_hashes = []
    for _ in range(max(1, runs) - 1):
        repeat, _, _ = execute()
        repeated_hashes.append(stable_hash(repeat.events))

    model_output = None
    if result is not None and not (hasattr(result, "run") and hasattr(result, "now")):
        try:
            model_output = json.loads(json.dumps(result))
        except (TypeError, ValueError):
            model_output = None

    final_state = {
        "runtime": "simpy-generic",
        "model": {"file": str(Path(spec["model"]).as_posix()), "entrypoint": entrypoint_name, "imports": precheck["imports"]},
        "seed": seed,
        "until": until,
        "envNow": env_now,
        "params": params,
        "processes": recorder.processes,
        "resources": recorder.resources,
        **({"modelOutput": model_output} if model_output is not None else {}),
    }
    trace = {
        "formatVersion": 1,
        "sceneId": spec["sceneId"],
        "sceneHash": stable_hash(spec),
        "seed": seed,
        "step": 0,
        "steps": 0,
        "plugins": [
            {"id": "simpy", "version": simpy.__version__},
            {"id": "scene-adapter-simpy-generic", "version": VERSION, "configHash": stable_hash(spec)},
        ],
        "actions": [],
        "events": recorder.events,
        "finalState": final_state,
        "eventHash": stable_hash(recorder.events),
        "stateHash": stable_hash(final_state),
    }
    return trace, audit_trace(trace, spec, repeated_hashes)


def audit_trace(trace: dict[str, Any], spec: dict[str, Any], repeated_hashes: list[str] | None = None) -> dict[str, Any]:
    repeated = repeated_hashes or []
    final_state = trace["finalState"]
    minimum_events = int(spec.get("minimumEvents", 1))
    violations: dict[str, list[dict[str, str]]] = {"safety": [], "executed": [], "resources": [], "time": []}
    notes: dict[str, list[str]] = {"safety": [], "executed": [], "resources": [], "time": []}

    imports = final_state["model"]["imports"]
    risky = [item for item in imports if item in DANGEROUS_MODULES]
    if risky:
        violations["safety"].append({"where": ",".join(risky), "message": "模型导入了危险模块"})
    notes["safety"].append(f"静态预检通过：只允许 {', '.join(imports) or '无'}，禁用 open / eval / 全局 random")

    events = trace["events"]
    if len(events) < minimum_events:
        violations["executed"].append({"where": "events", "message": f"只记录 {len(events)} 条事件，少于要求的 {minimum_events} 条"})
    if final_state["envNow"] > final_state["until"] + 1e-9:
        violations["executed"].append({"where": "env.now", "message": f"仿真结束时间 {final_state['envNow']} 超过 until {final_state['until']}"})
    if not final_state["processes"]:
        violations["executed"].append({"where": "processes", "message": "没有追踪到任何 SimPy 进程"})
    notes["executed"].append(f"{len(final_state['processes'])} 个进程、{len(events)} 条事件，运行到 {final_state['envNow']}")

    for resource in final_state["resources"]:
        if resource["maxUsers"] > resource["capacity"]:
            violations["resources"].append({"where": resource["name"], "message": f"并发占用 {resource['maxUsers']} 超过容量 {resource['capacity']}"})
        if resource["releases"] > resource["acquires"]:
            violations["resources"].append({"where": resource["name"], "message": f"释放 {resource['releases']} 次多于获得 {resource['acquires']} 次"})
        if resource["queuePeak"] < 0:
            violations["resources"].append({"where": resource["name"], "message": "队列峰值为负"})
    notes["resources"].append(f"{len(final_state['resources'])} 个资源：容量占用与释放次数自洽")

    previous = None
    for index, event in enumerate(events, start=1):
        if event["sequence"] != index:
            violations["time"].append({"where": str(index), "message": "事件序号不连续"})
            break
        if previous is not None and event["occurredAt"] < previous:
            violations["time"].append({"where": str(index), "message": "事件时间倒退"})
            break
        previous = event["occurredAt"]
    notes["time"].append("事件序号连续、仿真时间单调")

    determinism_violations: list[dict[str, str]] = []
    for candidate in repeated:
        if candidate != trace["eventHash"]:
            determinism_violations.append({"where": "eventHash", "message": f"重跑得到 {candidate}，与本次 {trace['eventHash']} 不一致"})
    checks = [{
        "id": "simpy.generic.static-safety",
        "description": "静态预检与受限执行：无危险导入、无 open / eval、无全局随机",
        "status": "pass" if not violations["safety"] else "fail",
        "violations": violations["safety"],
        "notes": notes["safety"],
    }, {
        "id": "simpy.generic.executed",
        "description": "模型跑完并追踪到进程与事件",
        "status": "pass" if not violations["executed"] else "fail",
        "violations": violations["executed"],
        "notes": notes["executed"],
    }, {
        "id": "simpy.generic.resources",
        "description": "资源并发不超过容量，释放不超过获得",
        "status": "pass" if not violations["resources"] else "fail",
        "violations": violations["resources"],
        "notes": notes["resources"],
    }, {
        "id": "simpy.generic.determinism",
        "description": "同 spec 重跑得到相同事件流",
        "status": "pass" if not determinism_violations else "fail",
        "violations": determinism_violations,
        "notes": [f"比较 {len(repeated) + 1} 次运行的 eventHash"],
    }, {
        "id": "simpy.generic.time-order",
        "description": "事件序号连续、仿真时间单调",
        "status": "pass" if not violations["time"] else "fail",
        "violations": violations["time"],
        "notes": notes["time"],
    }]
    return {
        "formatVersion": 1,
        "sceneId": trace["sceneId"],
        "passed": all(check["status"] == "pass" for check in checks),
        "checks": checks,
        "metrics": {
            "events": len(events),
            "processes": len(final_state["processes"]),
            "resources": len(final_state["resources"]),
            "queuePeak": max((item["queuePeak"] for item in final_state["resources"]), default=0),
            "envNow": final_state["envNow"],
            "runs": len(repeated) + 1,
        },
        "warnings": [] if final_state.get("modelOutput") is not None else ["模型返回值不是 env，也不是可序列化对象：未记入 finalState"],
    }
