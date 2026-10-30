from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "scripts"))

from fmi import audit_trace, parse_model_description, run_fmu  # noqa: E402
from build_reference_fmu import build  # noqa: E402
from run import main  # noqa: E402
from scene_spec import canonical_json  # noqa: E402

SPEC = json.loads((ROOT / "scenes" / "tank-step.json").read_text(encoding="utf-8"))
COMPILER = shutil.which("cc") or shutil.which("gcc") or shutil.which("cl")


@unittest.skipUnless(COMPILER, "需要 C 编译器来构建参考 FMU")
class FmuAdapterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory()
        base = Path(cls.temp.name)
        cls.out_dir = base / "tank"
        cls.fmu_path = base / "tank.fmu"
        build(COMPILER, cls.out_dir, cls.fmu_path)  # type: ignore[arg-type]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temp.cleanup()

    def spec(self, **overrides: object) -> dict:
        result = deepcopy(SPEC)
        result.update(overrides)  # type: ignore[arg-type]
        return result

    def test_model_description_is_parsed_from_fmu(self) -> None:
        description = parse_model_description(self.out_dir / "modelDescription.xml")
        self.assertEqual(description.fmi_version, "2.0")
        self.assertEqual(description.model_identifier, "tank")
        self.assertIn("level", description.variables)
        self.assertEqual(description.variables["inflow"].causality, "input")

    def test_unpacked_and_zipped_fmu_produce_the_same_trace(self) -> None:
        unpacked, unpacked_report = run_fmu(self.spec(fmu=str(self.out_dir)))
        zipped, zipped_report = run_fmu(self.spec(fmu=str(self.fmu_path)))
        # sceneHash 含 FMU 路径，解包目录与 .fmu 本来就该不同；执行证据必须一致。
        self.assertEqual(unpacked["eventHash"], zipped["eventHash"])
        self.assertEqual(unpacked["stateHash"], zipped["stateHash"])
        self.assertEqual(canonical_json(unpacked["events"]), canonical_json(zipped["events"]))
        self.assertEqual(canonical_json(unpacked["finalState"]), canonical_json(zipped["finalState"]))
        self.assertEqual(canonical_json(unpacked["actions"]), canonical_json(zipped["actions"]))
        self.assertEqual(canonical_json(unpacked_report), canonical_json(zipped_report))
        self.assertTrue(unpacked_report["passed"])
        self.assertEqual(unpacked["steps"], 120)

    def test_same_spec_is_deterministic_across_runs(self) -> None:
        first, _ = run_fmu(self.spec(fmu=str(self.fmu_path)))
        second, _ = run_fmu(self.spec(fmu=str(self.fmu_path)))
        self.assertEqual(canonical_json(first), canonical_json(second))

    def test_audit_rejects_missing_input_event_and_out_of_range_output(self) -> None:
        trace, _ = run_fmu(self.spec(fmu=str(self.fmu_path)))
        tampered = deepcopy(trace)
        tampered["events"] = [event for event in tampered["events"] if event["type"] != "fmu:input:set"]
        report = audit_trace(tampered, SPEC)
        statuses = {check["id"]: check["status"] for check in report["checks"]}
        self.assertEqual(statuses["fmu.input-applied"], "fail")
        self.assertFalse(report["passed"])

        tightened = deepcopy(trace)
        peak = max(sample["level"] for sample in trace["finalState"]["samples"])
        tightened["finalState"]["limits"]["max"] = peak - 0.001
        tightened["stateHash"] = "ignored"
        range_report = audit_trace(tightened, SPEC)
        statuses = {check["id"]: check["status"] for check in range_report["checks"]}
        self.assertEqual(statuses["fmu.output-range"], "fail")

    def test_cli_writes_artifacts_and_fails_on_violation(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spec_path = Path(temp) / "scene.json"
            spec_path.write_text(json.dumps(self.spec(fmu=str(self.fmu_path))), encoding="utf-8")
            out = Path(temp) / "out"
            self.assertEqual(main(["--spec", str(spec_path), "--out", str(out)]), 0)
            self.assertTrue((out / "trace.json").exists())
            self.assertTrue((out / "report.json").exists())

            failing = self.spec(fmu=str(self.fmu_path), limits={"min": 0, "max": 0.001})
            bad_path = Path(temp) / "bad.json"
            bad_path.write_text(json.dumps(failing), encoding="utf-8")
            self.assertEqual(main(["--spec", str(bad_path), "--out", str(Path(temp) / "bad-out")]), 1)


class FmuSpecTest(unittest.TestCase):
    def test_invalid_spec_is_rejected(self) -> None:
        for override in (
            {"adapter": "wrong"},
            {"stopTime": 120.5},
            {"variables": {"output": "level"}, "inputs": [{"at": 500, "value": 1}]},
        ):
            bad = deepcopy(SPEC)
            bad.update(override)
            with self.assertRaises(ValueError):
                run_fmu(bad)

    def test_missing_fmu_is_rejected(self) -> None:
        bad = deepcopy(SPEC)
        bad["fmu"] = "adapters/fmu/build/does-not-exist.fmu"
        with self.assertRaisesRegex(ValueError, "找不到 FMU"):
            run_fmu(bad)

    def test_wrong_fmi_version_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "modelDescription.xml"
            path.write_text('<fmiModelDescription fmiVersion="3.0" modelName="x" guid="g"/>', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "只支持 FMI 2.0"):
                parse_model_description(path)


if __name__ == "__main__":
    unittest.main()
