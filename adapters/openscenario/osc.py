"""OpenSCENARIO 1.x importer：解析外部场景 XML，转成可确定性执行的车辆运动场景。

支持的显式子集：
- `Entities/ScenarioObject`（车辆）；
- `Init` 里的 `SpeedAction` 与 `PositionAction/TeleportAction`（仅 `LanePosition`）；
- `Story` 事件里的 `SpeedAction`（绝对 / 相对目标，step 或 linear dynamics）与 `TeleportAction / PositionAction`；
- 触发条件仅 `SimulationTimeCondition`。

不支持的构造会被明确拒绝（列出清单），不静默忽略。OpenDRIVE 路网不在范围内：
直线道路假设下 `LanePosition(roadId, laneId, s)` 映射为 `(x=s, z=laneId * laneWidth)`。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
from typing import Any

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scene_spec import stable_hash  # noqa: E402

ADAPTER_ID = "openscenario.importer.v1"
ADAPTER_VERSION = "0.1.0"


class OpenScenarioError(ValueError):
    pass


def local_name(tag: str) -> str:
    return tag.split("}", 1)[-1] if "}" in tag else tag


def find_all(node: ET.Element, name: str) -> list[ET.Element]:
    return [child for child in node if local_name(child.tag) == name]


def find(node: ET.Element | None, name: str) -> ET.Element | None:
    if node is None:
        return None
    for child in node:
        if local_name(child.tag) == name:
            return child
    return None


def number(node: ET.Element, attribute: str) -> float:
    try:
        return float(node.attrib[attribute])
    except (KeyError, ValueError) as error:
        raise OpenScenarioError(f"{local_name(node.tag)} 缺少数值属性 {attribute}") from error


@dataclass
class Vehicle:
    name: str
    category: str
    road: str
    lane: float
    s: float
    speed: float


@dataclass
class ScheduledAction:
    at: float
    kind: str  # "speed" | "teleport"
    entity: str
    value: float | None = None
    road: str | None = None
    lane: float | None = None
    s: float | None = None
    rate: float | None = None


@dataclass
class Scenario:
    rev_major: str
    rev_minor: str
    description: str
    vehicles: dict[str, Vehicle]
    actions: list[ScheduledAction]


def parse_lane_position(position: ET.Element) -> tuple[str, float, float]:
    lane_position = find(position, "LanePosition")
    if lane_position is not None:
        return lane_position.attrib.get("roadId", "0"), number(lane_position, "laneId"), number(lane_position, "s")
    world = find(position, "WorldPosition")
    if world is not None:
        raise OpenScenarioError("暂不支持 WorldPosition：本 importer 只处理 LanePosition（无 OpenDRIVE 路网）")
    raise OpenScenarioError("位置必须是 LanePosition")


def parse_speed_action(action: ET.Element, current: float) -> tuple[float, float | None]:
    target = find(action, "SpeedActionTarget")
    if target is None:
        raise OpenScenarioError("SpeedAction 缺少 SpeedActionTarget")
    absolute = find(target, "AbsoluteTargetSpeed")
    relative = find(target, "RelativeTargetSpeed")
    if absolute is not None:
        value = number(absolute, "value")
    elif relative is not None:
        entity_ref = find(relative, "EntityRef")
        if entity_ref is not None:
            raise OpenScenarioError("暂不支持相对其它实体的 RelativeTargetSpeed")
        value = current + number(relative, "value")
    else:
        raise OpenScenarioError("SpeedAction 目标必须是 AbsoluteTargetSpeed 或 RelativeTargetSpeed")
    dynamics = find(action, "SpeedActionDynamics")
    rate = None
    if dynamics is not None:
        shape = dynamics.attrib.get("dynamicsShape", "step")
        if shape not in ("step", "linear"):
            raise OpenScenarioError(f"暂不支持 dynamicsShape={shape}")
        if shape == "linear":
            rate = abs(number(dynamics, "value")) or None
    return value, rate


def parse_trigger(event: ET.Element) -> float:
    trigger = find(event, "StartTrigger")
    condition = None
    if trigger is not None:
        for candidate in trigger.iter():
            if local_name(candidate.tag) == "SimulationTimeCondition":
                condition = candidate
                break
    if condition is None:
        raise OpenScenarioError("事件缺少 SimulationTimeCondition 触发条件")
    if condition.attrib.get("rule", "greaterThan") != "greaterThan":
        raise OpenScenarioError("只支持 SimulationTimeCondition rule=greaterThan")
    return number(condition, "value")


def parse_scenario(path: Path) -> Scenario:
    root = ET.parse(path).getroot()
    if local_name(root.tag) != "OpenSCENARIO":
        raise OpenScenarioError("根元素必须是 OpenSCENARIO")
    header = find(root, "FileHeader")
    if header is None:
        raise OpenScenarioError("缺少 FileHeader")
    rev_major = header.attrib.get("revMajor", "")
    if not rev_major.startswith("1"):
        raise OpenScenarioError(f"只导入 OpenSCENARIO 1.x，收到 revMajor={rev_major or '未知'}")

    entities_node = find(root, "Entities")
    vehicles: dict[str, Vehicle] = {}
    if entities_node is not None:
        for obj in find_all(entities_node, "ScenarioObject"):
            name = obj.attrib.get("name", "")
            vehicle = find(obj, "Vehicle")
            if not name or vehicle is None:
                raise OpenScenarioError("只支持车辆类型的 ScenarioObject")
            vehicles[name] = Vehicle(name, vehicle.attrib.get("vehicleCategory", "car"), "0", 0.0, 0.0, 0.0)

    actions: list[ScheduledAction] = []
    unsupported: list[str] = []

    def read_private_action(private_action: ET.Element, entity: str, at: float | None) -> None:
        longitudinal = find(private_action, "LongitudinalAction")
        if longitudinal is not None:
            speed_action = find(longitudinal, "SpeedAction")
            if speed_action is not None:
                value, rate = parse_speed_action(speed_action, vehicles[entity].speed if entity in vehicles else 0.0)
                if at is None:
                    vehicles[entity].speed = value
                else:
                    actions.append(ScheduledAction(at, "speed", entity, value=value, rate=rate))
                return
            unsupported.append("LongitudinalAction 中除 SpeedAction 外的动作")
            return
        for wrapper in ("PositionAction", "TeleportAction"):
            node = find(private_action, wrapper)
            if node is not None:
                position = find(node, "Position")
                if position is None:
                    raise OpenScenarioError(f"{wrapper} 缺少 Position")
                road, lane, distance = parse_lane_position(position)
                if at is None:
                    vehicles[entity].road = road
                    vehicles[entity].lane = lane
                    vehicles[entity].s = distance
                else:
                    actions.append(ScheduledAction(at, "teleport", entity, road=road, lane=lane, s=distance))
                return
        lateral = find(private_action, "LateralAction")
        if lateral is not None:
            unsupported.append("LateralAction（换道）")
            return
        routing = find(private_action, "RoutingAction")
        if routing is not None:
            unsupported.append("RoutingAction（路径分配）")
            return
        unsupported.append(local_name(private_action[0].tag) if len(private_action) else "未知 PrivateAction")

    storyboard = find(root, "Storyboard")
    if storyboard is None:
        raise OpenScenarioError("缺少 Storyboard")
    init_actions = find(find(storyboard, "Init"), "Actions")
    if init_actions is not None:
        for private in find_all(init_actions, "Private"):
            entity = private.attrib.get("entityRef", "")
            if entity not in vehicles:
                raise OpenScenarioError(f"Init 引用了不存在的实体 {entity}")
            for private_action in find_all(private, "PrivateAction"):
                read_private_action(private_action, entity, None)

    # 可选 OpenDRIVE：有路网就按真实几何解算，没有才退回直线道路假设。
    for story in find_all(storyboard, "Story"):
        for act in find_all(story, "Act"):
            for group in find_all(act, "ManeuverGroup"):
                actors_node = find(group, "Actors")
                actors = [ref.attrib.get("entityRef", "") for ref in find_all(actors_node, "EntityRef")] if actors_node is not None else []
                for maneuver in find_all(group, "Maneuver"):
                    for event in find_all(maneuver, "Event"):
                        at = parse_trigger(event)
                        for action in find_all(event, "Action"):
                            private_action = find(action, "PrivateAction")
                            if private_action is None:
                                unsupported.append("GlobalAction（全局/环境动作）")
                                continue
                            for actor in actors:
                                if actor not in vehicles:
                                    raise OpenScenarioError(f"ManeuverGroup 引用了不存在的实体 {actor}")
                                read_private_action(private_action, actor, at)

    if unsupported:
        raise OpenScenarioError("遇到不支持的 OpenSCENARIO 构造：" + "、".join(sorted(set(unsupported))))
    if not vehicles:
        raise OpenScenarioError("场景里没有车辆实体")
    actions.sort(key=lambda item: (item.at, item.entity, item.kind))
    return Scenario(rev_major, header.attrib.get("revMinor", ""), header.attrib.get("description", ""), vehicles, actions)


def validate_spec(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("OpenSCENARIO 场景必须是 JSON 对象")
    if raw.get("adapter") != ADAPTER_ID:
        raise ValueError(f"adapter 必须是 {ADAPTER_ID}")
    for key in ("sceneId", "source", "step", "duration"):
        if key not in raw:
            raise ValueError(f"缺少字段 {key}")
    step = raw["step"]
    duration = raw["duration"]
    if not isinstance(step, (int, float)) or step <= 0 or not isinstance(duration, (int, float)) or duration <= 0:
        raise ValueError("step 与 duration 必须是正数")
    if abs(duration / step - round(duration / step)) > 1e-9:
        raise ValueError("duration 必须是 step 的整数倍")
    road = raw.get("road", {})
    if not raw.get("opendrive") and (float(road.get("length", 0)) <= 0 or float(road.get("laneWidth", 0)) <= 0):
        raise ValueError("没有 opendrive 路网时，road.length 与 road.laneWidth 必须是正数")
    return raw


def load_network(spec: dict[str, Any]):
    """可选加载 OpenDRIVE 路网；没有路网时返回 None（退回直线道路假设）。"""
    source = spec.get("opendrive")
    if not source:
        return None
    path = Path(source)
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[2] / path
    opendrive_dir = str(Path(__file__).resolve().parents[1] / "opendrive")
    if opendrive_dir not in sys.path:
        sys.path.append(opendrive_dir)
    import opendr  # noqa: PLC0415

    return opendr.parse_network(path)


def world_position(network, entity: dict[str, Any]) -> dict[str, float]:
    """有路网就解算真实世界坐标；否则留空，由调用方只看 (lane, s)。"""
    if network is None:
        return {}
    import opendr  # noqa: PLC0415

    position = opendr.lane_position(network, entity["road"], entity["lane"], entity["s"])
    return {"x": position["x"], "y": position["y"], "heading": position["heading"]}


def run_scenario(raw_spec: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    spec = validate_spec(raw_spec)
    source = Path(spec["source"])
    if not source.is_absolute():
        source = Path(__file__).resolve().parents[2] / source
    scenario = parse_scenario(source)
    step = float(spec["step"])
    duration = float(spec["duration"])
    steps = int(round(duration / step))
    sample_every = max(1, int(spec.get("sampleEvery", 1)))
    road = spec.get("road", {})
    road_length = float(road.get("length", 0))
    lane_width = float(road.get("laneWidth", 0))
    min_lane = float(road.get("minLane", -10))
    max_lane = float(road.get("maxLane", 10))
    max_speed = float(spec.get("maxSpeed", float("inf")))
    min_gap = float(spec.get("minGap", 0))
    network = load_network(spec)

    state = {
        name: {
            "road": vehicle.road,
            "lane": vehicle.lane,
            "s": vehicle.s,
            "speed": vehicle.speed,
            "target": vehicle.speed,
            "rate": None,
        }
        for name, vehicle in scenario.vehicles.items()
    }
    events: list[dict[str, Any]] = []

    def emit(kind: str, at: float, entity: str, **payload: Any) -> None:
        events.append({
            "sequence": len(events) + 1,
            "occurredAt": at,
            "type": kind,
            "entityId": entity,
            **({"payload": payload} if payload else {}),
        })

    for name in sorted(state):
        current = state[name]
        emit("osc:spawn", 0, name, lane=current["lane"], s=current["s"], speed=current["speed"])

    samples: list[dict[str, Any]] = []
    pending = list(scenario.actions)
    for index in range(steps):
        now = index * step
        while pending and pending[0].at <= now + 1e-12:
            action = pending.pop(0)
            entity = state[action.entity]
            if action.kind == "speed":
                entity["target"] = float(action.value or 0)
                entity["rate"] = action.rate
                emit("osc:speed:set", now, action.entity, speed=entity["target"], rate=action.rate or 0)
            else:
                entity["road"] = str(action.road or entity["road"])
                entity["lane"] = float(action.lane or 0)
                entity["s"] = float(action.s or 0)
                emit("osc:teleport", now, action.entity, road=entity["road"], lane=entity["lane"], s=entity["s"])
        for name in sorted(state):
            entity = state[name]
            if entity["rate"] is None:
                entity["speed"] = entity["target"]
            else:
                delta = entity["target"] - entity["speed"]
                limit = entity["rate"] * step
                entity["speed"] += max(-limit, min(limit, delta))
            entity["s"] += entity["speed"] * step
            if network is not None:
                # 车道级跨道路：先 lane link，再路口 laneLink / 同侧最近车道；走不通就保留越界，交给边界检查。
                import opendr  # noqa: PLC0415

                enter_time = (index + 1) * step
                hops = 0
                while hops < 10:
                    road = network.road(entity["road"])
                    if entity["s"] <= road.length + 1e-9:
                        break
                    following = opendr.next_lane(network, entity["road"], entity["lane"], at_end=True)
                    if following is None:
                        break
                    entity["s"] -= road.length
                    entity["road"] = following["road"]
                    entity["lane"] = following["lane"]
                    emit("osc:road:enter", enter_time, name, road=following["road"], lane=following["lane"], s=entity["s"], fromRoad=road.id, via=following["via"])
                    hops += 1
        after = (index + 1) * step
        if (index + 1) % sample_every == 0 or index == steps - 1:
            snapshot = {
                name: {
                    "road": state[name]["road"],
                    "lane": state[name]["lane"],
                    "s": state[name]["s"],
                    "speed": state[name]["speed"],
                    **world_position(network, state[name]),
                } for name in sorted(state)
            }
            samples.append({"time": after, "entities": snapshot})
            for name in sorted(state):
                emit("osc:sample", after, name, **snapshot[name])
    emit("osc:completed", steps * step, "", entities=len(state))

    final_state = {
        "runtime": "openscenario",
        "opendrive": spec.get("opendrive"),
        "source": {
            "file": str(Path(spec["source"]).as_posix()),
            "revMajor": scenario.rev_major,
            "revMinor": scenario.rev_minor,
            "description": scenario.description,
        },
        "road": {"length": road_length, "laneWidth": lane_width, "minLane": min_lane, "maxLane": max_lane},
        "interval": {"start": 0, "duration": duration, "step": step, "steps": steps},
        "actions": [
            {
                "at": action.at,
                "kind": action.kind,
                "entity": action.entity,
                "value": action.value,
                "road": action.road,
                "lane": action.lane,
                "s": action.s,
            }
            for action in scenario.actions
        ],
        "entities": {name: {"category": scenario.vehicles[name].category, **values} for name, values in sorted(state.items())},
        "samples": samples,
        "limits": {"maxSpeed": max_speed, "minGap": min_gap},
    }
    trace = {
        "formatVersion": 1,
        "sceneId": spec["sceneId"],
        "sceneHash": stable_hash(spec),
        "seed": int(spec.get("seed", 0)),
        "step": spec["step"],
        "steps": steps,
        "plugins": [
            {"id": "openscenario", "version": f"{scenario.rev_major}.{scenario.rev_minor}"},
            {"id": "scene-adapter-openscenario", "version": ADAPTER_VERSION, "configHash": stable_hash(spec)},
        ],
        "actions": [
            {
                "atStep": int(round(action.at / step)),
                "id": f"osc:{action.kind}",
                "params": {"entity": action.entity, **({"value": action.value} if action.kind == "speed" else {"lane": action.lane, "s": action.s})},
            }
            for action in scenario.actions
        ],
        "events": events,
        "finalState": final_state,
        "eventHash": stable_hash(events),
        "stateHash": stable_hash(final_state),
    }
    return trace, audit_trace(trace, spec)


def audit_trace(trace: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    """只读 trace：动作是否落地、车辆是否留在路上、是否超速、是否保持车距。"""
    violations: dict[str, list[dict[str, str]]] = {"actions": [], "bounds": [], "speed": [], "gap": []}
    notes: dict[str, list[str]] = {"actions": [], "bounds": [], "speed": [], "gap": []}
    final_state = trace["finalState"]
    road = final_state["road"]
    max_speed = final_state["limits"]["maxSpeed"]
    min_gap = final_state["limits"]["minGap"]
    network = load_network({"opendrive": final_state.get("opendrive")} if final_state.get("opendrive") else {})

    for entry in final_state["actions"]:
        kind = "osc:speed:set" if entry["kind"] == "speed" else "osc:teleport"
        matched = [
            event for event in trace["events"]
            if event["type"] == kind and event["entityId"] == entry["entity"]
            and abs(event["occurredAt"] - entry["at"]) <= final_state["interval"]["step"] + 1e-12
            and (entry["kind"] != "speed" or abs(float(event["payload"]["speed"]) - float(entry["value"])) <= 1e-12)
        ]
        if not matched:
            violations["actions"].append({"where": f"{entry['entity']}@{entry['at']}", "message": f"{entry['kind']} 动作没有对应事件"})
    expected_actions = len(final_state["actions"])
    actual_actions = sum(event["type"] in ("osc:speed:set", "osc:teleport") for event in trace["events"])
    if actual_actions > expected_actions:
        violations["actions"].append({"where": "events", "message": f"动作事件 {actual_actions} 条多于导入的 {expected_actions} 条"})
    notes["actions"].append(f"{expected_actions} 个导入动作逐条落地")

    previous_time = None
    for sample in final_state["samples"]:
        if previous_time is not None and sample["time"] < previous_time:
            violations["bounds"].append({"where": str(sample["time"]), "message": "采样时间倒退"})
        previous_time = sample["time"]
        for name, entity in sample["entities"].items():
            if network is not None:
                try:
                    target = network.road(entity["road"])
                except ValueError as error:
                    violations["bounds"].append({"where": f"{name}@{sample['time']}", "message": str(error)})
                    continue
                if entity["lane"] not in target.lane_ids():
                    violations["bounds"].append({"where": f"{name}@{sample['time']}", "message": f"道路 {target.id} 没有车道 {entity['lane']}（可用 {target.lane_ids()}）"})
                if not (0 <= entity["s"] <= target.length):
                    violations["bounds"].append({"where": f"{name}@{sample['time']}", "message": f"纵向位置 {entity['s']} 越出道路 {target.id} 的 [0, {target.length}]"})
            else:
                if not (road["minLane"] <= entity["lane"] <= road["maxLane"]):
                    violations["bounds"].append({"where": f"{name}@{sample['time']}", "message": f"车道 {entity['lane']} 越出 [{road['minLane']}, {road['maxLane']}]"})
                if not (0 <= entity["s"] <= road["length"]):
                    violations["bounds"].append({"where": f"{name}@{sample['time']}", "message": f"纵向位置 {entity['s']} 越出 [0, {road['length']}]"})
            if entity["speed"] > max_speed + 1e-9:
                violations["speed"].append({"where": f"{name}@{sample['time']}", "message": f"速度 {entity['speed']} 超过 {max_speed}"})
        by_lane: dict[tuple[str, float], list[tuple[str, float]]] = {}
        for name, entity in sample["entities"].items():
            by_lane.setdefault((str(entity["road"]), entity["lane"]), []).append((name, entity["s"]))
        for lane, occupants in by_lane.items():
            ordered = sorted(occupants, key=lambda item: item[1])
            for first, second in zip(ordered, ordered[1:]):
                gap = second[1] - first[1]
                if gap < min_gap - 1e-9:
                    violations["gap"].append({
                        "where": f"lane {lane}@{sample['time']}",
                        "message": f"{first[0]} 与 {second[0]} 纵向间距 {gap} 小于最小车距 {min_gap}",
                    })
    notes["bounds"].append(f"{len(final_state['samples'])} 个采样都在道路范围内")
    notes["speed"].append(f"限速 {max_speed}")
    notes["gap"].append(f"最小车距 {min_gap}")

    route_violations: list[dict[str, str]] = []
    route_events = [event for event in trace["events"] if event["type"] == "osc:road:enter"]
    if network is not None:
        for event in route_events:
            payload = event["payload"]
            target = network.road(payload["road"])
            if int(payload["lane"]) not in target.lane_ids():
                route_violations.append({"where": f"{event['entityId']}@{event['occurredAt']}", "message": f"换到不存在的车道 {payload['road']}/{payload['lane']}"})
                continue
            source = str(payload.get("fromRoad"))
            connected = source in [target.predecessor[0] if target.predecessor else None, target.successor[0] if target.successor else None] or any(
                edge["to"] == payload["road"] for edge in network.edges.get(source, [])
            )
            if not connected:
                route_violations.append({"where": f"{event['entityId']}@{event['occurredAt']}", "message": f"从 {source} 换到 {payload['road']}，但路网里没有这条连接"})
    route_notes = [f"{len(route_events)} 次车道级换路都落在实际连接上"] if network is not None else ["无 OpenDRIVE 路网：不做车道级换路检查"]

    checks = [{
        "id": "openscenario.lane-continuity",
        "description": "跨道路换路时目标车道存在且路网确有连接",
        "status": "pass" if not route_violations else "fail",
        "violations": route_violations,
        "notes": route_notes,
    }, {
        "id": "openscenario.actions-applied",
        "description": "导入的动作在 trace 里逐条落地",
        "status": "pass" if not violations["actions"] else "fail",
        "violations": violations["actions"],
        "notes": notes["actions"],
    }, {
        "id": "openscenario.road-bounds",
        "description": "车辆始终在道路车道与里程范围内，采样时间单调",
        "status": "pass" if not violations["bounds"] else "fail",
        "violations": violations["bounds"],
        "notes": notes["bounds"],
    }, {
        "id": "openscenario.speed-limit",
        "description": "车辆速度不超过场景声明上限",
        "status": "pass" if not violations["speed"] else "fail",
        "violations": violations["speed"],
        "notes": notes["speed"],
    }, {
        "id": "openscenario.gap",
        "description": "同车道车辆保持最小纵向车距",
        "status": "pass" if not violations["gap"] else "fail",
        "violations": violations["gap"],
        "notes": notes["gap"],
    }]
    warnings = []
    minimum = spec.get("minimumSamples", 1)
    if len(final_state["samples"]) < minimum:
        warnings.append(f"只采到 {len(final_state['samples'])} 个样本，少于要求的 {minimum} 个；不足以支持趋势结论")
    last = final_state["entities"]
    return {
        "formatVersion": 1,
        "sceneId": trace["sceneId"],
        "passed": all(check["status"] == "pass" for check in checks),
        "checks": checks,
        "metrics": {
            "entities": len(last),
            "steps": trace["steps"],
            "samples": len(final_state["samples"]),
            "actions": len(final_state["actions"]),
            "maxSpeedSeen": max((entity["speed"] for sample in final_state["samples"] for entity in sample["entities"].values()), default=0),
            "finalEgoS": next(iter(last.values()))["s"],
        },
        "warnings": warnings,
    }
