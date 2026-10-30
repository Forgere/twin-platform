from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from model import audit_trace, run_simulation, validate_spec
from run import main
from scene_spec import canonical_json, stable_hash


ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "scenes" / "two-stage-cell.json").read_text(encoding="utf-8"))


class CanonicalSpecTest(unittest.TestCase):
    def test_fnv_and_js_number_rules(self) -> None:
        self.assertEqual(stable_hash("hello"), "4f9f2cab")
        self.assertEqual(canonical_json({"b": 1.0, "a": -0.0}), '{"a":0,"b":1}')
        self.assertEqual(canonical_json(1e-6), "0.000001")
        self.assertEqual(canonical_json(1e-7), "1e-7")
        self.assertEqual(canonical_json(1e21), "1e+21")

    def test_hash_handles_non_bmp_like_javascript(self) -> None:
        # JS charCodeAt 读 UTF-16 code unit；不能按 Python 码点只算一次。
        self.assertEqual(stable_hash("😀"), stable_hash("😀"))
        self.assertNotEqual(stable_hash("😀"), stable_hash("😀x"))


class SimPyAdapterTest(unittest.TestCase):
    def test_same_seed_is_byte_identical_and_different_seed_diverges(self) -> None:
        first, first_report = run_simulation(deepcopy(SPEC))
        second, second_report = run_simulation(deepcopy(SPEC))
        self.assertEqual(canonical_json(first), canonical_json(second))
        self.assertEqual(canonical_json(first_report), canonical_json(second_report))
        self.assertTrue(first_report["passed"])
        changed = deepcopy(SPEC)
        changed["seed"] = SPEC["seed"] + 1
        other, _ = run_simulation(changed)
        self.assertNotEqual(first["eventHash"], other["eventHash"])

    def test_invariants_reject_tampered_trace(self) -> None:
        trace, report = run_simulation(deepcopy(SPEC))
        self.assertTrue(report["passed"])
        tampered = deepcopy(trace)
        tampered["events"] = [event for event in tampered["events"] if event["type"] != "job:completed"]
        audited = audit_trace(tampered, SPEC)
        by_id = {check["id"]: check for check in audited["checks"]}
        self.assertEqual(by_id["simpy.factory.conservation"]["status"], "fail")
        self.assertFalse(audited["passed"])

    def test_capacity_is_checked_from_events_not_self_reported_metrics(self) -> None:
        trace, _ = run_simulation(deepcopy(SPEC))
        # 构造两个相邻的加工开始事件，中间没有结束事件。
        first_start = next(index for index, event in enumerate(trace["events"]) if event["type"] == "job:process:start")
        extra = deepcopy(trace["events"][first_start])
        extra["sequence"] = first_start + 2
        extra["entityId"] = "job-injected"
        trace["events"].insert(first_start + 1, extra)
        audited = audit_trace(trace, SPEC)
        self.assertFalse(audited["passed"])

    def test_short_observation_window_warns_instead_of_faking_confidence(self) -> None:
        spec = deepcopy(SPEC)
        spec["duration"] = 1
        spec["minimumCompleted"] = 1
        _, report = run_simulation(spec)
        self.assertTrue(report["passed"])
        self.assertEqual(len(report["warnings"]), 1)
        self.assertIn("观察窗", report["warnings"][0])

    def test_cli_writes_deterministic_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spec_path = Path(temp) / "scene.json"
            spec_path.write_text(json.dumps(SPEC), encoding="utf-8")
            out = Path(temp) / "out"
            self.assertEqual(main(["--spec", str(spec_path), "--out", str(out)]), 0)
            first_trace = (out / "trace.json").read_bytes()
            first_report = (out / "report.json").read_bytes()
            self.assertEqual(main(["--spec", str(spec_path), "--out", str(out)]), 0)
            self.assertEqual(first_trace, (out / "trace.json").read_bytes())
            self.assertEqual(first_report, (out / "report.json").read_bytes())

    def test_invalid_spec_is_rejected(self) -> None:
        bad = deepcopy(SPEC)
        bad["processing"]["capacity"] = 0
        with self.assertRaisesRegex(ValueError, "capacity"):
            validate_spec(bad)
        bad_grid = deepcopy(SPEC)
        bad_grid["step"] = 7
        with self.assertRaisesRegex(ValueError, "整数倍"):
            validate_spec(bad_grid)


if __name__ == "__main__":
    unittest.main()
