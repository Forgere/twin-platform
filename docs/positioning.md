# Twin Platform: Verifiable Simulation Scenes

> **Make simulation scenes testable, replayable, auditable, and ready for CI—just like code.**

Twin Platform is infrastructure for simulation-scene quality assurance. Its focus is not another renderer, digital-twin dashboard, or general-purpose world model. It answers a more concrete engineering question:

> **Your digital twin moves, but can you prove that it is not misleading you?**

## The contract

A verifiable scene locks down the inputs required for a run: versioned scene data, plugin versions and configuration, a random seed, a fixed time step, external actions, invariants, and metric definitions. A headless run produces evidence rather than only animation:

- a canonical event trace and final-state snapshot;
- scene, event, and state hashes;
- invariant violations and metric values;
- observation-window and silent-change warnings;
- the first divergence between two traces, addressed by JSON Pointer;
- a deterministic, self-contained HTML audit report.

The reference implementation uses `world-kernel`, but the trace and audit contracts do not depend on it. External runtimes can implement the same evidence contract without adopting the reference kernel or the Studio UI.

## Two reference scenes, one quality discipline

The **logistics factory** exercises industrial invariants: material conservation, closed-loop flow, equipment motion, and event semantics. The **fishing scene** shows that stochastic behavior can also be verified: seeded random consumption, legal rig geometry, action effects, and reproducible bite-signal sequences.

They are examples and conformance suites, not two separate products. If the same runner and audit discipline work in both domains, a new plugin has a clear contract to implement and test.

## One command, one verifiable scene package

A **scene package** bundles every input for one verifiable run—versioned `scene.json`, a plugin lock (`plugins.lock.json`, not "whatever I have installed"), a `seed.json` time grid, optional `actions.json`, the invariants to assert (`invariants.json`), and a golden `expected/trace.json`. One command runs the whole thing:

```bash
bun run scene audit  --package examples/community/mini-line
bun run scene replay --package examples/community/mini-line   # default baseline = the package's own expected/trace.json
```

An `invariants.json` entry that carries `"check": "<built-in id>"` is **actually executed**, not merely declared; an unregistered id fails rather than silently passing. Built-in checks cover loop lines (`logistics.line.loop` / `no-teleport`), the closed-loop center (`logistics.center.flow` / `conservation`), and deterministic quiescence (`scene.deterministic.quiet`). The center checks are **borrowed references** to the plugin's own exports—the exact objects Studio's audit panel uses—so "what CI blocks" and "what the page shows" can never drift apart.

The loop invariant is the one that catches a real metric lie: on a **loop line**, a parcel fires `parcel:exit` then `parcel:enter` every lap, so any dashboard counting `parcel:exit` as shipped throughput is wrong. `logistics.line.loop` asserts `exit == enter − 1` (still on the loop). Set a parcel's `motion.loop` to `clamp` and the CLI exits 1 naming that parcel.

Want the four headline claims—cross-OS determinism, tamper detection with a JSON Pointer, one gate over SimPy/FMU/OpenSCENARIO, and one-command scene packages—reproduced end-to-end? Run `bun scripts/demo-evidence.ts` (evidence lands in `./demo-evidence/`; add `--only core` to skip the Python runtimes).

## Bring your own model—no need to rebuild the twin

You don't author a scene from a blank page. `adapters/introspector` reads an existing artifact (OpenSCENARIO `.xosc`, FMU `.fmu`, SimPy `.py`, CSV) **without executing it**—Python via AST, FMU via its description, OpenSCENARIO via XML—emits a runnable scene draft, and hands it to the matching adapter, then the same TypeScript gate (`scene verify`) recomputes the hashes. End-to-end, one `.xosc` reaches a passing `verify` in ~0.15s; the OpenSCENARIO and OpenDRIVE drafts are not documents—their unit tests feed the drafts straight into a real run and assert the invariants.

Building the twin—device connectors, dashboards, asset pipelines—is deliberately **out of scope** (that is Ditto / FIWARE territory). This layer guarantees one thing: a model you already have can enter the verifiable chain with a single command.


## What this is not

Twin Platform does not aim to replace IoT backends, 3D asset standards, industrial simulators, or LLM-based world models. Rendering, databases, MQTT, LLMs, and external simulators are adapters around the verification contract. The first product boundary is deliberately small:

```text
load scene → lock plugins → run with a fixed seed
→ collect events and metrics → check invariants
→ emit trace + report → diff against baseline → pass/fail in CI
```

## Repository map

- `packages/scene-spec`: runtime-independent trace, audit, eval, and diff contracts
- `packages/scene-runner`: headless run and deterministic replay for the reference kernel
- `packages/scene-audit`: invariant execution, eval harness, observation checks, and HTML reports
- `packages/plugin-conformance`: self-check suite every plugin must pass before entering the verification chain
- `CONTRIBUTING.md`: how to contribute rules, scenes, adapters, and plugins
- `examples/community/mini-line`: a community-shaped scene package demonstrating the external contribution path
- `packages/world-kernel`: deterministic reference runtime
- `packages/plugins-logistics`: industrial reference scene and invariants
- `packages/plugins-fishing`: stochastic reference scene and executable evals
- `apps/studio`: optional interactive workbench
- `adapters/simpy`: external Python + SimPy runtime, including a sandboxed executor for arbitrary SimPy model files
- `adapters/fmu`: external FMI 2.0 Co-Simulation runtime loading real FMU binaries with the same evidence contract
- `adapters/openscenario`: importer for an explicit subset of ASAM OpenSCENARIO 1.x scenario XML
- `adapters/introspector`: static introspection of external model artifacts without executing their code
- `adapters/opendrive`: road-network solver turning OpenDRIVE lane positions into real world coordinates

See [可验证场景公共层](./可验证场景.md) for the API and trace semantics, and [开源方向与行动计划](./开源方向与行动计划.md) for the roadmap.
