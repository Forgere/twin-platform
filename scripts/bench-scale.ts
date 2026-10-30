/**
 * 规模化压测：1000+ 实体。
 *
 * 项目自带的场景模板都很小（line 11 / factory 28 / center 45 个实体），
 * 要验证"规模上去之后还跑不跑得动"，就得自己造规模。做法是**复制物流中心
 * 场景**：每份整体平移到网格格点上、id 加前缀，并把 config/attrs 里对实体 id
 * 的引用一起改掉——行为是按 capability 选实体的（见 `asrs.ts` / `source.ts`），
 * motion 路径是内联坐标，所以复制后的 N 份是 N 个彼此独立、各自跑通的车间。
 *
 * 测四件事：
 * 1. **内核步进**：稳态下每步耗时（µs）、吞吐（steps/s）、随规模的曲线是线性还是劣化；
 * 2. **差分帧压力**：每帧 changed 实体数——这是渲染层 / 网络层每帧真正要处理的工作量；
 * 3. **快照**：`snapshot()` / `restore()` 耗时与体积——回放拖拽定位靠它；
 * 4. **落库**：1000+ 实体的状态 upsert 与事件流 append 吞吐（内存 / 真实 PG）。
 *
 * 用法：
 *   bun run bench:scale
 *   BENCH_COPIES=1,5,10,25 BENCH_STEPS=300 bun run bench:scale
 *
 * 环境变量：`BENCH_COPIES`（规模档位，复制份数）、`BENCH_WARMUP`（预热步）、
 * `BENCH_STEPS`（计时步）、`BENCH_EVENTS`（落库事件条数）、`BENCH_STORAGE=0` 可跳过落库。
 */

import { PluginHost } from '@twin-platform/plugin-sdk';
import { TwinWorld } from '@twin-platform/world-kernel';
import { buildCenterScene, logisticsPlugin } from '@twin-platform/plugins-logistics';
import { parseSceneDocument, type TwinEntity, type TwinScene, type TwinVector3 } from '@twin-platform/scene-schema';
import { createMemoryStorage } from '@twin-platform/storage-memory';
import type { EntityStateRecord, WorldEvent } from '@twin-platform/world-kernel';

const COPIES = (process.env.BENCH_COPIES ?? '1,5,10,25,50')
  .split(',')
  .map((part) => Number(part.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 900);
const STEPS = Number(process.env.BENCH_STEPS ?? 300);
/**
 * 货物密度：默认把每份的在制上限拉到 40、产出间隔压到 0.5 s。
 * 不这么做的话预热结束时每份只有 1 个在制货物（默认 6 s 一个），
 * 压测就变成"几千台设备空转"，测不到货物路径/motion 那部分真实成本。
 */
const MAX_WIP = Number(process.env.BENCH_MAXWIP ?? 40);
const PRODUCE_INTERVAL = Number(process.env.BENCH_PRODUCE ?? 0.5);
const EVENT_COUNT = Number(process.env.BENCH_EVENTS ?? 20000);
const WITH_STORAGE = (process.env.BENCH_STORAGE ?? '1') !== '0';
const STEP = 1 / 60;

/** 场景复制的格点间距（米）：远大于单个中心的尺寸，保证各份互不重叠。 */
const SPACING = 400;

// ---------------------------------------------------------------------------
// 造规模
// ---------------------------------------------------------------------------

/** 深度遍历，把"恰好等于某个实体 id"的字符串加上前缀（保持内部引用一致）。 */
function rewriteIds<T>(value: T, ids: ReadonlySet<string>, prefix: string): T {
  if (typeof value === 'string') return (ids.has(value) ? prefix + value : value) as T;
  if (Array.isArray(value)) return value.map((item) => rewriteIds(item, ids, prefix)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = rewriteIds(item, ids, prefix);
    }
    return out as T;
  }
  return value;
}

/** 把基准场景复制 `copies` 份，网格布局、id 加前缀、引用同步改写。 */
function replicate(base: TwinScene, copies: number): TwinScene {
  const ids = new Set(base.entities.map((entity) => entity.id));
  const cols = Math.max(1, Math.ceil(Math.sqrt(copies)));
  const entities: TwinEntity[] = [];

  for (let copy = 0; copy < copies; copy += 1) {
    const prefix = `c${copy}_`;
    const dx = (copy % cols) * SPACING;
    const dz = Math.floor(copy / cols) * SPACING;
    for (const entity of base.entities) {
      const clone = structuredClone(entity) as TwinEntity;
      clone.id = prefix + entity.id;
      const [px, py, pz] = clone.transform.position as TwinVector3;
      clone.transform = { ...clone.transform, position: [px + dx, py, pz + dz] };
      if (clone.config !== undefined) clone.config = rewriteIds(clone.config, ids, prefix);
      if (clone.attrs !== undefined) clone.attrs = rewriteIds(clone.attrs, ids, prefix);
      if (clone.dataBindings !== undefined) clone.dataBindings = rewriteIds(clone.dataBindings, ids, prefix);
      entities.push(clone);
    }
  }

  return { version: base.version, id: 'scale-bench', name: `规模化压测 ×${copies}`, entities };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const now = (): number => performance.now();
const mb = (bytes: number): number => bytes / (1024 * 1024);
const heapMB = (): number => mb(process.memoryUsage().heapUsed);

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[index]!;
}

const fmt = (value: number, digits = 1): string => value.toFixed(digits);

interface Row {
  copies: number;
  sceneEntities: number;
  liveEntities: number;
  buildMs: number;
  parseMs: number;
  worldMs: number;
  stepAvgUs: number;
  stepP95Us: number;
  stepMaxUs: number;
  stepsPerSec: number;
  changedPerFrame: number;
  eventsPerStep: number;
  snapMs: number;
  snapMB: number;
  restoreMs: number;
  run60Ms: number;
  heapMB: number;
}

// ---------------------------------------------------------------------------
// 内核压测
// ---------------------------------------------------------------------------

function benchScale(copies: number): Row | null {
  const base = buildCenterScene({ maxWip: MAX_WIP, produceInterval: PRODUCE_INTERVAL });

  let t0 = now();
  const scene = replicate(base, copies);
  const buildMs = now() - t0;

  // 走真实导入路径：JSON 字符串 → 解析 → 校验 → 版本迁移。
  const document = JSON.stringify(scene);
  t0 = now();
  const parsed = parseSceneDocument(document);
  const parseMs = now() - t0;
  if (!parsed.ok) {
    console.error(`  ✗ 规模 ${copies} 的场景校验不通过：${parsed.issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`).join(' | ')}`);
    return null;
  }

  t0 = now();
  const host = new PluginHost();
  host.install(logisticsPlugin);
  const world = new TwinWorld(scene, { seed: 20240906, maxStepsPerAdvance: 600, behaviors: host.behaviors });
  const worldMs = now() - t0;

  // 预热：让发生器把在制货物铺满、行为进入稳态，避免把启动瞬态算进吞吐。
  for (let i = 0; i < WARMUP; i += 1) world.step(STEP);
  const liveEntities = world.listEntities().length;

  const durations: number[] = [];
  let changed = 0;
  const eventsBefore = world.getEventLog().length;

  t0 = now();
  for (let i = 0; i < STEPS; i += 1) {
    const stepStart = now();
    const delta = world.step(STEP);
    durations.push((now() - stepStart) * 1000); // µs
    changed += delta.changed.length;
  }
  const totalMs = now() - t0;
  const eventsPerStep = (world.getEventLog().length - eventsBefore) / STEPS;

  t0 = now();
  const snapshot = world.snapshot();
  const snapMs = now() - t0;
  const snapMB = mb(JSON.stringify(snapshot).length);

  t0 = now();
  world.restore(snapshot);
  const restoreMs = now() - t0;

  // 高倍速回放：一次推进 60 步（相当于 60× 倍速）。
  t0 = now();
  world.runSteps(60);
  const run60Ms = now() - t0;

  const stepAvgUs = durations.reduce((sum, value) => sum + value, 0) / durations.length;

  return {
    copies,
    sceneEntities: scene.entities.length,
    liveEntities,
    buildMs,
    parseMs,
    worldMs,
    stepAvgUs,
    stepP95Us: percentile(durations, 0.95),
    stepMaxUs: percentile(durations, 1),
    stepsPerSec: (STEPS / totalMs) * 1000,
    changedPerFrame: changed / STEPS,
    eventsPerStep,
    snapMs,
    snapMB,
    restoreMs,
    run60Ms,
    heapMB: heapMB(),
  };
}

// ---------------------------------------------------------------------------
// 落库压测
// ---------------------------------------------------------------------------

function makeEntities(count: number): EntityStateRecord[] {
  const out: EntityStateRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      entityId: `e${i}`,
      kind: i % 3 === 0 ? 'transport' : 'parcel',
      status: 'running',
      attrs: { lane: i % 8 },
      transform: { position: [i % 100, 0, Math.floor(i / 100)], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      dataSource: 'sim',
      updatedSequence: i,
      updatedAt: i * STEP,
    });
  }
  return out;
}

function makeEvents(count: number): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      sequence: i + 1,
      occurredAt: i * STEP,
      type: i % 4 === 0 ? 'spawn' : 'move',
      entityId: `e${i % 1000}`,
      payload: { distance: i * 0.01 },
    } as WorldEvent);
  }
  return out;
}

async function benchStorage(entityCount: number): Promise<void> {
  console.log('\n## 落库（稳态一次刷新：1000+ 实体状态 + 事件流）\n');
  const states = makeEntities(entityCount);
  const events = makeEvents(EVENT_COUNT);

  // 内存后端
  const memory = createMemoryStorage();
  await memory.scenes.putScene({ version: 1, id: 'bench', name: 'bench', entities: [] });

  let t0 = now();
  await memory.state.upsert('bench', states);
  const memStateMs = now() - t0;

  t0 = now();
  await memory.events.append('bench', events);
  const memEventMs = now() - t0;

  t0 = now();
  const read = await memory.state.list('bench');
  const memReadMs = now() - t0;

  console.log(`| 后端 | 操作 | 规模 | 耗时 | 吞吐 |`);
  console.log(`|---|---|---|---|---|`);
  console.log(`| memory | state.upsert | ${entityCount} 实体 | ${fmt(memStateMs)} ms | ${fmt((entityCount / memStateMs) * 1000, 0)} 实体/s |`);
  console.log(`| memory | events.append | ${EVENT_COUNT} 事件 | ${fmt(memEventMs)} ms | ${fmt((EVENT_COUNT / memEventMs) * 1000, 0)} 事件/s |`);
  console.log(`| memory | state.list | ${read.length} 实体 | ${fmt(memReadMs)} ms | — |`);

  // 真实 PostgreSQL（PGlite / WASM）
  // 注意：这里直接注入 executor，不走 `pglite://` 连接串——不是为了省事，而是
  // 让本脚本在 Windows 侧 bun 下也能跑（那边包内 node_modules 的符号链接是断的）。
  const pgliteMod = (await import('@electric-sql/pglite').catch(() => null)) as
    | { PGlite: { create(options?: { dataDir?: string }): Promise<PgliteLike> } }
    | null;
  if (!pgliteMod) {
    console.log('\n> 未解析到 `@electric-sql/pglite`，跳过真实 PostgreSQL 落库压测（WSL 内 bun 可跑）。');
    return;
  }

  const { connectPostgresStorage } = await import('@twin-platform/storage-postgres');
  const db = await pgliteMod.PGlite.create({ dataDir: 'memory://' });
  const executor = {
    async query(text: string, params?: readonly unknown[]) {
      if (params && params.length > 0) {
        const res = await db.query(text, params as unknown[]);
        return (res.rows ?? []) as never;
      }
      const res = await db.exec(text);
      return (res[res.length - 1]?.rows ?? []) as never;
    },
  };
  const pg = await connectPostgresStorage({ executor });

  t0 = now();
  await pg.storage.state.upsert('bench', states);
  const pgStateMs = now() - t0;

  t0 = now();
  await pg.storage.events.append('bench', events);
  const pgEventMs = now() - t0;

  t0 = now();
  const pgRead = await pg.storage.state.list('bench');
  const pgReadMs = now() - t0;

  console.log(`| postgres(pglite) | state.upsert | ${entityCount} 实体 | ${fmt(pgStateMs)} ms | ${fmt((entityCount / pgStateMs) * 1000, 0)} 实体/s |`);
  console.log(`| postgres(pglite) | events.append | ${EVENT_COUNT} 事件 | ${fmt(pgEventMs)} ms | ${fmt((EVENT_COUNT / pgEventMs) * 1000, 0)} 事件/s |`);
  console.log(`| postgres(pglite) | state.list | ${pgRead.length} 实体 | ${fmt(pgReadMs)} ms | — |`);
  console.log(`| postgres(pglite) | 迁移+建连 | — | ${fmt(pg.migration.applied.length)} 个迁移 | driver=${pg.driver.kind} |`);

  await pg.driver.close();
}

interface PgliteLike {
  query(text: string, params?: readonly unknown[]): Promise<{ rows?: unknown[] }>;
  exec(text: string): Promise<{ rows?: unknown[] }[]>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log(`# 规模化压测\n`);
console.log(`- 场景：物流中心模板复制（每份 45 实体 + 运行时在制货物）`);
console.log(`- 步长：${STEP.toFixed(5)} s（60Hz）｜预热 ${WARMUP} 步 ｜计时 ${STEPS} 步`);
console.log(`- 运行时：${process.version} / Bun ${process.versions?.bun ?? '?'} / ${process.platform}\n`);

const rows: Row[] = [];
for (const copies of COPIES) {
  console.log(`\n> 规模 ×${copies}（${copies * 45} 静态实体）…`);
  try {
    const row = benchScale(copies);
    if (row) {
      rows.push(row);
      console.log(
        `  ${row.liveEntities} 实体在跑 ｜ ${fmt(row.stepAvgUs)} µs/步 ｜ ${fmt(row.stepsPerSec, 0)} steps/s ｜ ` +
          `每帧 changed ${fmt(row.changedPerFrame, 0)} ｜ 快照 ${fmt(row.snapMs)} ms / ${fmt(row.snapMB, 2)} MB ｜ 堆 ${fmt(row.heapMB, 0)} MB`,
      );
    }
  } catch (error) {
    console.error(`  ✗ 规模 ×${copies} 崩了：${String((error as Error).message).slice(0, 300)}`);
  }
}

console.log('\n## 汇总\n');
console.log('| 复制份数 | 静态实体 | 稳态实体 | 构建 ms | 校验 ms | 建世界 ms | 平均 µs/步 | P95 µs/步 | 最大 µs/步 | steps/s | 每帧 changed | 事件/步 | 快照 ms | 快照 MB | 恢复 ms | 60× 回放 ms | 堆 MB |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const row of rows) {
  console.log(
    `| ${row.copies} | ${row.sceneEntities} | ${row.liveEntities} | ${fmt(row.buildMs)} | ${fmt(row.parseMs)} | ${fmt(row.worldMs)} | ` +
      `${fmt(row.stepAvgUs)} | ${fmt(row.stepP95Us)} | ${fmt(row.stepMaxUs)} | ${fmt(row.stepsPerSec, 0)} | ${fmt(row.changedPerFrame, 0)} | ` +
      `${fmt(row.eventsPerStep, 1)} | ${fmt(row.snapMs)} | ${fmt(row.snapMB, 2)} | ${fmt(row.restoreMs)} | ${fmt(row.run60Ms)} | ${fmt(row.heapMB, 0)} |`,
  );
}

if (WITH_STORAGE) {
  try {
    await benchStorage(1000);
  } catch (error) {
    console.error(`落库压测失败：${String((error as Error).message).slice(0, 300)}`);
  }
}

// 结论区：把"能不能扛住 1000+ 实体"落成一句可判定的话。
const big = rows.filter((row) => row.liveEntities >= 1000);
if (big.length > 0) {
  console.log('\n## 判定\n');
  for (const row of big) {
    // 60Hz 实时：每步预算 16.7 ms；留一半给渲染与 IO，取 8 ms 作为内核红线。
    const budgetUs = 8000;
    const verdict = row.stepAvgUs < budgetUs ? '可以实时' : row.stepAvgUs < 16_700 ? '勉强实时（吃掉全部帧预算）' : '无法实时（需降步长/分帧）';
    console.log(`- ${row.liveEntities} 实体：${fmt(row.stepAvgUs)} µs/步 = 帧预算(16.7ms)的 ${fmt((row.stepAvgUs / 16_700) * 100)}% → ${verdict}`);
  }
}
