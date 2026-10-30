from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest

from introspect import inspect_target

sys.path.append(str(Path(__file__).resolve().parents[1] / "simpy"))
from executor import run_model  # noqa: E402
from opendr import run_network
from osc import run_scenario
from run import main

ROOT = Path(__file__).resolve().parent
ADAPTERS = ROOT.parent
OSC_SCENE = ADAPTERS / "openscenario" / "scenes" / "follow-and-accelerate.xosc"
FMU_MODEL = ADAPTERS / "fmu" / "models" / "tank" / "modelDescription.xml"
SIMPY_MODEL = ADAPTERS / "simpy" / "model.py"
SIMPY_GENERIC_MODEL = ADAPTERS / "simpy" / "models" / "two_stage.py"
ODR_MAP = ADAPTERS / "opendrive" / "scenes" / "two-road-curve.xodr"
SPEC_JSON = ADAPTERS / "openscenario" / "scenes" / "follow-and-accelerate.json"


class IntrospectorTest(unittest.TestCase):
    def test_openscenario_target_is_introspected_and_can_propose_a_runnable_spec(self) -> None:
        introspection = inspect_target(str(OSC_SCENE))
        self.assertEqual(introspection["detection"]["kind"], "openscenario")
        self.assertEqual(introspection["model"]["openScenarioVersion"], "1.0")
        self.assertEqual(len(introspection["model"]["entities"]), 3)
        self.assertEqual(len(introspection["model"]["actions"]), 2)
        proposed = introspection["proposedSpec"]
        self.assertIsNotNone(proposed)
        self.assertEqual(proposed["adapter"], "openscenario.importer.v1")
        # 草案必须真的能跑，并且不变量通过：introspector 不是只写文档。
        _, report = run_scenario(proposed)
        self.assertTrue(report["passed"], [check["violations"] for check in report["checks"]])

    def test_fmu_model_description_is_introspected_without_loading_binaries(self) -> None:
        introspection = inspect_target(str(FMU_MODEL))
        self.assertEqual(introspection["detection"]["kind"], "fmi")
        names = {variable["name"] for variable in introspection["model"]["variables"]}
        self.assertIn("level", names)
        self.assertIn("inflow", names)
        # 单独一个 modelDescription 没有二进制：可执行契约应为 None，并给出错误发现。
        self.assertIsNone(introspection["detection"]["canRunWith"])
        self.assertTrue(any(item["id"] == "fmi.no-binary" for item in introspection["findings"]))
        self.assertIsNone(introspection["proposedSpec"])

    def test_opendrive_map_is_introspected_and_can_propose_a_runnable_query_spec(self) -> None:
        introspection = inspect_target(str(ODR_MAP))
        self.assertEqual(introspection["detection"]["kind"], "opendrive")
        self.assertEqual(len(introspection["model"]["roads"]), 2)
        self.assertGreater(introspection["model"]["edgeCount"], 0)
        proposed = introspection["proposedSpec"]
        self.assertIsNotNone(proposed)
        self.assertEqual(proposed["adapter"], "opendrive.network.v1")
        _, report = run_network(proposed)
        self.assertTrue(report["passed"], [check["violations"] for check in report["checks"]])

    def test_simpy_source_without_entrypoint_cannot_be_proposed(self) -> None:
        introspection = inspect_target(str(SIMPY_MODEL))
        self.assertEqual(introspection["model"]["kind"], "simpy")
        self.assertIn("simpy", introspection["model"]["imports"])
        self.assertTrue(introspection["model"]["processes"])
        self.assertIsNone(introspection["detection"]["canRunWith"])
        self.assertTrue(any(item["id"] == "python.no-entrypoint" for item in introspection["findings"]))

    def test_generic_simpy_model_is_proposed_as_runnable_spec(self) -> None:
        introspection = inspect_target(str(SIMPY_GENERIC_MODEL))
        self.assertEqual(introspection["detection"]["canRunWith"], "simpy.generic.v1")
        proposed = introspection["proposedSpec"]
        self.assertIsNotNone(proposed)
        self.assertEqual(proposed["entrypoint"], "run")
        # 参数从 params.get(...) 的默认值推断出来，而不是一律空 params。
        self.assertEqual(proposed["params"]["machineCapacity"], 2)
        self.assertEqual(proposed["params"]["inspectorCapacity"], 1)
        _, report = run_model(proposed, runs=2)
        self.assertTrue(report["passed"], [check["violations"] for check in report["checks"]])
        self.assertFalse(any(item["id"] == "python.nondeterminism" for item in introspection["findings"]))

    def test_nondeterministic_python_is_reported_as_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "risky.py"
            path.write_text("import simpy, random, time\n\ndef run():\n    env = simpy.Environment()\n    yield env.timeout(random.random() + time.time())\n", encoding="utf-8")
            introspection = inspect_target(str(path))
            risks = [item for item in introspection["findings"] if item["id"] == "python.nondeterminism"]
            self.assertTrue(risks)
            self.assertTrue(all(item["severity"] == "error" for item in risks))

    def test_scene_spec_json_is_recognized(self) -> None:
        introspection = inspect_target(str(SPEC_JSON))
        self.assertEqual(introspection["detection"]["kind"], "scene-spec")
        self.assertEqual(introspection["detection"]["canRunWith"], "openscenario.importer.v1")

    def test_cli_writes_artifacts_and_can_emit_spec(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "out"
            spec_file = Path(temp) / "proposed.json"
            self.assertEqual(main(["--target", str(OSC_SCENE), "--out", str(out), "--emit-spec", str(spec_file)]), 0)
            self.assertTrue((out / "introspection.json").exists())
            self.assertTrue((out / "report.json").exists())
            self.assertEqual(json.loads(spec_file.read_text(encoding="utf-8"))["adapter"], "openscenario.importer.v1")

    def test_unknown_target_fails_detection(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "notes.txt"
            path.write_text("not a model", encoding="utf-8")
            introspection = inspect_target(str(path))
            self.assertEqual(introspection["detection"]["kind"], "unknown")
            self.assertTrue(any(item["id"] == "target.unknown" for item in introspection["findings"]))


if __name__ == "__main__":
    unittest.main()
