"""一个不由 world-kernel 执行的 SimPy 离散事件场景。

两段工位：随机到料 → 加工（并行资源）→ 检测（并行资源）→ 完成。
所有随机来自场景 seed 创建的 `random.Random`，SimPy 进程按创建顺序排队。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import random
import sys
from typing import Any

import simpy

# 公共 canonical JSON / FNV 实现在 adapters/scene_spec.py，和 FMI adapter 共用一份。
if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scene_spec import stable_hash  # noqa: E402

ADAPTER_ID = "simpy.factory.v1"
ADAPTER_VERSION = "0.1.0"


@dataclass
class Job:
    id: str
    arrival: float
    process_start: float | None = None
    process_end: float | None = None
    inspect_start: float | None = None
    completed: float | None = None


def validate_spec(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("SimPy 场景必须是 JSON 对象")
    if raw.get("adapter") != ADAPTER_ID:
        raise ValueError(f"adapter 必须是 {ADAPTER_ID}")
    required = ("sceneId", "seed", "step", "duration", "arrival", "processing", "inspection")
    for key in required:
        if key not in raw:
            raise ValueError(f"缺少字段 {key}")
    if not isinstance(raw["sceneId"], str) or not raw["sceneId"]:
        raise ValueError("sceneId 必须是非空字符串")
    for key in ("step", "duration"):
        if not isinstance(raw[key], (int, float)) or raw[key] <= 0:
            raise ValueError(f"{key} 必须是正数")
    grid = raw["duration"] / raw["step"]
    if abs(grid - round(grid)) > 1e-9:
        raise ValueError("duration 必须是 step 观察网格的整数倍")
    for section, time_key in (("arrival", "meanInterval"), ("processing", "meanTime"), ("inspection", "meanTime")):
        if not isinstance(raw[section], dict) or raw[section].get(time_key, 0) <= 0:
            raise ValueError(f"{section}.{time_key} 必须是正数")
    for section in ("processing", "inspection"):
        capacity = raw[section].get("capacity")
        if not isinstance(capacity, int) or capacity < 1:
            raise ValueError(f"{section}.capacity 必须是正整数")
    if not isinstance(raw["seed"], int):
        raise ValueError("seed 必须是整数")
    return raw


def run_simulation(raw_spec: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    spec = validate_spec(raw_spec)
    seed = spec["seed"]
    duration = float(spec["duration"])
    rng = random.Random(seed)
    env = simpy.Environment()
    machines = simpy.Resource(env, capacity=spec["processing"]["capacity"])
    inspectors = simpy.Resource(env, capacity=spec["inspection"]["capacity"])
    jobs: list[Job] = []
    events: list[dict[str, Any]] = []
    busy = {"processing": 0.0, "inspection": 0.0}
    queue_peak = {"processing": 0, "inspection": 0}

    def emit(kind: str, time: float, job: Job, **payload: Any) -> None:
        events.append({
            "sequence": len(events) + 1,
            "occurredAt": time,
            "type": kind,
            "entityId": job.id,
            **({"payload": payload} if payload else {}),
        })

    def work(job: Job):
        emit("job:arrived", env.now, job)
        queue_peak["processing"] = max(queue_peak["processing"], len(machines.queue))
        with machines.request() as request:
            yield request
            job.process_start = env.now
            emit("job:process:start", env.now, job)
            service = rng.expovariate(1.0 / spec["processing"]["meanTime"])
            yield env.timeout(service)
            job.process_end = env.now
            busy["processing"] += service
            emit("job:process:end", env.now, job)
        queue_peak["inspection"] = max(queue_peak["inspection"], len(inspectors.queue))
        with inspectors.request() as request:
            yield request
            job.inspect_start = env.now
            emit("job:inspect:start", env.now, job)
            service = rng.expovariate(1.0 / spec["inspection"]["meanTime"])
            yield env.timeout(service)
            busy["inspection"] += service
            job.completed = env.now
            emit("job:completed", env.now, job, flowTime=env.now - job.arrival)

    def arrivals():
        while True:
            yield env.timeout(rng.expovariate(1.0 / spec["arrival"]["meanInterval"]))
            if env.now >= duration:
                break
            job = Job(id=f"job-{len(jobs) + 1:04d}", arrival=env.now)
            jobs.append(job)
            env.process(work(job))

    env.process(arrivals())
    env.run(until=duration)

    def optional(value: float | None) -> float | None:
        return value

    final_jobs = [{
        "id": job.id,
        "arrival": job.arrival,
        "processStart": optional(job.process_start),
        "processEnd": optional(job.process_end),
        "inspectStart": optional(job.inspect_start),
        "completedAt": optional(job.completed),
    } for job in jobs]
    completed = sum(job.completed is not None for job in jobs)
    total_flow = sum((job.completed or 0) - job.arrival for job in jobs if job.completed is not None)
    final_state = {
        "runtime": "simpy",
        "time": env.now,
        "jobs": final_jobs,
        "counts": {"created": len(jobs), "completed": completed, "wip": len(jobs) - completed},
        "resources": {
            "processing": {
                "capacity": spec["processing"]["capacity"],
                "busyTime": busy["processing"],
                "queuePeak": queue_peak["processing"],
            },
            "inspection": {
                "capacity": spec["inspection"]["capacity"],
                "busyTime": busy["inspection"],
                "queuePeak": queue_peak["inspection"],
            },
        },
        "totalFlowTime": total_flow,
    }
    # 只把会影响执行的输入锁进 configHash；minimumCompleted 是验收阈值，也保留。
    config_hash = stable_hash(spec)
    trace = {
        "formatVersion": 1,
        "sceneId": spec["sceneId"],
        "sceneHash": stable_hash(spec),
        "seed": seed,
        "step": spec["step"],
        "steps": int(duration / spec["step"] + 0.5),
        "plugins": [
            {"id": "simpy", "version": simpy.__version__},
            {"id": "scene-adapter-simpy", "version": ADAPTER_VERSION, "configHash": config_hash},
        ],
        "actions": list(spec.get("actions", [])),
        "events": events,
        "finalState": final_state,
        "eventHash": stable_hash(events),
        "stateHash": stable_hash(final_state),
    }
    return trace, audit_trace(trace, spec)


def audit_trace(trace: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    """审计只读 trace；篡改事件或末态会被不变量抓住，而不是信模型自报。"""
    violations: dict[str, list[dict[str, str]]] = {"chain": [], "capacity": [], "conservation": []}
    notes: dict[str, list[str]] = {"chain": [], "capacity": [], "conservation": []}
    events = trace["events"]
    expected_chain = ["job:arrived", "job:process:start", "job:process:end", "job:inspect:start", "job:completed"]
    by_job: dict[str, list[dict[str, Any]]] = {}
    previous_time = 0.0
    for event in events:
        if event["occurredAt"] < previous_time:
            violations["chain"].append({"where": str(event["sequence"]), "message": "事件 occurredAt 倒退"})
        previous_time = event["occurredAt"]
        by_job.setdefault(event.get("entityId", ""), []).append(event)
    for index, event in enumerate(events, start=1):
        if event["sequence"] != index:
            violations["chain"].append({"where": str(index), "message": "事件 sequence 不连续或不从 1 开始"})
            break
    for job_id, job_events in by_job.items():
        actual = [event["type"] for event in job_events]
        if actual != expected_chain[: len(actual)]:
            violations["chain"].append({"where": job_id, "message": f"工位链序非法：{' → '.join(actual)}"})
    notes["chain"].append(f"{len(by_job)} 个工件逐一核对到料 → 加工 → 检测 → 完成")

    active = {"processing": 0, "inspection": 0}
    capacity = {
        "processing": spec["processing"]["capacity"],
        "inspection": spec["inspection"]["capacity"],
    }
    deltas = {
        "job:process:start": ("processing", 1),
        "job:process:end": ("processing", -1),
        "job:inspect:start": ("inspection", 1),
        "job:completed": ("inspection", -1),
    }
    for event in events:
        change = deltas.get(event["type"])
        if change is None:
            continue
        resource, delta = change
        active[resource] += delta
        if active[resource] < 0 or active[resource] > capacity[resource]:
            violations["capacity"].append({
                "where": f"event:{event['sequence']}",
                "message": f"{resource} 并发 {active[resource]} 超出 0..{capacity[resource]}",
            })
    notes["capacity"].append("加工 / 检测并发从未超过声明资源数")

    counts = trace["finalState"]["counts"]
    completed_events = sum(event["type"] == "job:completed" for event in events)
    if counts["created"] != len(by_job):
        violations["conservation"].append({"where": "counts.created", "message": "created 与事件里的工件数不一致"})
    if counts["completed"] != completed_events:
        violations["conservation"].append({"where": "counts.completed", "message": "completed 与完成事件数不一致"})
    if counts["created"] != counts["completed"] + counts["wip"]:
        violations["conservation"].append({"where": "counts", "message": "物料不守恒：created ≠ completed + wip"})
    notes["conservation"].append(f"{counts['created']} = {counts['completed']} + {counts['wip']}")

    checks = []
    for check_id, description in (
        ("chain", "工件链序与事件序号合法"),
        ("capacity", "资源并发不超过声明容量"),
        ("conservation", "工件不凭空产生或丢失"),
    ):
        checks.append({
            "id": f"simpy.factory.{check_id}",
            "description": description,
            "status": "pass" if not violations[check_id] else "fail",
            "violations": violations[check_id],
            "notes": notes[check_id],
        })
    duration = float(spec["duration"])
    counts_data = trace["finalState"]["counts"]
    total_flow = trace["finalState"]["totalFlowTime"]
    resources = trace["finalState"]["resources"]
    metrics = {
        "created": counts_data["created"],
        "completed": counts_data["completed"],
        "wip": counts_data["wip"],
        "throughputPerHour": counts_data["completed"] / duration * 3600,
        "averageFlowTime": total_flow / counts_data["completed"] if counts_data["completed"] else 0,
        "processingUtilization": resources["processing"]["busyTime"] / (duration * resources["processing"]["capacity"]),
        "inspectionUtilization": resources["inspection"]["busyTime"] / (duration * resources["inspection"]["capacity"]),
        "processingQueuePeak": resources["processing"]["queuePeak"],
        "inspectionQueuePeak": resources["inspection"]["queuePeak"],
    }
    warnings = []
    minimum = spec.get("minimumCompleted", 1)
    if counts_data["completed"] < minimum:
        warnings.append(f"观察窗内只完成 {counts_data['completed']} 件，少于要求的 {minimum} 件；当前指标不足以支持结论")
    return {
        "formatVersion": 1,
        "sceneId": trace["sceneId"],
        "passed": all(check["status"] == "pass" for check in checks),
        "checks": checks,
        "metrics": metrics,
        "warnings": warnings,
    }
