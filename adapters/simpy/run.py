#!/usr/bin/env python3
"""运行外部 SimPy 场景，输出 scene-spec trace + audit report。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from pathlib import Path
import sys

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from executor import ADAPTER_ID as GENERIC_ADAPTER_ID, run_model
from model import run_simulation
from scene_spec import write_canonical_json  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="SimPy → SceneTrace adapter")
    parser.add_argument("--spec", required=True, help="适配器场景 JSON")
    parser.add_argument("--out", required=True, help="产物目录（trace.json / report.json）")
    args = parser.parse_args(argv)
    try:
        with open(args.spec, encoding="utf-8") as source:
            spec = json.load(source)
        generic = spec.get("adapter") == GENERIC_ADAPTER_ID
        trace, report = run_model(spec) if generic else run_simulation(spec)
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        write_canonical_json(str(out / "trace.json"), trace)
        write_canonical_json(str(out / "report.json"), report)
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        print(f"scene-adapter-simpy: {error}", file=sys.stderr)
        return 2

    print(f"场景 {trace['sceneId']} · runtime=simpy seed={trace['seed']} events={len(trace['events'])}")
    print(f"哈希 scene={trace['sceneHash']} event={trace['eventHash']} state={trace['stateHash']}")
    if spec.get("adapter") == GENERIC_ADAPTER_ID:
        print(f"进程 {report['metrics']['processes']} · 资源 {report['metrics']['resources']} · 队列峰值 {report['metrics']['queuePeak']} · 结束 {report['metrics']['envNow']}")
    else:
        print(f"物料 created={report['metrics']['created']} completed={report['metrics']['completed']} wip={report['metrics']['wip']}")
    print(f"报告 {'PASS' if report['passed'] else 'FAIL'} · 产物 {out / 'trace.json'} / {out / 'report.json'}")
    for warning in report["warnings"]:
        print(f"警告 {warning}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
