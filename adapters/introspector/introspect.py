"""通用 introspector：识别外部模型工件，抽取事实，产出可运行 spec 草案。

纪律：
1. **不执行外部代码**。Python 模型只做 AST 静态分析；FMU 只读 `modelDescription.xml`
   与压缩包条目，不加载二进制；OpenSCENARIO 只解析 XML。
2. **不假装覆盖**。不支持的构造、缺失的二进制、不确定性来源都进 findings。
3. **产出可复核证据**：introspection 与 report 都不写挂钟时间，同输入逐字节一致。
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile
from typing import Any

ADAPTERS = Path(__file__).resolve().parents[1]
ROOT = ADAPTERS.parent
# 追加而不是插到最前：避免 adapter 目录里的同名 run.py 抢掉本包的 run.py。
for path in (str(ADAPTERS), str(ADAPTERS / "fmu"), str(ADAPTERS / "openscenario"), str(ADAPTERS / "opendrive")):
    if path not in sys.path:
        sys.path.append(path)

from scene_spec import stable_hash  # noqa: E402
import fmi as fmi_adapter  # noqa: E402
import osc as osc_adapter  # noqa: E402
import opendr as opendrive_adapter  # noqa: E402

ADAPTER_ID = "scene-introspector.v1"
VERSION = "0.1.0"


@dataclass
class Finding:
    id: str
    severity: str  # error | warning | info
    message: str
    where: str | None = None

    def as_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "severity": self.severity,
            "message": self.message,
            **({"where": self.where} if self.where else {}),
        }


def sha256_file(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def root_element(path: Path) -> ET.Element | None:
    try:
        return ET.parse(path).getroot()
    except ET.ParseError:
        return None


def local_name(tag: str) -> str:
    return tag.split("}", 1)[-1] if "}" in tag else tag


def detect_kind(path: Path) -> str:
    if path.is_dir():
        return "fmi" if (path / "modelDescription.xml").exists() else "unknown"
    suffix = path.suffix.lower()
    if suffix == ".fmu" and zipfile.is_zipfile(path):
        return "fmi"
    if suffix in (".xml", ".xosc"):
        root = root_element(path)
        if root is None:
            return "unknown"
        name = local_name(root.tag)
        if name == "OpenSCENARIO":
            return "openscenario"
        if name == "fmiModelDescription":
            return "fmi"
        return "opendrive" if name == "OpenDRIVE" else "unknown"
    if suffix == ".xodr":
        return "opendrive"
    if suffix == ".py":
        return "python"
    if suffix == ".json":
        return "scene-spec"
    return "unknown"


def inspect_fmu(path: Path) -> tuple[dict[str, Any], dict[str, Any] | None, list[Finding]]:
    findings: list[Finding] = []
    if path.is_dir():
        xml_path = path / "modelDescription.xml"
        entries = [item.relative_to(path).as_posix() for item in path.rglob("*") if item.is_file()]
    elif zipfile.is_zipfile(path):
        xml_path = path
        with zipfile.ZipFile(path) as archive:
            entries = archive.namelist()
    else:
        # 单独一个 modelDescription.xml：能看清楚变量，但没有二进制可执行。
        xml_path = path
        entries = []
    root = root_element(xml_path) if xml_path.is_file() else None
    version = root.attrib.get("fmiVersion", "") if root is not None else ""
    if version and not version.startswith("2.0"):
        findings.append(Finding("fmi.unsupported-version", "error", f"只支持 FMI 2.0，收到 {version}"))
        return {"kind": "fmi", "fmiVersion": version, "variables": [], "binaries": []}, None, findings
    try:
        if zipfile.is_zipfile(path):
            import tempfile

            temporary = tempfile.TemporaryDirectory(prefix="introspector-fmu-")
            with zipfile.ZipFile(path) as archive:
                archive.extractall(temporary.name)
            description = fmi_adapter.parse_model_description(Path(temporary.name) / "modelDescription.xml")
        else:
            description = fmi_adapter.parse_model_description(xml_path)
    except ValueError as error:
        findings.append(Finding("fmi.unsupported", "error", str(error)))
        return {"kind": "fmi", "fmiVersion": version, "variables": [], "binaries": []}, None, findings

    variables = [
        {
            "name": variable.name,
            "valueReference": variable.value_reference,
            "causality": variable.causality,
            "variability": variable.variability,
            "start": variable.start,
        }
        for variable in description.variables.values()
    ]
    binaries = [entry for entry in entries if entry.startswith("binaries/")]
    outputs = [item for item in variables if item["causality"] == "output"]
    inputs = [item for item in variables if item["causality"] == "input"]
    parameters = [item for item in variables if item["causality"] in ("parameter", "calculatedParameter")]
    if not outputs:
        findings.append(Finding("fmi.no-output", "error", "FMU 没有 output 变量，无法产出可验证输出"))
    if not binaries:
        findings.append(Finding("fmi.no-binary", "error", "没有找到 binaries/ 下的平台二进制，无法执行"))
    limit_candidates = [
        item["start"] for item in parameters
        if item["start"] is not None and any(token in item["name"].lower() for token in ("capacity", "max", "limit"))
    ]
    max_limit = max(limit_candidates) if limit_candidates else None
    model = {
        "kind": "fmi",
        "fmiVersion": description.fmi_version,
        "modelName": description.model_name,
        "guid": description.guid,
        "modelIdentifier": description.model_identifier,
        "variables": variables,
        "binaries": sorted(binaries),
        "outputs": [item["name"] for item in outputs],
        "inputs": [item["name"] for item in inputs],
        "parameters": [item["name"] for item in parameters],
    }
    if not outputs or not binaries:
        return model, None, findings
    output_name = outputs[0]["name"]
    proposed: dict[str, Any] = {
        "adapter": fmi_adapter.ADAPTER_ID,
        "sceneId": f"introspected-{description.model_identifier}",
        "fmu": _relative(path),
        "startTime": 0,
        "stopTime": 60,
        "step": 1,
        "seed": 0,
        "variables": {"output": output_name, **({"input": inputs[0]["name"]} if inputs else {})},
        "parameters": {item["name"]: item["start"] for item in parameters if item["start"] is not None},
        "sampleEvery": 10,
        "minimumSamples": 5,
    }
    if max_limit is not None:
        proposed["limits"] = {"min": 0, "max": max_limit}
    findings.append(Finding("fmi.proposed-spec", "info", f"已按首个 output=`{output_name}` 生成 fmi adapter 场景草案"))
    if len(outputs) > 1:
        findings.append(Finding("fmi.multiple-outputs", "warning", f"发现多个 output（{', '.join(item['name'] for item in outputs)}）；草案只跟踪第一个"))
    return model, proposed, findings


def inspect_openscenario(path: Path) -> tuple[dict[str, Any], dict[str, Any] | None, list[Finding]]:
    findings: list[Finding] = []
    try:
        scenario = osc_adapter.parse_scenario(path)
    except osc_adapter.OpenScenarioError as error:
        root = root_element(path)
        header = None if root is None else next((child for child in root if local_name(child.tag) == "FileHeader"), None)
        version = f"{header.attrib.get('revMajor', '')}.{header.attrib.get('revMinor', '')}" if header is not None else ""
        findings.append(Finding("openscenario.unsupported", "error", str(error)))
        model = {"kind": "openscenario", "openScenarioVersion": version, "entities": [], "actions": [], "triggers": []}
        return model, None, findings
    lanes = sorted({vehicle.lane for vehicle in scenario.vehicles.values()})
    distances = [vehicle.s for vehicle in scenario.vehicles.values()]
    triggers = sorted({action.at for action in scenario.actions})
    model = {
        "kind": "openscenario",
        "openScenarioVersion": f"{scenario.rev_major}.{scenario.rev_minor}",
        "description": scenario.description,
        "entities": [
            {"name": vehicle.name, "category": vehicle.category, "lane": vehicle.lane, "s": vehicle.s, "speed": vehicle.speed}
            for vehicle in sorted(scenario.vehicles.values(), key=lambda item: item.name)
        ],
        "actions": [
            {"at": action.at, "kind": action.kind, "entity": action.entity, "value": action.value, "lane": action.lane, "s": action.s}
            for action in scenario.actions
        ],
        "triggers": triggers,
        "lanes": lanes,
    }
    if not lanes:
        findings.append(Finding("openscenario.no-lane", "error", "初始化里没有 LanePosition，无法映射道路"))
        return model, None, findings
    duration = max([20, *(trigger + 10 for trigger in triggers)])
    proposed = {
        "adapter": osc_adapter.ADAPTER_ID,
        "sceneId": f"introspected-{path.stem}",
        "source": _relative(path),
        "duration": duration,
        "step": 0.5,
        "seed": 0,
        "road": {
            "length": max(500, int(max(distances) + 200)),
            "laneWidth": 3.5,
            "minLane": min(lanes),
            "maxLane": max(lanes),
        },
        "maxSpeed": 50,
        "minGap": 5,
        "sampleEvery": 2,
        "minimumSamples": 5,
    }
    findings.append(Finding("openscenario.proposed-spec", "info", f"已按 {len(model['entities'])} 辆车、{len(model['actions'])} 个动作生成 importer 场景草案"))
    return model, proposed, findings


def inspect_opendrive(path: Path) -> tuple[dict[str, Any], dict[str, Any] | None, list[Finding]]:
    import opendr  # noqa: PLC0415

    findings: list[Finding] = []
    try:
        network = opendr.parse_network(path)
    except opendr.OpenDriveError as error:
        findings.append(Finding("opendrive.unsupported", "error", str(error)))
        return {"kind": "opendrive", "roads": [], "edges": 0}, None, findings
    roads = [
        {
            "id": road.id,
            "length": road.length,
            "geometries": sorted({geometry.kind for geometry in road.geometries}),
            "lanes": road.lane_ids(),
            "junction": road.junction,
        }
        for road in (network.roads[key] for key in sorted(network.roads))
    ]
    edges = sum(len(value) for value in network.edges.values())
    model = {
        "kind": "opendrive",
        "openDriveVersion": f"1.{network.header.get('revMinor', '4')}",
        "roads": roads,
        "junctions": len(network.junctions),
        "edgeCount": edges,
    }
    if not roads:
        findings.append(Finding("opendrive.no-road", "error", "路网里没有道路"))
        return model, None, findings
    first = roads[0]
    lane_id = next((lane for lane in first["lanes"] if lane < 0), first["lanes"][0] if first["lanes"] else 0)
    queries: list[dict[str, Any]] = [{"kind": "position", "roadId": first["id"], "laneId": lane_id, "s": 0}]
    if len(roads) > 1:
        try:
            opendr.shortest_route(network, first["id"], roads[-1]["id"])
            queries.append({"kind": "route", "from": first["id"], "to": roads[-1]["id"]})
        except opendr.OpenDriveError as error:
            findings.append(Finding("opendrive.route", "warning", str(error)))
    proposed = {
        "adapter": opendr.ADAPTER_ID,
        "sceneId": f"introspected-{path.stem}",
        "source": _relative(path),
        "queries": queries,
    }
    findings.append(Finding("opendrive.proposed-spec", "info", f"已按 {len(roads)} 条道路生成 {len(queries)} 个路网查询"))
    if any("arc" in road["geometries"] for road in roads):
        findings.append(Finding("opendrive.geometry", "info", "路网含 arc 几何：位置会按曲率解算，不是直线近似"))
    return model, proposed, findings


def inspect_python(path: Path) -> tuple[dict[str, Any], dict[str, Any] | None, list[Finding]]:
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source)
    findings: list[Finding] = []
    resources: list[dict[str, Any]] = []
    timeouts: list[float] = []
    distributions: list[float] = []
    inferred_params: dict[str, Any] = {}
    processes: list[str] = []
    functions: list[str] = []
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            function = node.func
            name = getattr(function, "attr", getattr(function, "id", ""))
            if name == "Resource":
                capacity = None
                for keyword in node.keywords:
                    if keyword.arg == "capacity" and isinstance(keyword.value, ast.Constant):
                        capacity = keyword.value.value
                if capacity is None and len(node.args) > 1 and isinstance(node.args[1], ast.Constant):
                    capacity = node.args[1].value
                resources.append({"capacity": capacity, "line": node.lineno})
            elif name == "timeout" and node.args and isinstance(node.args[0], ast.Constant):
                timeouts.append(float(node.args[0].value))
            elif name == "get" and isinstance(getattr(function, "value", None), ast.Name) and getattr(function.value, "id", "") == "params":
                key = node.args[0].value if node.args and isinstance(node.args[0], ast.Constant) else None
                default = node.args[1] if len(node.args) > 1 else None
                if isinstance(key, str) and isinstance(default, ast.Constant) and isinstance(default.value, (int, float, str, bool)):
                    inferred_params[key] = default.value
                elif isinstance(key, str):
                    inferred_params.setdefault(key, None)
            elif name == "expovariate":
                argument = node.args[0] if node.args else None
                if (
                    isinstance(argument, ast.BinOp)
                    and isinstance(argument.left, ast.Constant)
                    and isinstance(argument.right, ast.Constant)
                    and argument.right.value
                ):
                    distributions.append(float(argument.right.value))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append(node.name)
            body_has_yield = any(isinstance(child, (ast.Yield, ast.YieldFrom)) for child in ast.walk(node))
            if body_has_yield:
                processes.append(node.name)
    risks: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            function = node.func
            if isinstance(function, ast.Attribute):
                owner = getattr(function.value, "id", "")
                attribute = function.attr
                if owner == "random" and attribute in ("random", "uniform", "expovariate", "randint", "choice", "gauss"):
                    risks.append(f"line {node.lineno}: 使用全局 random.{attribute}（不可复现）")
                if owner == "time" and attribute in ("time", "monotonic"):
                    risks.append(f"line {node.lineno}: 读取挂钟 time.{attribute}")
                if owner in ("datetime", "dt") and attribute == "now":
                    risks.append(f"line {node.lineno}: 读取 datetime.now")
                if owner == "uuid" and attribute == "uuid4":
                    risks.append(f"line {node.lineno}: 使用 uuid.uuid4")
    for risk in sorted(set(risks)):
        findings.append(Finding("python.nondeterminism", "error", risk))
    kind = "simpy" if "simpy" in imported else "python"
    entrypoint = next((name for name in ("run", "main", "simulate") if name in functions), None)
    model = {
        "kind": kind,
        "imports": sorted(imported),
        "resources": resources,
        "constantTimeouts": sorted(set(timeouts)),
        "expovariateMeans": sorted(set(distributions)),
        "processes": sorted(set(processes)),
        "entrypoint": entrypoint,
        "inferredParams": inferred_params,
    }
    if kind == "simpy" and entrypoint:
        findings.append(Finding(
            "python.generic-executor",
            "info",
            f"可用通用 SimPy 执行器（{entrypoint}）：静态预检 + 受限沙箱执行，模型只用注入 rng 才能复现。",
        ))
    else:
        findings.append(Finding(
            "python.no-entrypoint",
            "warning",
            "没有发现 run / main / simulate 入口：无法生成通用执行草案（仍可人工写 spec）。",
        ))
    if kind == "simpy" and not processes:
        findings.append(Finding("python.no-process", "warning", "没有发现带 yield 的进程函数，可能不是 SimPy 模型"))
    if kind != "simpy":
        return model, None, findings
    if not entrypoint:
        return model, None, findings
    proposed = {
        "adapter": "simpy.generic.v1",
        "sceneId": f"introspected-{path.stem}",
        "model": _relative(path),
        "entrypoint": entrypoint,
        "seed": 0,
        "until": 60,
        "params": {key: value for key, value in inferred_params.items() if value is not None},
        "minimumEvents": 1,
    }
    if inferred_params:
        findings.append(Finding("python.params-inferred", "info", f"从 params.get(...) 默认值推断出 {len(inferred_params)} 个参数"))
    findings.append(Finding("python.proposed-spec", "warning", "通用草案的 until=60 与推断参数仍需人工核对；没推断出的参数请手动补进 params。"))
    return model, proposed, findings


def inspect_scene_spec(path: Path) -> tuple[dict[str, Any], dict[str, Any] | None, list[Finding]]:
    import json

    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or "adapter" not in raw:
        return {"kind": "scene-spec", "adapter": None}, None, [Finding("spec.no-adapter", "error", "JSON 场景缺少 adapter 字段")]
    findings = [Finding("spec.detected", "info", f"已识别运行场景 {raw.get('adapter')}")]
    model = {
        "kind": "scene-spec",
        "adapter": raw.get("adapter"),
        "sceneId": raw.get("sceneId"),
        "fields": sorted(raw.keys()),
    }
    return model, raw, findings


def _relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def inspect_target(raw_path: str | Path) -> dict[str, Any]:
    path = Path(raw_path)
    if not path.is_absolute():
        path = ROOT / path
    if not path.exists():
        raise ValueError(f"找不到目标：{path}")
    kind = detect_kind(path)
    handlers = {
        "fmi": inspect_fmu,
        "openscenario": inspect_openscenario,
        "opendrive": inspect_opendrive,
        "python": inspect_python,
        "scene-spec": inspect_scene_spec,
    }
    if kind not in handlers:
        model, proposed, findings = {"kind": "unknown"}, None, [Finding("target.unknown", "error", f"无法识别 {path.name} 的模型族（支持 .fmu / 解包 FMU / .xosc / .xodr / .py / 场景 JSON）")]
    else:
        model, proposed, findings = handlers[kind](path)  # type: ignore[operator]
    contract = {
        "fmi": fmi_adapter.ADAPTER_ID,
        "openscenario": osc_adapter.ADAPTER_ID,
        "opendrive": opendrive_adapter.ADAPTER_ID if model.get("kind") == "opendrive" else None,
        "scene-spec": model.get("adapter"),
    }.get(kind)
    if kind == "python" and model.get("kind") == "simpy":
        contract = "simpy.generic.v1" if model.get("entrypoint") else None
    return {
        "adapter": ADAPTER_ID,
        "version": VERSION,
        "target": {"path": _relative(path), "sha256": sha256_file(path), "bytes": path.stat().st_size},
        "detection": {"kind": kind, "family": model.get("kind", kind), "canRunWith": contract if proposed is not None or contract == model.get("adapter") else None},
        "model": model,
        "proposedSpec": proposed,
        "findings": [finding.as_json() for finding in findings],
        "recommendedChecks": [
            "run 后比对黄金基线 trace",
            "审计只读 trace，不信模型自报结果",
            "观察窗不足时报告警告，不把没观察到包装成没变化",
        ],
    }


def audit_introspection(introspection: dict[str, Any]) -> dict[str, Any]:
    findings = introspection["findings"]
    errors = [item for item in findings if item["severity"] == "error"]
    warnings = [item for item in findings if item["severity"] == "warning"]
    determinism = [item for item in errors if item["id"].endswith("nondeterminism")]
    model = introspection["model"]
    evidence = bool(model.get("variables") or model.get("entities") or model.get("resources") or model.get("fields"))
    checks = [{
        "id": "introspector.detected",
        "description": "目标被识别为已知模型族",
        "status": "pass" if introspection["detection"]["kind"] != "unknown" else "fail",
        "violations": [] if introspection["detection"]["kind"] != "unknown" else [{"message": "未知模型族"}],
        "notes": [f"{introspection['detection']['kind']} / {introspection['detection']['family']}"],
    }, {
        "id": "introspector.supported-subset",
        "description": "不支持的构造与缺失依赖都被显式列出",
        "status": "pass" if not [item for item in errors if not item["id"].endswith("nondeterminism")] else "fail",
        "violations": [{"message": item["message"]} for item in errors if not item["id"].endswith("nondeterminism")],
        "notes": [f"{len(errors)} 条错误发现"],
    }, {
        "id": "introspector.determinism",
        "description": "未发现挂钟 / 全局随机等不确定性来源",
        "status": "pass" if not determinism else "fail",
        "violations": [{"message": item["message"]} for item in determinism],
        "notes": ["静态检查：只报告 AST / XML 中可见的来源"],
    }, {
        "id": "introspector.evidence",
        "description": "抽取到变量 / 实体 / 资源等可核对事实",
        "status": "pass" if evidence else "fail",
        "violations": [] if evidence else [{"message": "没有抽取到任何模型事实"}],
        "notes": [", ".join(sorted(key for key in ("variables", "entities", "resources", "fields") if model.get(key))) or "无"],
    }]
    metrics = {
        "findings": len(findings),
        "errors": len(errors),
        "warnings": len(warnings),
        "variables": len(model.get("variables", [])) if isinstance(model.get("variables"), list) else 0,
        "entities": len(model.get("entities", [])) if isinstance(model.get("entities"), list) else 0,
        "resources": len(model.get("resources", [])) if isinstance(model.get("resources"), list) else 0,
        "actions": len(model.get("actions", [])) if isinstance(model.get("actions"), list) else 0,
        "proposedSpec": 1 if introspection["proposedSpec"] else 0,
    }
    return {
        "formatVersion": 1,
        "sceneId": f"introspect:{introspection['target']['path']}",
        "passed": all(check["status"] == "pass" for check in checks),
        "checks": checks,
        "metrics": metrics,
        "warnings": [item["message"] for item in warnings],
    }
