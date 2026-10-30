from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from opendr import (
    OpenDriveError,
    audit_trace,
    lane_position,
    next_lane,
    parse_network,
    run_network,
    shortest_route,
)
from run import main
from scene_spec import canonical_json

ROOT = Path(__file__).resolve().parent
SAMPLE = ROOT / "scenes" / "two-road-curve.xodr"
SPEC = json.loads((ROOT / "scenes" / "two-road-curve.json").read_text(encoding="utf-8"))


class OpenDriveSolverTest(unittest.TestCase):
    def test_straight_lane_position_is_solved_from_geometry_and_width(self) -> None:
        network = parse_network(SAMPLE)
        position = lane_position(network, "0", -1, 30)
        # 参考线沿 +X；右侧车道 -1 中心在 t=-1.75（车道宽 3.5 的一半）。
        self.assertAlmostEqual(position["x"], 30.0, places=9)
        self.assertAlmostEqual(position["y"], -1.75, places=9)
        self.assertAlmostEqual(position["heading"], 0.0, places=9)

    def test_arc_geometry_is_solved_not_assumed_straight(self) -> None:
        network = parse_network(SAMPLE)
        straight_if_wrong = {"x": 150.0, "y": -1.75}
        position = lane_position(network, "0", -1, 150)
        self.assertNotAlmostEqual(position["x"], straight_if_wrong["x"], places=3)
        self.assertNotAlmostEqual(position["y"], straight_if_wrong["y"], places=3)
        self.assertGreater(position["heading"], 0.4)
        self.assertLess(position["heading"], 0.6)

    def test_lane_offsets_stack_across_lanes(self) -> None:
        network = parse_network(SAMPLE)
        first = lane_position(network, "0", -1, 30)
        second = lane_position(network, "0", -2, 30)
        self.assertAlmostEqual(first["t"] - second["t"], 3.5, places=9)

    def test_lane_level_next_hop_follows_road_connection(self) -> None:
        network = parse_network(SAMPLE)
        following = next_lane(network, "0", -1)
        self.assertIsNotNone(following)
        self.assertEqual(following["road"], "1")
        self.assertEqual(following["lane"], -1)
        self.assertIn(following["via"], ("road-link", "junction", "lane-link"))
        # 终点道路没有后继：必须诚实返回 None，而不是编一条路。
        self.assertIsNone(next_lane(network, "1", -1))

    def test_route_uses_road_linkage(self) -> None:
        network = parse_network(SAMPLE)
        route = shortest_route(network, "0", "1")
        self.assertEqual(route["roads"], ["0", "1"])
        self.assertAlmostEqual(route["length"], 150.0, places=9)

    def test_run_produces_passing_report_and_is_deterministic(self) -> None:
        first, first_report = run_network(json.loads(json.dumps(SPEC)))
        second, second_report = run_network(json.loads(json.dumps(SPEC)))
        self.assertEqual(canonical_json(first), canonical_json(second))
        self.assertEqual(canonical_json(first_report), canonical_json(second_report))
        self.assertTrue(first_report["passed"], [check["violations"] for check in first_report["checks"]])

    def test_audit_catches_geometry_gap(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "gap.xodr"
            path.write_text(SAMPLE.read_text(encoding="utf-8").replace('s="100" x="100"', 's="110" x="100"'), encoding="utf-8")
            network = parse_network(path)
            trace, _ = run_network({
                "adapter": "opendrive.network.v1",
                "sceneId": "gap",
                "source": str(path),
                "queries": [{"kind": "position", "roadId": "0", "laneId": -1, "s": 30}],
            })
            report = audit_trace(trace, {"source": str(path)}, network)
            statuses = {check["id"]: check["status"] for check in report["checks"]}
            self.assertEqual(statuses["opendrive.geometry-continuity"], "fail")
            self.assertFalse(report["passed"])

    def test_cli_writes_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spec_path = Path(temp) / "scene.json"
            spec_path.write_text(json.dumps(SPEC), encoding="utf-8")
            out = Path(temp) / "out"
            self.assertEqual(main(["--spec", str(spec_path), "--out", str(out)]), 0)
            self.assertTrue((out / "trace.json").exists())
            self.assertTrue((out / "report.json").exists())


class OpenDriveSubsetTest(unittest.TestCase):
    def write(self, content: str) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "model.xodr"
        path.write_text(content, encoding="utf-8")
        return path

    def base_road(self, geometry: str) -> str:
        return f"""<OpenDRIVE><header revMajor="1" revMinor="4"/>
          <road id="0" length="100" junction="-1">
            <planView>{geometry}</planView>
            <lanes><laneSection s="0"><center><lane id="0" type="driving"/></center>
              <right><lane id="-1" type="driving"><width sOffset="0" a="3.5"/></lane></right>
            </laneSection></lanes>
          </road></OpenDRIVE>"""

    def test_spiral_is_rejected(self) -> None:
        path = self.write(self.base_road('<geometry s="0" x="0" y="0" hdg="0" length="100"><spiral curvStart="0" curvEnd="0.01"/></geometry>'))
        with self.assertRaisesRegex(OpenDriveError, "spiral"):
            parse_network(path)

    def test_param_poly3_is_rejected(self) -> None:
        path = self.write(self.base_road('<geometry s="0" x="0" y="0" hdg="0" length="100"><paramPoly3 aU="0" bU="1" cU="0" dU="0" aV="0" bV="0" cV="0" dV="0"/></geometry>'))
        with self.assertRaisesRegex(OpenDriveError, "paramPoly3"):
            parse_network(path)

    def test_wrong_root_and_bad_spec_are_rejected(self) -> None:
        wrong = self.write("<Other><header revMajor=\"1\"/></Other>")
        with self.assertRaisesRegex(OpenDriveError, "根元素"):
            parse_network(wrong)
        bad = json.loads(json.dumps(SPEC))
        bad["queries"] = [{"kind": "teleport"}]
        with self.assertRaises(ValueError):
            run_network(bad)


if __name__ == "__main__":
    unittest.main()
