#!/usr/bin/env python3
"""运行外部 FMI 2.0 Co-Simulation 场景，输出 scene-spec trace + audit report。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from fmi import run_fmu

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scene_spec import write_canonical_json  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="FMI 2.0 Co-Simulation → SceneTrace adapter")
    parser.add_argument("--spec", required=True, help="适配器场景 JSON")
    parser.add_argument("--out", required=True, help="产物目录（trace.json / report.json）")
    args = parser.parse_args(argv)
    try:
        with open(args.spec, encoding="utf-8") as source:
            spec = json.load(source)
        trace, report = run_fmu(spec)
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        write_canonical_json(str(out / "trace.json"), trace)
        write_canonical_json(str(out / "report.json"), report)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"scene-adapter-fmu: {error}", file=sys.stderr)
        return 2

    model = trace["finalState"]["model"]
    print(f"场景 {trace['sceneId']} · runtime=fmi2 model={model['modelName']} eventNum={len(trace['events'])}")
    print(f"哈希 scene={trace['sceneHash']} event={trace['eventHash']} state={trace['stateHash']}")
    print(f"末值 {report['metrics']['finalLevel']} · 峰值 {report['metrics']['peakLevel']} · 采样 {report['metrics']['samples']}")
    print(f"报告 {'PASS' if report['passed'] else 'FAIL'} · 产物 {out / 'trace.json'} / {out / 'report.json'}")
    for warning in report["warnings"]:
        print(f"警告 {warning}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
