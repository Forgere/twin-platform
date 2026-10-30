from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from executor import ModelRejected, run_model, static_precheck
from run import main

from scene_spec import canonical_json

ROOT = Path(__file__).resolve().parent
SPEC = json.loads((ROOT / "scenes" / "two-stage-generic.json").read_text(encoding="utf-8"))
FACTORY_SPEC = json.loads((ROOT / "scenes" / "two-stage-cell.json").read_text(encoding="utf-8"))


class GenericSimPyExecutorTest(unittest.TestCase):
    def test_model_runs_and_produces_trace_with_resource_events(self) -> None:
        trace, report = run_model(dict(SPEC))
        self.assertTrue(report["passed"], [check["violations"] for check in report["checks"]])
        self.assertEqual(trace["sceneId"], "simpy-generic-two-stage")
        self.assertEqual(trace["finalState"]["runtime"], "simpy-generic")
        kinds = {event["type"] for event in trace["events"]}
        self.assertTrue({"sim:process:start", "resource:request", "resource:acquire", "sim:completed"} <= kinds)
        self.assertEqual(len(trace["finalState"]["resources"]), 2)
        self.assertGreaterEqual(report["metrics"]["events"], 50)

    def test_same_spec_is_deterministic_and_seed_changes_trace(self) -> None:
        first, _ = run_model(dict(SPEC), runs=2)
        second, _ = run_model(dict(SPEC), runs=2)
        self.assertEqual(canonical_json(first), canonical_json(second))
        other = dict(SPEC)
        other["seed"] = SPEC["seed"] + 1
        changed, _ = run_model(other, runs=1)
        self.assertNotEqual(first["eventHash"], changed["eventHash"])

    def test_capacity_violation_is_detected_from_traced_resources(self) -> None:
        spec = dict(SPEC)
        spec["params"] = dict(SPEC["params"])
        spec["params"]["machineCapacity"] = 1
        trace, report = run_model(spec, runs=1)
        # 容量收紧后并发仍应不超过声明值；若追踪失效，这里会直接失败。
        for resource in trace["finalState"]["resources"]:
            self.assertLessEqual(resource["maxUsers"], resource["capacity"])
        self.assertTrue(report["passed"])

    def test_builtin_factory_adapter_still_works(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spec_path = Path(temp) / "scene.json"
            spec_path.write_text(json.dumps(FACTORY_SPEC), encoding="utf-8")
            self.assertEqual(main(["--spec", str(spec_path), "--out", str(Path(temp) / "out")]), 0)

    def test_generic_cli_writes_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spec_path = Path(temp) / "scene.json"
            spec_path.write_text(json.dumps(SPEC), encoding="utf-8")
            out = Path(temp) / "out"
            self.assertEqual(main(["--spec", str(spec_path), "--out", str(out)]), 0)
            self.assertTrue((out / "trace.json").exists())
            self.assertTrue((out / "report.json").exists())


class SandboxTest(unittest.TestCase):
    def write_model(self, source: str) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "model.py"
        path.write_text(source, encoding="utf-8")
        return path

    def spec_for(self, path: Path) -> dict:
        spec = dict(SPEC)
        spec["model"] = str(path)
        spec["until"] = 20
        spec["minimumEvents"] = 1
        return spec

    def test_dangerous_imports_are_rejected_statically(self) -> None:
        for source in (
            "import time\n\ndef run(env, rng, params, until):\n    yield from []\n",
            "import os\n\ndef run(env, rng, params, until):\n    pass\n",
            "import simpy\n\ndef run(env, rng, params, until):\n    open('x.txt')\n",
        ):
            path = self.write_model(source)
            with self.assertRaises(ModelRejected):
                run_model(self.spec_for(path), runs=1)

    def test_global_random_is_blocked_even_when_imported(self) -> None:
        path = self.write_model(
            "import simpy\nimport random\n\n\ndef run(env, rng, params, until):\n"
            "    def job():\n        yield env.timeout(random.random())\n"
            "    env.process(job())\n    env.run(until=until)\n    return env\n"
        )
        with self.assertRaisesRegex(ModelRejected, "全局 random"):
            run_model(self.spec_for(path), runs=1)

    def test_static_precheck_reports_allowed_imports_only(self) -> None:
        path = self.write_model("import simpy\nimport math\n\ndef run(env, rng, params, until):\n    return env\n")
        result = static_precheck(path.read_text(encoding="utf-8"), path)
        self.assertEqual(result["imports"], ["math", "simpy"])


if __name__ == "__main__":
    unittest.main()
