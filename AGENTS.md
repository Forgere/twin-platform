# Agent Guide

This is a SolidJS 2.x project. Solid is not React: components run once (there is no re-render), reactivity is fine-grained through signals, and effects/memos have Solid-specific semantics. Do not port React patterns.

## Versioned skills (in node_modules — read on demand)

The installed packages ship agent skills that match their exact installed versions:

- `node_modules/solid-js/skills/reactivity-diagnostics/SKILL.md` — repair guide mapping every dev-mode diagnostic code (e.g. `REACTIVE_WRITE_IN_OWNED_SCOPE`, `STRICT_READ_UNTRACKED`) to its prescribed fix. Read it whenever a Solid diagnostic code appears in test output or the browser console.
- `node_modules/@solidjs/diagnostics/skills/agent-loops/SKILL.md` — how to capture reactive evidence (which scopes re-ran and why, wasted recomputes, cost tables) and assert budgets, in tests and against live pages.

## Project skills (`.agents/skills/<name>/SKILL.md` — auto-discovered)

This repo ships its own skills for the logistics domain; the harness scans `.agents/skills/` and puts each `description` into the model catalog, so they fire without a restart:

- `factory-scene` — 搭建 / 改造工厂产线场景：场景模板、布局铁律、行为接线、测试与阶段文档（动 `template.ts` 前读）。
- `device-plugin` — 新增设备类型或扩展物流插件：设备工厂 + 3D 模型 + 行为 + 注册 + 测试（动 `devices.ts` / 行为文件 / manifest 前读）。

新增第三个 skill：在 `.agents/skills/<name>/SKILL.md` 建文件，frontmatter 必须有 `name` 与 `description`，正文用「步骤 + 完成标准 + 参考」三段。

## Reactive diagnostics — capture evidence instead of guessing

Use these whenever you are debugging reactivity (something doesn't update, updates too often, or is slow) or verifying a change didn't regress update granularity:

- **In tests:** `captureArtifact()` from `@solidjs/diagnostics` wraps a scenario and returns a serializable artifact of diagnostics + rerun attribution; matchers from `@solidjs/diagnostics/vitest` (`toHaveNoDiagnostics`, `toStayWithinRerunBudget`, `toHaveNoWaste`, …) assert on it. No browser needed.
- **Against the running dev server** (`diagnostics: true` in vite.config.ts; dev-only, no-op in builds). Requires an open page connected to the dev server (e.g. via a browser tool):
  - `GET /__solid/diagnostics` — status and connected client count
  - `POST /__solid/diagnostics` with JSON `{"method":"begin"}` then `{"method":"end"}` — capture a session into an artifact
  - `{"method":"whyDidRun","params":{"name":"<scope name>"}}` — recorded re-runs of one named scope in the open session
  - `{"method":"costs"}` — running cost tables for the open session

Name your signals/memos/effects (the `{ name: "..." }` option) — attribution reports scopes by name.

## Monorepo layout

Bun workspaces: `apps/*`、`packages/*`、`plugins/*`。

- `packages/scene-schema` — 版本化场景契约 + 校验 + 迁移。
- `packages/world-kernel` — 世界内核，零 UI / Three / DOM 依赖。
- `packages/plugin-sdk` — 插件 manifest、能力、生命周期与故障隔离（`SafeBehavior`）。
- `packages/analytics-core` — 窗口聚合、规则与产线指标（纯函数，确定性）。
- `packages/plugins-logistics` — 输送线领域插件（设备工厂 / 行为 / 模板 / 指标）。领域插件统一放在 `packages/plugins-<domain>/`，由 `plugin-sdk` 暴露能力，不修改 `world-kernel`。
- `packages/scenario-compare` — 从历史快照分叉两条仿真路径并比对结构化结果。
- `packages/storage-contracts` — 仓储接口（内核与数据库之间唯一的缝）。
- `packages/storage-memory` — 内存实现，浏览器演示与测试用。
- `packages/storage-postgres` — PostgreSQL 实现 + `migrations/`。
- `packages/storage-testkit` — 各 Adapter 共用的仓储契约测试。
- `packages/replay-core` — 会话录制（`SessionRecorder`）+ 确定性时间轴（`ReplayController`）。
- `packages/data-source-csv` — CSV 外部数据源 Adapter。
- `apps/studio` — Solid 工作台，只消费内核的 `FrameDelta`，不自己推演状态。
- `apps/server` — REST API（`/api/*`）+ 同源托管 Studio；`TWIN_API_TOKEN` 开共享鉴权。
- `apps/worker` — Cloudflare Worker：静态资产 + `/api/*` 反代，**注入** `Authorization`。
  token 不进前端 bundle，浏览器只知道同源 `/api/*`。

包之间用 `@twin-platform/*` 互相引用。根 `tsconfig.json` 里配了 `paths`，
所以即便不装软链（Windows 侧 IDE、CI）也能解析；新增包要同步登记 `paths`
和根 `package.json` 的 `typecheck:packages`。

## Commands

```bash
bun install          # 在 WSL 里执行（会重建 workspace 软链）
bun run test         # bun test packages + apps/server + apps/worker —— 包与服务端的单元测试
bun run typecheck    # Studio + 全部包 + apps（server / worker）
bun run dev          # Studio 开发服务器
bun run dev:server   # apps/server（默认 :8787，设 TWIN_API_TOKEN 才开鉴权）
bun run dev:worker   # apps/worker 的 wrangler dev（默认 :8787，上游读 apps/worker/.dev.vars）
```

包的测试用 `bun:test`（`import { test, expect } from "bun:test"`），
放在 `src/*.test.ts`，被各包 tsconfig 的 `exclude` 排除在类型检查之外
（仓库还没装 `bun-types`）。`apps/studio` 的组件测试仍然走 vitest。

## Determinism rules (world-kernel)

改动 `packages/world-kernel` 前先读这几条，违反任一条都会让回放与方案对比失效：

1. 时间只走固定步长（`step(dt)` / `advance(realDelta)`），不允许把真实帧间隔直接当 `dt`。
2. 随机只来自注入的 `ctx.rng`，内核里禁止 `Math.random()`、`Date.now()`。
3. 遍历顺序固定：实体按场景顺序，行为按注册顺序；顺序即契约。
4. 新增状态要进 `WorldSnapshot`（含 `rngState`），否则 `restore()` 后重放会分叉。
5. 改了行为就补一条确定性测试：同种子两次运行比对指纹（`world.test.ts` 里的 `fingerprint()`）。

## Replay rules (replay-core)

1. 倍速只改变"一帧吃几个步长"，步长本身不变；1× 与 50× 必须得到同一指纹。
2. `seek(t)` 靠重算：恢复最近快照 → 截断之后事件 → 按固定步长推到 t，不做插值。
3. 往回跳是分叉：`events.truncateAfter` 之后，旧时间线的事件不得再出现在查询里。
4. `SessionRecorder` 只搬运（事件/快照/状态投影/指标），不得写回世界状态。
5. 外部数据源必须可重放：实现 `rewind()`，禁止读挂钟或 `Math.random()`。
6. 新增 Storage Adapter 必须接入 `storage-testkit` 的契约测试。

## Plugin & analytics determinism

- `plugins-*` 行为必须只用注入的 `ctx.rng`，禁止 `Math.random()` / `Date.now()`，否则方案对比（`scenario-compare`）会分叉。
- `analytics-core` 的窗口/指标是纯函数：同一事件流必须得到逐位一致的结果；边界用半开区间 `[start, end)`，`until` 只定义桶网格、事件不向外延伸（到边界即 clamp）。
- `scenario-compare` 从同一快照 `restore()` 出两条世界再各自推进；任何"行为里偷偷读挂钟"都会让 `metricDeltas` 不可复现。
