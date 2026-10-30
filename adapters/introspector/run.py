#!/usr/bin/env python3
"""对外部模型工件做通用 introspection，输出 introspection.json + audit report。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from introspect import audit_introspection, inspect_target

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scene_spec import write_canonical_json  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="通用模型 introspector（不执行外部代码）")
    parser.add_argument("--target", required=True, help="模型工件：.fmu / 解包 FMU / .xosc / .py / 场景 JSON")
    parser.add_argument("--out", required=True, help="产物目录（introspection.json / report.json）")
    parser.add_argument("--emit-spec", help="把生成的场景草案单独写到这个文件")
    args = parser.parse_args(argv)
    try:
        introspection = inspect_target(args.target)
        report = audit_introspection(introspection)
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        write_canonical_json(str(out / "introspection.json"), introspection)
        write_canonical_json(str(out / "report.json"), report)
        if args.emit_spec:
            if introspection["proposedSpec"] is None:
                print("scene-introspector: 该目标没有可生成的场景草案", file=sys.stderr)
                return 2
            write_canonical_json(args.emit_spec, introspection["proposedSpec"])
    except (OSError, ValueError, SyntaxError, json.JSONDecodeError) as error:
        print(f"scene-introspector: {error}", file=sys.stderr)
        return 2

    detection = introspection["detection"]
    print(f"目标 {introspection['target']['path']} · {detection['kind']}/{detection['family']} · 可执行契约 {detection['canRunWith'] or '无'}")
    print(f"事实 variables={report['metrics']['variables']} entities={report['metrics']['entities']} resources={report['metrics']['resources']} actions={report['metrics']['actions']}")
    print(f"草案 {'有' if introspection['proposedSpec'] else '无'} · 发现 {report['metrics']['findings']} 条（错误 {report['metrics']['errors']}）")
    for finding in introspection["findings"]:
        print(f"{finding['severity'].upper()} {finding['id']}: {finding['message']}")
    print(f"报告 {'PASS' if report['passed'] else 'FAIL'} · 产物 {out / 'introspection.json'} / {out / 'report.json'}")
    if args.emit_spec:
        print(f"场景草案 {args.emit_spec}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
