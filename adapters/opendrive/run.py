#!/usr/bin/env python3
"""OpenDRIVE 路网求解：把 LanePosition 解算成世界坐标，并给出路网连通性与路由。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from opendr import run_network

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.append(str(Path(__file__).resolve().parents[1]))
from scene_spec import write_canonical_json  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="OpenDRIVE → 路网求解 / SceneTrace adapter")
    parser.add_argument("--spec", required=True, help="求解场景 JSON")
    parser.add_argument("--out", required=True, help="产物目录（trace.json / report.json）")
    args = parser.parse_args(argv)
    try:
        with open(args.spec, encoding="utf-8") as source:
            spec = json.load(source)
        trace, report = run_network(spec)
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        write_canonical_json(str(out / "trace.json"), trace)
        write_canonical_json(str(out / "report.json"), report)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"scene-adapter-opendrive: {error}", file=sys.stderr)
        return 2

    print(f"场景 {trace['sceneId']} · runtime=opendrive roads={report['metrics']['roads']} queries={report['metrics']['queries']}")
    print(f"哈希 scene={trace['sceneHash']} event={trace['eventHash']} state={trace['stateHash']}")
    for entry in trace["finalState"]["queries"]:
        result = entry["result"]
        if entry["kind"] == "position":
            print(f"位置 road={result['roadId']} lane={result['laneId']} s={result['s']} → x={result['x']:.6f} y={result['y']:.6f} hdg={result['heading']:.6f}")
        else:
            print(f"路由 {result['roads']} → 长度 {result['length']:.3f}")
    print(f"报告 {'PASS' if report['passed'] else 'FAIL'} · 产物 {out / 'trace.json'} / {out / 'report.json'}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
