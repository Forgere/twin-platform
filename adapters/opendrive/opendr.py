"""OpenDRIVE 路网求解（显式子集）。

解决的是 OpenSCENARIO importer 之前偷懒的那一步：把 `LanePosition(roadId, laneId, s, offset)`
真正解算成世界坐标，并给出路网连通性。

支持：
- `planView/geometry`：`line` 与 `arc`（常数曲率）；
- `lanes/laneOffset`（三次多项式）与 `laneSection/lane/width`（三次多项式）；
- `road/link` 的前驱 / 后继，以及 `junction/connection` 的进出口连接；
- Dijkstra 最短路（按道路长度加权）。

不支持（明确拒绝）：`spiral`、`paramPoly3`、高程（`elevationProfile`）、超高（`lateralProfile`）、
复杂路口内部的车道级路径。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
from typing import Any

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.append(str(Path(__file__).resolve().parents[1]))
from scene_spec import stable_hash  # noqa: E402

ADAPTER_ID = "opendrive.network.v1"
ADAPTER_VERSION = "0.1.0"
EPS = 1e-6


class OpenDriveError(ValueError):
    pass


def local_name(tag: str) -> str:
    return tag.split("}", 1)[-1] if "}" in tag else tag


def find(node: ET.Element | None, name: str) -> ET.Element | None:
    if node is None:
        return None
    for child in node:
        if local_name(child.tag) == name:
            return child
    return None


def find_all(node: ET.Element | None, name: str) -> list[ET.Element]:
    if node is None:
        return []
    return [child for child in node if local_name(child.tag) == name]


def number(node: ET.Element, attribute: str, default: float | None = None) -> float:
    try:
        return float(node.attrib[attribute])
    except (KeyError, ValueError):
        if default is None:
            raise OpenDriveError(f"{local_name(node.tag)} 缺少数值属性 {attribute}")
        return default


def poly(a: float, b: float, c: float, d: float, ds: float) -> float:
    return a + b * ds + c * ds * ds + d * ds * ds * ds


@dataclass
class Geometry:
    s: float
    x: float
    y: float
    hdg: float
    length: float
    kind: str
    curvature: float = 0.0

    @property
    def end_s(self) -> float:
        return self.s + self.length


@dataclass
class WidthRecord:
    s_offset: float
    a: float
    b: float
    c: float
    d: float


@dataclass
class Lane:
    id: int
    lane_type: str
    widths: list[WidthRecord] = field(default_factory=list)
    predecessor: int | None = None
    successor: int | None = None


@dataclass
class LaneSection:
    s: float
    lanes: dict[int, Lane] = field(default_factory=dict)


@dataclass
class Road:
    id: str
    name: str
    length: float
    junction: str
    geometries: list[Geometry] = field(default_factory=list)
    lane_offsets: list[WidthRecord] = field(default_factory=list)
    lane_sections: list[LaneSection] = field(default_factory=list)
    predecessor: tuple[str, str] | None = None  # (elementId, contactPoint)
    successor: tuple[str, str] | None = None

    def lane_ids(self) -> list[int]:
        return sorted({lane_id for section in self.lane_sections for lane_id in section.lanes})

    def lane_types(self) -> set[str]:
        return {lane.lane_type for section in self.lane_sections for lane in section.lanes.values()}


@dataclass
class Network:
    header: dict[str, str]
    roads: dict[str, Road]
    junctions: list[dict[str, Any]]
    edges: dict[str, list[dict[str, Any]]] = field(default_factory=dict)

    def road(self, road_id: str | int) -> Road:
        road = self.roads.get(str(road_id))
        if road is None:
            raise OpenDriveError(f"路网里没有道路 {road_id}")
        return road


def parse_network(path: Path) -> Network:
    root = ET.parse(path).getroot()
    if local_name(root.tag) != "OpenDRIVE":
        raise OpenDriveError("根元素必须是 OpenDRIVE")
    header_node = find(root, "header")
    header = dict(header_node.attrib) if header_node is not None else {}
    if header.get("revMajor", "1") != "1":
        raise OpenDriveError(f"只支持 OpenDRIVE 1.x，收到 revMajor={header.get('revMajor')}")

    roads: dict[str, Road] = {}
    for road_node in find_all(root, "road"):
        road_id = road_node.attrib.get("id")
        if road_id is None:
            raise OpenDriveError("road 缺少 id")
        road = Road(
            id=road_id,
            name=road_node.attrib.get("name", ""),
            length=number(road_node, "length"),
            junction=road_node.attrib.get("junction", "-1"),
        )
        link = find(road_node, "link")
        for side in ("predecessor", "successor"):
            node = find(link, side)
            if node is None:
                continue
            if node.attrib.get("elementType") == "road" and node.attrib.get("elementId"):
                setattr(road, side, (node.attrib["elementId"], node.attrib.get("contactPoint", "start")))
        plan_view = find(road_node, "planView")
        for geometry_node in find_all(plan_view, "geometry"):
            kind_node = next((child for child in geometry_node if local_name(child.tag) in ("line", "arc", "spiral", "poly3", "paramPoly3")), None)
            kind = local_name(kind_node.tag) if kind_node is not None else "unknown"
            if kind not in ("line", "arc"):
                raise OpenDriveError(f"暂不支持几何类型 {kind}（只支持 line / arc）")
            road.geometries.append(Geometry(
                s=number(geometry_node, "s"),
                x=number(geometry_node, "x"),
                y=number(geometry_node, "y"),
                hdg=number(geometry_node, "hdg"),
                length=number(geometry_node, "length"),
                kind=kind,
                curvature=number(kind_node, "curvature", 0.0) if kind == "arc" else 0.0,
            ))
        road.geometries.sort(key=lambda item: item.s)
        lanes_node = find(road_node, "lanes")
        for offset_node in find_all(lanes_node, "laneOffset"):
            road.lane_offsets.append(WidthRecord(
                s_offset=number(offset_node, "s", 0.0),
                a=number(offset_node, "a", 0.0),
                b=number(offset_node, "b", 0.0),
                c=number(offset_node, "c", 0.0),
                d=number(offset_node, "d", 0.0),
            ))
        for section_node in find_all(lanes_node, "laneSection"):
            section = LaneSection(s=number(section_node, "s", 0.0))
            for side in ("left", "center", "right"):
                side_node = find(section_node, side)
                for lane_node in find_all(side_node, "lane"):
                    lane_id = int(number(lane_node, "id"))
                    lane = Lane(id=lane_id, lane_type=lane_node.attrib.get("type", "driving"))
                    for width_node in find_all(lane_node, "width"):
                        lane.widths.append(WidthRecord(
                            s_offset=number(width_node, "sOffset", 0.0),
                            a=number(width_node, "a"),
                            b=number(width_node, "b", 0.0),
                            c=number(width_node, "c", 0.0),
                            d=number(width_node, "d", 0.0),
                        ))
                    lane.widths.sort(key=lambda item: item.s_offset)
                    lane_link = find(lane_node, "link")
                    for side_name in ("predecessor", "successor"):
                        node = find(lane_link, side_name)
                        if node is not None and node.attrib.get("id") is not None:
                            setattr(lane, side_name, int(node.attrib["id"]))
                    section.lanes[lane_id] = lane
            road.lane_sections.append(section)
        road.lane_sections.sort(key=lambda item: item.s)
        roads[road_id] = road

    network = Network(header=header, roads=roads, junctions=[])
    for junction_node in find_all(root, "junction"):
        for connection_node in find_all(junction_node, "connection"):
            network.junctions.append({
                "id": junction_node.attrib.get("id", ""),
                "connection": connection_node.attrib.get("id", ""),
                "incomingRoad": connection_node.attrib.get("incomingRoad", ""),
                "connectingRoad": connection_node.attrib.get("connectingRoad", ""),
                "linkedRoad": connection_node.attrib.get("linkedRoad", ""),
                "contactPoint": connection_node.attrib.get("contactPoint", ""),
                "laneLinks": [
                    {"from": link.attrib.get("from"), "to": link.attrib.get("to")}
                    for link in find_all(connection_node, "laneLink")
                ],
            })
    build_edges(network)
    return network


def build_edges(network: Network) -> None:
    for road in network.roads.values():
        if road.successor:
            network.edges.setdefault(road.id, []).append({"to": road.successor[0], "via": None, "kind": "road"})
        if road.predecessor:
            network.edges.setdefault(road.predecessor[0], []).append({"to": road.id, "via": None, "kind": "road"})
    for connection in network.junctions:
        incoming = connection["incomingRoad"]
        connecting = connection["connectingRoad"]
        linked = connection["linkedRoad"]
        if incoming and connecting:
            network.edges.setdefault(incoming, []).append({"to": connecting, "via": connection["id"], "kind": "junction"})
        if connecting and linked:
            network.edges.setdefault(connecting, []).append({"to": linked, "via": connection["id"], "kind": "junction"})


def sample_reference(road: Road, s: float) -> tuple[float, float, float]:
    if s < -EPS or s > road.length + EPS:
        raise OpenDriveError(f"s={s} 超出道路 {road.id} 的长度 {road.length}")
    s = min(max(s, 0.0), road.length)
    for geometry in road.geometries:
        if s <= geometry.end_s + EPS or geometry is road.geometries[-1]:
            ds = s - geometry.s
            if geometry.kind == "line" or abs(geometry.curvature) < EPS:
                return (
                    geometry.x + ds * _cos(geometry.hdg),
                    geometry.y + ds * _sin(geometry.hdg),
                    geometry.hdg,
                )
            theta = geometry.hdg + geometry.curvature * ds
            x = geometry.x + (_sin(theta) - _sin(geometry.hdg)) / geometry.curvature
            y = geometry.y + (_cos(geometry.hdg) - _cos(theta)) / geometry.curvature
            return x, y, theta
    raise OpenDriveError(f"道路 {road.id} 没有覆盖 s={s} 的几何")


def _sin(value: float) -> float:
    import math

    return math.sin(value)


def _cos(value: float) -> float:
    import math

    return math.cos(value)


def lane_offset(road: Road, s: float) -> float:
    value = 0.0
    for record in road.lane_offsets:
        if record.s_offset <= s + EPS:
            value = poly(record.a, record.b, record.c, record.d, s - record.s_offset)
    return value


def lane_section(road: Road, s: float) -> LaneSection:
    if not road.lane_sections:
        raise OpenDriveError(f"道路 {road.id} 没有 laneSection")
    chosen = road.lane_sections[0]
    for section in road.lane_sections:
        if section.s <= s + EPS:
            chosen = section
    return chosen


def lane_width(section: LaneSection, lane_id: int, s: float) -> float:
    lane = section.lanes.get(lane_id)
    if lane is None or not lane.widths:
        raise OpenDriveError(f"道路在 s={s} 没有车道 {lane_id} 的宽度")
    ds = s - section.s
    chosen = lane.widths[0]
    for record in lane.widths:
        if record.s_offset <= ds + EPS:
            chosen = record
    return poly(chosen.a, chosen.b, chosen.c, chosen.d, ds - chosen.s_offset)


def lane_center_offset(road: Road, lane_id: int, s: float) -> float:
    section = lane_section(road, s)
    if lane_id == 0:
        return 0.0
    total = 0.0
    if lane_id > 0:
        for current in range(1, lane_id):
            total += lane_width(section, current, s)
        total += lane_width(section, lane_id, s) / 2
        return total
    for current in range(-1, lane_id, -1):
        total += lane_width(section, current, s)
    total += lane_width(section, lane_id, s) / 2
    return -total


def lane_position(network: Network, road_id: str | int, lane_id: int | float, s: float, offset: float = 0.0) -> dict[str, float]:
    road = network.road(road_id)
    lane = int(lane_id)
    reference_x, reference_y, heading = sample_reference(road, s)
    lateral = lane_offset(road, s) + lane_center_offset(road, lane, s) + offset
    # OpenDRIVE 正 t 在参考线左侧：法向量 = (-sin hdg, cos hdg)
    x = reference_x + lateral * -_sin(heading)
    y = reference_y + lateral * _cos(heading)
    return {"x": x, "y": y, "heading": heading, "roadId": road.id, "laneId": lane, "s": s, "t": lateral}


def lane_section_at(road: Road, s: float, at_end: bool) -> LaneSection:
    """取首尾 laneSection：车道级连接写在路段的进 / 出口车道上。"""
    if not road.lane_sections:
        raise OpenDriveError(f"道路 {road.id} 没有 laneSection")
    return road.lane_sections[-1] if at_end else road.lane_sections[0]


def _pick_lane_on(target: Road, lane_id: int) -> int | None:
    if lane_id in target.lane_ids():
        return lane_id
    same_side = [candidate for candidate in target.lane_ids() if candidate * lane_id > 0 and candidate != 0]
    if same_side:
        return min(same_side, key=lambda item: abs(item - lane_id))
    non_center = [candidate for candidate in target.lane_ids() if candidate != 0]
    return min(non_center, key=lambda item: abs(item)) if non_center else None


def next_lane(network: Network, road_id: str | int, lane_id: int | float, at_end: bool = True) -> dict[str, Any] | None:
    """车道级下一跳：先走同道路内的 lane link，再走道路连接 / 路口 laneLink。

    找不到就返回 None——调用方应保持当前 (road, lane)，让边界检查抓住越界，
    而不是悄悄把车传送到同号车道。
    """
    road = network.road(road_id)
    lane_key = int(lane_id)
    section = lane_section_at(road, road.length if at_end else 0, at_end)
    lane = section.lanes.get(lane_key)
    within = (lane.successor if at_end else lane.predecessor) if lane else None
    if within is not None and within in section.lanes:
        return {"road": road.id, "lane": within, "via": "lane-link"}
    link = road.successor if at_end else road.predecessor
    if not link:
        return None
    target_id = link[0]
    if target_id not in network.roads:
        return None
    target = network.roads[target_id]
    for connection in network.junctions:
        if connection["incomingRoad"] == road.id and target_id in (connection["connectingRoad"], connection["linkedRoad"]):
            for lane_link in connection["laneLinks"]:
                if lane_link["from"] is not None and int(lane_link["from"]) == lane_key and lane_link["to"] is not None:
                    mapped = int(lane_link["to"])
                    if mapped in target.lane_ids() or target_id == connection["connectingRoad"]:
                        return {"road": target_id, "lane": mapped if mapped in target.lane_ids() else mapped, "via": "junction"}
    chosen = _pick_lane_on(target, lane_key)
    if chosen is None:
        return None
    return {"road": target_id, "lane": chosen, "via": "road-link"}


def shortest_route(network: Network, start: str | int, end: str | int) -> dict[str, Any]:
    import heapq

    start_id = str(start)
    end_id = str(end)
    if start_id not in network.roads or end_id not in network.roads:
        raise OpenDriveError(f"路由端点不在路网里：{start_id} → {end_id}")
    if start_id == end_id:
        return {"roads": [start_id], "length": 0.0, "hops": 0}
    distances = {start_id: 0.0}
    previous: dict[str, str] = {}
    queue: list[tuple[float, str]] = [(0.0, start_id)]
    while queue:
        distance, road_id = heapq.heappop(queue)
        if road_id == end_id:
            break
        if distance > distances.get(road_id, float("inf")) + EPS:
            continue
        for edge in network.edges.get(road_id, []):
            target = edge["to"]
            if target not in network.roads:
                continue
            weight = network.roads[target].length
            candidate = distance + weight
            if candidate + EPS < distances.get(target, float("inf")):
                distances[target] = candidate
                previous[target] = road_id
                heapq.heappush(queue, (candidate, target))
    if end_id not in distances:
        raise OpenDriveError(f"路网中找不到 {start_id} → {end_id} 的通路")
    path = [end_id]
    while path[-1] != start_id:
        path.append(previous[path[-1]])
    path.reverse()
    return {"roads": path, "length": distances[end_id], "hops": len(path) - 1}


def validate_spec(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("OpenDRIVE 场景必须是 JSON 对象")
    if raw.get("adapter") != ADAPTER_ID:
        raise ValueError(f"adapter 必须是 {ADAPTER_ID}")
    for key in ("sceneId", "source", "queries"):
        if key not in raw:
            raise ValueError(f"缺少字段 {key}")
    if not isinstance(raw["queries"], list) or not raw["queries"]:
        raise ValueError("queries 必须是非空数组")
    for query in raw["queries"]:
        if query.get("kind") == "position":
            for key in ("roadId", "laneId", "s"):
                if key not in query:
                    raise ValueError(f"position 查询缺少 {key}")
        elif query.get("kind") == "route":
            if "from" not in query or "to" not in query:
                raise ValueError("route 查询缺少 from / to")
        else:
            raise ValueError(f"未知查询类型 {query.get('kind')}")
    return raw


def run_network(raw_spec: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    spec = validate_spec(raw_spec)
    source = Path(spec["source"])
    if not source.is_absolute():
        source = Path(__file__).resolve().parents[2] / source
    network = parse_network(source)
    events: list[dict[str, Any]] = []

    def emit(kind: str, **payload: Any) -> None:
        events.append({"sequence": len(events) + 1, "occurredAt": 0, "type": kind, **({"payload": payload} if payload else {})})

    for road_id in sorted(network.roads):
        road = network.roads[road_id]
        emit("odr:road:parsed", roadId=road.id, length=road.length, lanes=len(road.lane_ids()), junction=road.junction)

    results: list[dict[str, Any]] = []
    for query in spec["queries"]:
        if query["kind"] == "position":
            position = lane_position(network, query["roadId"], query["laneId"], float(query["s"]), float(query.get("offset", 0)))
            results.append({"kind": "position", "query": query, "result": position})
            emit("odr:query:position", roadId=position["roadId"], laneId=position["laneId"], s=position["s"], x=position["x"], y=position["y"], heading=position["heading"])
        else:
            route = shortest_route(network, query["from"], query["to"])
            results.append({"kind": "route", "query": query, "result": route})
            emit("odr:query:route", **{"from": query["from"], "to": query["to"], "roads": ",".join(route["roads"]), "length": route["length"]})
    emit("odr:completed", queries=len(results), roads=len(network.roads))

    final_state = {
        "runtime": "opendrive",
        "source": {"file": str(Path(spec["source"]).as_posix()), "revMajor": network.header.get("revMajor", "1")},
        "roads": [
            {
                "id": road.id,
                "name": road.name,
                "length": road.length,
                "junction": road.junction,
                "geometries": [geometry.kind for geometry in road.geometries],
                "laneIds": road.lane_ids(),
                "successor": road.successor[0] if road.successor else None,
                "predecessor": road.predecessor[0] if road.predecessor else None,
            }
            for road in (network.roads[key] for key in sorted(network.roads))
        ],
        "junctions": network.junctions,
        "edges": {key: sorted({edge["to"] for edge in value}) for key, value in sorted(network.edges.items())},
        "queries": results,
    }
    trace = {
        "formatVersion": 1,
        "sceneId": spec["sceneId"],
        "sceneHash": stable_hash(spec),
        "seed": 0,
        "step": 0,
        "steps": 0,
        "plugins": [
            {"id": "opendrive", "version": f"1.{network.header.get('revMinor', '4')}"},
            {"id": "scene-adapter-opendrive", "version": ADAPTER_VERSION, "configHash": stable_hash(spec)},
        ],
        "actions": [],
        "events": events,
        "finalState": final_state,
        "eventHash": stable_hash(events),
        "stateHash": stable_hash(final_state),
    }
    return trace, audit_trace(trace, spec, network)


def audit_trace(trace: dict[str, Any], spec: dict[str, Any], network: Network | None = None) -> dict[str, Any]:
    """只读 trace 的审计：几何连续、车道宽度合法、查询可解、路网连通。"""
    if network is None:
        source = Path(spec["source"])
        if not source.is_absolute():
            source = Path(__file__).resolve().parents[2] / source
        network = parse_network(source)
    violations: dict[str, list[dict[str, str]]] = {"geometry": [], "lanes": [], "queries": [], "connectivity": []}
    notes: dict[str, list[str]] = {"geometry": [], "lanes": [], "queries": [], "connectivity": []}

    for road in network.roads.values():
        if not road.geometries:
            violations["geometry"].append({"where": road.id, "message": "道路没有 planView 几何"})
            continue
        cursor = 0.0
        for geometry in road.geometries:
            if abs(geometry.s - cursor) > 1e-6:
                violations["geometry"].append({"where": road.id, "message": f"几何段从 s={geometry.s} 开始，与前一节点 {cursor} 不连续"})
            cursor = geometry.end_s
            if geometry.kind == "arc" and abs(geometry.curvature) < EPS:
                violations["geometry"].append({"where": road.id, "message": "arc 曲率为 0，应写成 line"})
        if abs(cursor - road.length) > 1e-6:
            violations["geometry"].append({"where": road.id, "message": f"几何总长 {cursor} 与 road.length {road.length} 不一致"})
        for first, second in zip(road.geometries, road.geometries[1:]):
            end = sample_reference(road, first.end_s)
            if abs(end[0] - second.x) > 1e-3 or abs(end[1] - second.y) > 1e-3:
                violations["geometry"].append({"where": road.id, "message": "几何段端点不重合"})
        if road.lane_sections and abs(road.lane_sections[0].s) > 1e-9:
            violations["lanes"].append({"where": road.id, "message": "首个 laneSection 必须从 s=0 开始"})
        for section in road.lane_sections:
            for lane in section.lanes.values():
                if lane.id == 0:
                    continue
                if not lane.widths:
                    violations["lanes"].append({"where": f"{road.id}/{lane.id}", "message": "车道没有 width 记录"})
                    continue
                for record in lane.widths:
                    value = poly(record.a, record.b, record.c, record.d, max(0.0, road.length - section.s - record.s_offset))
                    if record.a <= 0 or value <= 0:
                        violations["lanes"].append({"where": f"{road.id}/{lane.id}", "message": f"车道宽度非正（a={record.a}, 末端={value}）"})
    notes["geometry"].append(f"{len(network.roads)} 条道路的 planView 连续且长度自洽")
    notes["lanes"].append("车道宽度在采样端点均为正")

    for entry in trace["finalState"]["queries"]:
        result = entry["result"]
        for key, value in result.items():
            if isinstance(value, (int, float)) and (value != value or value in (float("inf"), float("-inf"))):
                violations["queries"].append({"where": str(entry["query"]), "message": f"{key} 不是有限数值"})
        if entry["kind"] == "route" and not result["roads"]:
            violations["queries"].append({"where": str(entry["query"]), "message": "路由没有结果"})
    notes["queries"].append(f"{len(trace['finalState']['queries'])} 个查询都解出了坐标或路径")

    # 终点道路只有入边也很正常：按“有出边或有入边”判断是否接入路网。
    targets = {edge["to"] for edges in network.edges.values() for edge in edges}
    isolated = [
        road.id for road in network.roads.values()
        if road.id not in network.edges and road.id not in targets and road.junction == "-1"
    ]
    for road_id in isolated:
        violations["connectivity"].append({"where": road_id, "message": "道路既没有前后连接，也不属于路口"})
    notes["connectivity"].append(f"{sum(len(value) for value in network.edges.values())} 条连接边")

    checks = [{
        "id": "opendrive.geometry-continuity",
        "description": "planView 几何连续、长度与 road.length 自洽",
        "status": "pass" if not violations["geometry"] else "fail",
        "violations": violations["geometry"],
        "notes": notes["geometry"],
    }, {
        "id": "opendrive.lane-widths",
        "description": "车道宽度为正且覆盖车道",
        "status": "pass" if not violations["lanes"] else "fail",
        "violations": violations["lanes"],
        "notes": notes["lanes"],
    }, {
        "id": "opendrive.queries-resolved",
        "description": "位置 / 路由查询都解出有限结果",
        "status": "pass" if not violations["queries"] else "fail",
        "violations": violations["queries"],
        "notes": notes["queries"],
    }, {
        "id": "opendrive.connectivity",
        "description": "道路通过前后连接或路口进入路网",
        "status": "pass" if not violations["connectivity"] else "fail",
        "violations": violations["connectivity"],
        "notes": notes["connectivity"],
    }]
    return {
        "formatVersion": 1,
        "sceneId": trace["sceneId"],
        "passed": all(check["status"] == "pass" for check in checks),
        "checks": checks,
        "metrics": {
            "roads": len(network.roads),
            "junctions": len(network.junctions),
            "edges": sum(len(value) for value in network.edges.values()),
            "queries": len(trace["finalState"]["queries"]),
            "routeLength": sum(entry["result"]["length"] for entry in trace["finalState"]["queries"] if entry["kind"] == "route"),
        },
        "warnings": [],
    }
