# Agent Guide

This is a SolidJS 2.x project. Solid is not React: components run once (there is no re-render), reactivity is fine-grained through signals, and effects/memos have Solid-specific semantics. Do not port React patterns.

## Versioned skills (in node_modules — read on demand)

The installed packages ship agent skills that match their exact installed versions:

- `node_modules/solid-js/skills/reactivity-diagnostics/SKILL.md` — repair guide mapping every dev-mode diagnostic code (e.g. `REACTIVE_WRITE_IN_OWNED_SCOPE`, `STRICT_READ_UNTRACKED`) to its prescribed fix. Read it whenever a Solid diagnostic code appears in test output or the browser console.
- `node_modules/@solidjs/diagnostics/skills/agent-loops/SKILL.md` — how to capture reactive evidence (which scopes re-ran and why, wasted recomputes, cost tables) and assert budgets, in tests and against live pages.

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
- `packages/storage-contracts` — 仓储接口（内核与数据库之间唯一的缝）。
- `packages/storage-memory` — 内存实现，浏览器演示与测试用。
- `packages/storage-postgres` — PostgreSQL 实现 + `migrations/`。
- `packages/storage-testkit` — 各 Adapter 共用的仓储契约测试。
- `packages/replay-core` — 会话录制（`SessionRecorder`）+ 确定性时间轴（`ReplayController`）。
- `packages/data-source-csv` — CSV 外部数据源 Adapter。
- `apps/studio` — Solid 工作台，只消费内核的 `FrameDelta`，不自己推演状态。

包之间用 `@twin-platform/*` 互相引用。根 `tsconfig.json` 里配了 `paths`，
所以即便不装软链（Windows 侧 IDE、CI）也能解析；新增包要同步登记 `paths`
和根 `package.json` 的 `typecheck:packages`。

## Commands

```bash
bun install          # 在 WSL 里执行（会重建 workspace 软链）
bun run test         # bun test packages —— 包的单元测试
bun run typecheck    # Studio + 全部包
bun run dev          # Studio 开发服务器
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
