#!/usr/bin/env python3
"""运行 OpenSCENARIO 导入场景，输出 scene-spec trace + audit report。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from osc import run_scenario

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scene_spec import write_canonical_json  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="OpenSCENARIO → SceneTrace importer")
    parser.add_argument("--spec", required=True, help="导入场景 JSON")
    parser.add_argument("--out", required=True, help="产物目录（trace.json / report.json）")
    args = parser.parse_args(argv)
    try:
        with open(args.spec, encoding="utf-8") as source:
            spec = json.load(source)
        trace, report = run_scenario(spec)
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        write_canonical_json(str(out / "trace.json"), trace)
        write_canonical_json(str(out / "report.json"), report)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"scene-adapter-openscenario: {error}", file=sys.stderr)
        return 2

    source_meta = trace["finalState"]["source"]
    print(f"场景 {trace['sceneId']} · runtime=openscenario {source_meta['revMajor']}.{source_meta['revMinor']} events={len(trace['events'])}")
    print(f"哈希 scene={trace['sceneHash']} event={trace['eventHash']} state={trace['stateHash']}")
    print(f"车辆 {report['metrics']['entities']} · 导入动作 {report['metrics']['actions']} · 采样 {report['metrics']['samples']}")
    print(f"报告 {'PASS' if report['passed'] else 'FAIL'} · 产物 {out / 'trace.json'} / {out / 'report.json'}")
    for warning in report["warnings"]:
        print(f"警告 {warning}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
