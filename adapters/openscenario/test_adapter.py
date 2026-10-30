from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from osc import OpenScenarioError, audit_trace, parse_scenario, run_scenario
from run import main
from scene_spec import canonical_json

ROOT = Path(__file__).resolve().parent
SPEC = json.loads((ROOT / "scenes" / "follow-and-accelerate.json").read_text(encoding="utf-8"))
CROSS_SPEC = json.loads((ROOT / "scenes" / "cross-on-opendrive.json").read_text(encoding="utf-8"))
SAMPLE = ROOT / "scenes" / "follow-and-accelerate.xosc"


class OpenScenarioImporterTest(unittest.TestCase):
    def test_sample_scenario_imports_and_passes_invariants(self) -> None:
        trace, report = run_scenario(deepcopy(SPEC))
        self.assertTrue(report["passed"], [check["violations"] for check in report["checks"]])
        self.assertEqual(trace["sceneId"], "osc-follow-and-accelerate")
        self.assertEqual(report["metrics"]["entities"], 3)
        self.assertEqual(report["metrics"]["actions"], 2)
        self.assertEqual(trace["steps"], 40)

    def test_parse_reads_entities_and_scheduled_actions(self) -> None:
        scenario = parse_scenario(SAMPLE)
        self.assertEqual(scenario.rev_major, "1")
        self.assertEqual(sorted(scenario.vehicles), ["ego", "lead", "side"])
        self.assertEqual([(action.entity, action.kind, action.at) for action in scenario.actions], [
            ("ego", "speed", 4),
            ("lead", "speed", 6),
        ])
        self.assertEqual(scenario.vehicles["ego"].s, 10)
        self.assertEqual(scenario.vehicles["lead"].speed, 10)

    def test_same_spec_is_deterministic(self) -> None:
        first, _ = run_scenario(deepcopy(SPEC))
        second, _ = run_scenario(deepcopy(SPEC))
        self.assertEqual(canonical_json(first), canonical_json(second))

    def test_audit_rejects_missing_action_event_and_too_small_gap(self) -> None:
        trace, _ = run_scenario(deepcopy(SPEC))
        tampered = deepcopy(trace)
        tampered["events"] = [event for event in tampered["events"] if event["type"] != "osc:speed:set"]
        report = audit_trace(tampered, SPEC)
        statuses = {check["id"]: check["status"] for check in report["checks"]}
        self.assertEqual(statuses["openscenario.actions-applied"], "fail")
        self.assertFalse(report["passed"])

        crowded = deepcopy(trace)
        crowded["finalState"]["limits"]["minGap"] = 1e9
        gap_report = audit_trace(crowded, SPEC)
        statuses = {check["id"]: check["status"] for check in gap_report["checks"]}
        self.assertEqual(statuses["openscenario.gap"], "fail")

    def test_out_of_road_sample_fails_bounds_check(self) -> None:
        trace, _ = run_scenario(deepcopy(SPEC))
        tampered = deepcopy(trace)
        tampered["finalState"]["samples"][0]["entities"]["ego"]["lane"] = 99
        report = audit_trace(tampered, SPEC)
        statuses = {check["id"]: check["status"] for check in report["checks"]}
        self.assertEqual(statuses["openscenario.road-bounds"], "fail")

    def test_vehicle_crosses_roads_by_lane_level_routing(self) -> None:
        trace, report = run_scenario(json.loads(json.dumps(CROSS_SPEC)))
        self.assertTrue(report["passed"], [check["violations"] for check in report["checks"]])
        crossings = [event for event in trace["events"] if event["type"] == "osc:road:enter"]
        self.assertTrue(crossings)
        self.assertEqual(crossings[0]["entityId"], "ego")
        self.assertEqual(crossings[0]["payload"]["road"], "1")
        final = trace["finalState"]["samples"][-1]["entities"]
        self.assertEqual(final["ego"]["road"], "1")
        self.assertEqual(final["follower"]["road"], "0")

    def test_cli_writes_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spec_path = Path(temp) / "scene.json"
            spec_path.write_text(json.dumps(SPEC), encoding="utf-8")
            out = Path(temp) / "out"
            self.assertEqual(main(["--spec", str(spec_path), "--out", str(out)]), 0)
            self.assertTrue((out / "trace.json").exists())
            self.assertTrue((out / "report.json").exists())


class OpenScenarioSubsetTest(unittest.TestCase):
    def write(self, filename: str, content: str) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / filename
        path.write_text(content, encoding="utf-8")
        return path

    def test_unsupported_constructs_are_rejected(self) -> None:
        path = self.write("lanechange.xosc", """<OpenSCENARIO>
          <FileHeader revMajor="1" revMinor="0"/>
          <Entities><ScenarioObject name="ego"><Vehicle name="v" vehicleCategory="car"/></ScenarioObject></Entities>
          <Storyboard><Init/><Story name="s"><Act name="a"><ManeuverGroup name="g">
            <Actors><EntityRef entityRef="ego"/></Actors>
            <Maneuver name="m"><Event name="e"><Action name="act"><PrivateAction>
              <LateralAction><LaneChangeAction><LaneChangeTarget><RelativeTargetLane entityRef="ego" value="-1"/></LaneChangeTarget></LaneChangeAction></LateralAction>
            </PrivateAction></Action><StartTrigger><ConditionGroup><Condition name="c"><ByValueCondition><SimulationTimeCondition value="1" rule="greaterThan"/></ByValueCondition></Condition></ConditionGroup></StartTrigger></Event></Maneuver>
          </ManeuverGroup></Act></Story></Storyboard>
        </OpenSCENARIO>""")
        with self.assertRaisesRegex(OpenScenarioError, "LateralAction"):
            parse_scenario(path)

    def test_wrong_root_and_version_are_rejected(self) -> None:
        wrong_root = self.write("wrong.xosc", "<Other><FileHeader revMajor=\"1\"/></Other>")
        with self.assertRaisesRegex(OpenScenarioError, "根元素"):
            parse_scenario(wrong_root)
        wrong_version = self.write("v2.xosc", """<OpenSCENARIO>
          <FileHeader revMajor="2" revMinor="0"/>
          <Entities><ScenarioObject name="ego"><Vehicle name="v" vehicleCategory="car"/></ScenarioObject></Entities>
          <Storyboard><Init/></Storyboard>
        </OpenSCENARIO>""")
        with self.assertRaisesRegex(OpenScenarioError, "只导入 OpenSCENARIO 1.x"):
            parse_scenario(wrong_version)

    def test_world_position_is_rejected_with_clear_reason(self) -> None:
        path = self.write("world.xosc", """<OpenSCENARIO>
          <FileHeader revMajor="1" revMinor="0"/>
          <Entities><ScenarioObject name="ego"><Vehicle name="v" vehicleCategory="car"/></ScenarioObject></Entities>
          <Storyboard><Init><Actions><Private entityRef="ego"><PrivateAction>
            <PositionAction><Position><WorldPosition x="1" y="2" z="3"/></Position></PositionAction>
          </PrivateAction></Private></Actions></Init></Storyboard>
        </OpenSCENARIO>""")
        with self.assertRaisesRegex(OpenScenarioError, "WorldPosition"):
            parse_scenario(path)

    def test_invalid_spec_is_rejected(self) -> None:
        for override in ({"adapter": "wrong"}, {"duration": 20.3}, {"road": {"length": 0, "laneWidth": 3.5}}):
            bad = deepcopy(SPEC)
            bad.update(override)
            with self.assertRaises(ValueError):
                run_scenario(bad)


if __name__ == "__main__":
    unittest.main()
