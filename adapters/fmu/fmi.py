"""FMI 2.0 Co-Simulation adapter：加载真实 FMU 二进制，产出公共 trace + report。

只支持 FMI 2.0 Co-Simulation 的 real 变量；不支持事件模式、状态存取、整型/布尔。
随机不参与：FMU 按固定步长推进，输入调度来自场景 spec，因此同输入可逐位复现。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import platform
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from typing import Any

import ctypes

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scene_spec import stable_hash  # noqa: E402

ADAPTER_ID = "fmi.co-simulation.v1"
ADAPTER_VERSION = "0.1.0"
FMI2_STATUS = {0: "ok", 1: "warning", 2: "discard", 3: "error", 4: "fatal", 5: "pending"}


@dataclass
class Variable:
    name: str
    value_reference: int
    causality: str
    variability: str
    start: float | None


@dataclass
class ModelDescription:
    fmi_version: str
    model_name: str
    guid: str
    model_identifier: str
    variables: dict[str, Variable]

    def require(self, name: str) -> Variable:
        variable = self.variables.get(name)
        if variable is None:
            raise ValueError(f"FMU 没有 real 变量 {name}")
        return variable


def parse_model_description(path: Path) -> ModelDescription:
    root = ET.parse(path).getroot()
    fmi_version = root.attrib.get("fmiVersion", "")
    if not fmi_version.startswith("2.0"):
        raise ValueError(f"只支持 FMI 2.0，收到 {fmi_version or '未知版本'}")
    co_simulation = root.find("CoSimulation")
    if co_simulation is None:
        raise ValueError("只支持 FMI 2.0 Co-Simulation；modelDescription 里没有 CoSimulation。")
    identifier = co_simulation.attrib.get("modelIdentifier")
    if not identifier:
        raise ValueError("CoSimulation 缺少 modelIdentifier。")
    variables: dict[str, Variable] = {}
    container = root.find("ModelVariables")
    for scalar in container if container is not None else []:
        child = None
        for tag in ("Real", "Integer", "Boolean"):
            candidate = scalar.find(tag)
            if candidate is not None:
                child = candidate
                break
        if child is None or child.tag != "Real":
            continue  # adapter 只驱动 real 变量
        try:
            reference = int(scalar.attrib["valueReference"])
        except (KeyError, ValueError):
            raise ValueError(f"变量 {scalar.attrib.get('name')} 的 valueReference 非法")
        start_text = child.attrib.get("start")
        variables[scalar.attrib["name"]] = Variable(
            name=scalar.attrib["name"],
            value_reference=reference,
            causality=scalar.attrib.get("causality", "local"),
            variability=scalar.attrib.get("variability", "continuous"),
            start=float(start_text) if start_text is not None else None,
        )
    return ModelDescription(
        fmi_version=fmi_version,
        model_name=root.attrib.get("modelName", ""),
        guid=root.attrib.get("guid", ""),
        model_identifier=identifier,
        variables=variables,
    )


class FmuError(RuntimeError):
    pass


# FMI2 回调结构体：logger 是函数指针，其余三项本 adapter 不用（FMU 若调用会失败而非静默）。
LOGGER = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_char_p)


class Callbacks(ctypes.Structure):
    _fields_ = [
        ("logger", LOGGER),
        ("allocateMemory", ctypes.c_void_p),
        ("freeMemory", ctypes.c_void_p),
        ("stepFinished", ctypes.c_void_p),
        ("componentEnvironment", ctypes.c_void_p),
    ]


class Fmu:
    """ctypes 绑定的最小 FMI 2.0 CS 客户端。"""

    def __init__(self, root: Path, description: ModelDescription):
        self.description = description
        system = platform.system().lower()
        folder = "win64" if system == "windows" else "darwin64" if system == "darwin" else "linux64"
        suffix = "dll" if folder == "win64" else "dylib" if folder == "darwin64" else "so"
        candidates = [
            root / "binaries" / folder / f"{description.model_identifier}.{suffix}",
            root / "binaries" / folder / f"lib{description.model_identifier}.{suffix}",
        ]
        binary = next((path for path in candidates if path.exists()), None)
        if binary is None:
            raise FmuError(f"找不到 FMU 二进制：{candidates[0]}")
        self.library = ctypes.CDLL(str(binary))
        self._bind()
        callbacks = Callbacks()
        callbacks.logger = LOGGER(lambda *args: None)
        self.component = self.library.fmi2Instantiate(
            b"scene-adapter", 1, description.guid.encode("utf-8"), str(root).encode("utf-8"),
            ctypes.byref(callbacks), 0, 0,
        )
        if not self.component:
            raise FmuError("fmi2Instantiate 返回空实例")

    def _bind(self) -> None:
        uint = ctypes.c_uint
        size = ctypes.c_size_t
        self.library.fmi2Instantiate.restype = ctypes.c_void_p
        self.library.fmi2Instantiate.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
        for name in ("fmi2SetupExperiment",):
            getattr(self.library, name).restype = ctypes.c_int
            getattr(self.library, name).argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_double, ctypes.c_double, ctypes.c_int, ctypes.c_double]
        for name in ("fmi2EnterInitializationMode", "fmi2ExitInitializationMode", "fmi2Terminate"):
            getattr(self.library, name).restype = ctypes.c_int
            getattr(self.library, name).argtypes = [ctypes.c_void_p]
        self.library.fmi2FreeInstance.argtypes = [ctypes.c_void_p]
        self.library.fmi2SetReal.restype = ctypes.c_int
        self.library.fmi2SetReal.argtypes = [ctypes.c_void_p, ctypes.POINTER(uint), size, ctypes.POINTER(ctypes.c_double)]
        self.library.fmi2GetReal.restype = ctypes.c_int
        self.library.fmi2GetReal.argtypes = [ctypes.c_void_p, ctypes.POINTER(uint), size, ctypes.POINTER(ctypes.c_double)]
        self.library.fmi2DoStep.restype = ctypes.c_int
        self.library.fmi2DoStep.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_double, ctypes.c_int]

    def _status(self, code: int, call: str) -> None:
        if code not in (0, 1):
            raise FmuError(f"{call} 返回 {FMI2_STATUS.get(code, code)}")

    def set_real(self, name: str, value: float) -> None:
        variable = self.description.require(name)
        references = (ctypes.c_uint * 1)(variable.value_reference)
        values = (ctypes.c_double * 1)(float(value))
        self._status(self.library.fmi2SetReal(self.component, references, 1, values), f"setReal({name})")

    def get_real(self, name: str) -> float:
        variable = self.description.require(name)
        references = (ctypes.c_uint * 1)(variable.value_reference)
        values = (ctypes.c_double * 1)(0)
        self._status(self.library.fmi2GetReal(self.component, references, 1, values), f"getReal({name})")
        return float(values[0])

    def initialize(self, start_time: float, stop_time: float, parameters: dict[str, float]) -> None:
        self._status(self.library.fmi2SetupExperiment(self.component, 0, 0.0, start_time, 1, stop_time), "setupExperiment")
        self._status(self.library.fmi2EnterInitializationMode(self.component), "enterInitializationMode")
        for name, variable in self.description.variables.items():
            if variable.causality in ("input", "parameter") and variable.start is not None and name not in parameters:
                self.set_real(name, variable.start)
        for name, value in parameters.items():
            self.set_real(name, value)
        self._status(self.library.fmi2ExitInitializationMode(self.component), "exitInitializationMode")

    def do_step(self, current: float, step: float) -> None:
        self._status(self.library.fmi2DoStep(self.component, current, step, 0), "doStep")

    def close(self) -> None:
        try:
            self.library.fmi2Terminate(self.component)
        finally:
            self.library.fmi2FreeInstance(self.component)


def _open_fmu(path: Path) -> tuple[Path, ModelDescription, Any]:
    """支持解包目录与 .fmu（zip）；.fmu 解压到临时目录，退出时清理。"""
    if path.is_dir():
        description = parse_model_description(path / "modelDescription.xml")
        return path, description, None
    if path.suffix == ".fmu" and zipfile.is_zipfile(path):
        temporary = tempfile.TemporaryDirectory(prefix="scene-adapter-fmu-")
        root = Path(temporary.name)
        with zipfile.ZipFile(path) as archive:
            archive.extractall(root)
        description = parse_model_description(root / "modelDescription.xml")
        return root, description, temporary
    raise ValueError(f"{path} 既不是解包 FMU 目录，也不是 .fmu 压缩包")


def validate_spec(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("FMI 场景必须是 JSON 对象")
    if raw.get("adapter") != ADAPTER_ID:
        raise ValueError(f"adapter 必须是 {ADAPTER_ID}")
    for key in ("sceneId", "fmu", "step", "stopTime", "variables"):
        if key not in raw:
            raise ValueError(f"缺少字段 {key}")
    if not isinstance(raw["variables"], dict) or "output" not in raw["variables"]:
        raise ValueError("variables 至少要有 output 变量名")
    step = raw["step"]
    start = float(raw.get("startTime", 0))
    stop = float(raw["stopTime"])
    if not isinstance(step, (int, float)) or step <= 0 or stop <= start:
        raise ValueError("step 必须是正数，且 stopTime 大于 startTime")
    if abs((stop - start) / step - round((stop - start) / step)) > 1e-9:
        raise ValueError("stopTime - startTime 必须是 step 的整数倍")
    for item in raw.get("inputs", []):
        if not isinstance(item, dict) or "at" not in item or "value" not in item:
            raise ValueError("每个 inputs 项都需要 at 与 value")
        if not start <= float(item["at"]) <= stop:
            raise ValueError(f"输入时刻 {item['at']} 不在仿真区间内")
    return raw


def run_fmu(raw_spec: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    spec = validate_spec(raw_spec)
    path = Path(spec["fmu"])
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[2] / path  # 相对路径以仓库根为基准
    if not path.exists():
        raise ValueError(f"找不到 FMU：{path}")
    root, description, temporary = _open_fmu(path)
    try:
        start = float(spec.get("startTime", 0))
        stop = float(spec["stopTime"])
        step = float(spec["step"])
        steps = int(round((stop - start) / step))
        input_name = spec["variables"].get("input")
        output_name = spec["variables"]["output"]
        limit_min = float(spec.get("limits", {}).get("min", float("-inf")))
        limit_max = float(spec.get("limits", {}).get("max", float("inf")))
        sample_every = max(1, int(spec.get("sampleEvery", 1)))
        schedule = sorted((float(item["at"]), float(item["value"])) for item in spec.get("inputs", []))
        fmu = Fmu(root, description)
        events: list[dict[str, Any]] = []

        def emit(kind: str, time: float, **payload: Any) -> None:
            events.append({
                "sequence": len(events) + 1,
                "occurredAt": time,
                "type": kind,
                "entityId": output_name,
                **({"payload": payload} if payload else {}),
            })

        try:
            fmu.initialize(start, stop, {name: float(value) for name, value in spec.get("parameters", {}).items()})
            emit("fmu:initialized", start, fmiVersion=description.fmi_version, model=description.model_name)
            samples: list[dict[str, float]] = []
            pending = list(schedule)
            for index in range(steps):
                current = start + index * step
                while pending and pending[0][0] <= current + 1e-12:
                    at, value = pending.pop(0)
                    if input_name is None:
                        raise ValueError("场景有 inputs，但 variables.input 未声明")
                    fmu.set_real(input_name, value)
                    emit("fmu:input:set", current, value=value, target=input_name)
                fmu.do_step(current, step)
                after = start + (index + 1) * step
                level = fmu.get_real(output_name)
                if (index + 1) % sample_every == 0 or index == steps - 1:
                    samples.append({"time": after, output_name: level})
                    emit("fmu:sample", after, level=level)
                if level > limit_max:
                    emit("fmu:limit:high", after, level=level, limit=limit_max)
                if level < limit_min:
                    emit("fmu:limit:low", after, level=level, limit=limit_min)
            emit("fmu:completed", start + steps * step, level=fmu.get_real(output_name))
        finally:
            fmu.close()
    finally:
        if temporary is not None:
            temporary.cleanup()

    levels = [sample[output_name] for sample in samples]
    final_state = {
        "runtime": "fmi2",
        "model": {
            "fmiVersion": description.fmi_version,
            "modelName": description.model_name,
            "guid": description.guid,
            "modelIdentifier": description.model_identifier,
            "binaryPlatform": platform.system().lower(),
        },
        "interval": {"start": start, "stop": stop, "step": step, "steps": steps},
        "variables": {"input": input_name, "output": output_name},
        "inputs": [{"at": at, "value": value} for at, value in schedule],
        "samples": samples,
        "finalLevel": levels[-1] if levels else None,
        "limits": {"min": limit_min, "max": limit_max},
    }
    trace = {
        "formatVersion": 1,
        "sceneId": spec["sceneId"],
        "sceneHash": stable_hash(spec),
        "seed": int(spec.get("seed", 0)),
        "step": spec["step"],
        "steps": steps,
        "plugins": [
            {"id": "fmi2", "version": description.fmi_version},
            {"id": "scene-adapter-fmu", "version": ADAPTER_VERSION, "configHash": stable_hash(spec)},
        ],
        "actions": [
            {
                "atStep": int(round((at - start) / step)),
                "id": "fmu:set-input",
                "params": {"variable": input_name or "", "value": value},
            }
            for at, value in schedule
        ],
        "events": events,
        "finalState": final_state,
        "eventHash": stable_hash(events),
        "stateHash": stable_hash(final_state),
    }
    return trace, audit_trace(trace, spec)


def audit_trace(trace: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    """只读 trace 的审计：输入调度是否落地、输出是否越限、时间网格是否对齐。"""
    violations: dict[str, list[dict[str, str]]] = {"input": [], "range": [], "time": []}
    notes: dict[str, list[str]] = {"input": [], "range": [], "time": []}
    final_state = trace["finalState"]
    output_name = final_state["variables"]["output"] or "level"
    schedule = final_state["inputs"]
    step = final_state["interval"]["step"]
    start = final_state["interval"]["start"]
    set_events = [event for event in trace["events"] if event["type"] == "fmu:input:set"]
    for entry in schedule:
        matched = [
            event for event in set_events
            if abs(event["occurredAt"] - entry["at"]) <= step + 1e-12
            and abs(float(event["payload"]["value"]) - entry["value"]) <= 1e-12
        ]
        if not matched:
            violations["input"].append({"where": f"at={entry['at']}", "message": f"输入 {entry['value']} 没有对应事件"})
    if len(set_events) > len(schedule):
        violations["input"].append({"where": "fmu:input:set", "message": f"输入事件 {len(set_events)} 条多于调度 {len(schedule)} 条"})
    notes["input"].append(f"{len(schedule)} 次输入变更都在 trace 里落地")

    limit_min = final_state["limits"]["min"]
    limit_max = final_state["limits"]["max"]
    previous = None
    for sample in final_state["samples"]:
        level = sample[output_name]
        if previous is not None and sample["time"] < previous:
            violations["time"].append({"where": str(sample["time"]), "message": "采样时间倒退"})
        previous = sample["time"]
        if level != level or level in (float("inf"), float("-inf")):
            violations["range"].append({"where": str(sample["time"]), "message": "输出非有限值"})
            continue
        if level > limit_max + 1e-9 or level < limit_min - 1e-9:
            violations["range"].append({"where": str(sample["time"]), "message": f"{output_name}={level} 越出 [{limit_min}, {limit_max}]"})
    levels = [sample[output_name] for sample in final_state["samples"]]
    notes["range"].append(f"峰值 {max(levels) if levels else 0} · 终值 {final_state['finalLevel']}")

    expected_end = final_state["interval"]["stop"]
    last = trace["events"][-1] if trace["events"] else None
    if last is None or abs(last["occurredAt"] - expected_end) > 1e-9:
        violations["time"].append({"where": "end", "message": f"末事件时间 {last['occurredAt'] if last else None} ≠ stopTime {expected_end}"})
    for index, event in enumerate(trace["events"], start=1):
        if event["sequence"] != index:
            violations["time"].append({"where": str(index), "message": "事件序号不连续"})
            break
    notes["time"].append(f"{int(round((expected_end - start) / step))} 个固定步长推进到 {expected_end}")

    checks = [{
        "id": "fmu.input-applied",
        "description": "输入调度在 trace 里逐条落地",
        "status": "pass" if not violations["input"] else "fail",
        "violations": violations["input"],
        "notes": notes["input"],
    }, {
        "id": "fmu.output-range",
        "description": f"{output_name} 始终落在声明区间内且为有限值",
        "status": "pass" if not violations["range"] else "fail",
        "violations": violations["range"],
        "notes": notes["range"],
    }, {
        "id": "fmu.time-grid",
        "description": "时间网格对齐 stopTime，事件序号连续",
        "status": "pass" if not violations["time"] else "fail",
        "violations": violations["time"],
        "notes": notes["time"],
    }]
    warnings = []
    minimum = spec.get("minimumSamples", 1)
    if len(final_state["samples"]) < minimum:
        warnings.append(f"只采到 {len(final_state['samples'])} 个样本，少于要求的 {minimum} 个；不足以支持趋势结论")
    levels = [sample[output_name] for sample in final_state["samples"]]
    return {
        "formatVersion": 1,
        "sceneId": trace["sceneId"],
        "passed": all(check["status"] == "pass" for check in checks),
        "checks": checks,
        "metrics": {
            "steps": trace["steps"],
            "samples": len(final_state["samples"]),
            "finalLevel": final_state["finalLevel"] or 0,
            "peakLevel": max(levels) if levels else 0,
            "minLevel": min(levels) if levels else 0,
            "inputChanges": len(final_state["inputs"]),
            "highEvents": sum(event["type"] == "fmu:limit:high" for event in trace["events"]),
            "lowEvents": sum(event["type"] == "fmu:limit:low" for event in trace["events"]),
        },
        "warnings": warnings,
    }
