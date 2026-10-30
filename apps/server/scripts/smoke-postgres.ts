/**
 * Postgres 后端冒烟验证。
 *
 * 目的：不装 PostgreSQL 也能证明"Postgres 后端这条链路"是通的——建连、迁移、
 * 仓储 CRUD、级联删除。默认用 PGlite（WASM 版真实 PostgreSQL，进程内内存库），
 * 因此 `bun run smoke:postgres` 零外部依赖即可跑。
 *
 * 想打真实 PostgreSQL：`DATABASE_URL=postgres://... bun run smoke:postgres`。
 *
 * 它只验证存储层，不启 HTTP；接口层冒烟另有 `bun run dev` + 手动点。
 */

import { createServerStorage, removeScene } from '../src/storage';

const url = process.env.DATABASE_URL ?? 'pglite://memory';

const checks: string[] = [];
const fail = (message: string): never => {
  console.error(`\n✗ ${message}`);
  for (const line of checks) console.error(`  ✓ ${line}`);
  process.exit(1);
};
const ok = (message: string): void => {
  checks.push(message);
  console.log(`  ✓ ${message}`);
};

const assert = (condition: unknown, message: string): void => {
  if (!condition) fail(message);
};

console.log(`[smoke] 后端：postgres，连接串：${url}`);

const serverStorage = await createServerStorage({ env: { ...process.env, TWIN_STORAGE: 'postgres', DATABASE_URL: url } });
assert(serverStorage.backend === 'postgres', `后端应为 postgres，实际 ${serverStorage.backend}`);
ok(`驱动解析成功：${String(serverStorage.detail.driver)}`);

const health = serverStorage.detail;
ok(`健康检查：healthy=${String(health.healthy)} version=${String(health.serverVersion)}`);
assert(health.healthy !== false, '探活失败：healthy=false');

const storage = serverStorage.storage;
const sceneId = 'smoke-scene';

// --- 场景写入 / 读取 -------------------------------------------------------
await storage.scenes.putScene({
  version: 1,
  id: sceneId,
  name: '冒烟场景',
  entities: [],
});
const scene = await storage.scenes.getScene(sceneId);
assert(scene?.name === '冒烟场景', `场景回读失败：${JSON.stringify(scene)}`);
ok('场景写入并回读成功');

assert((await storage.scenes.listScenes()).some((s) => s.id === sceneId), '场景列表里找不到刚写入的场景');
ok('场景列表包含新场景');

// --- 事件流 ---------------------------------------------------------------
await storage.events.append(sceneId, [
  { sequence: 1, occurredAt: 0, type: 'spawn', entityId: 'e1' },
  { sequence: 2, occurredAt: 1, type: 'move', entityId: 'e1' },
]);
const events = await storage.events.query(sceneId);
assert(events.length === 2, `事件应有 2 条，实际 ${events.length}`);
ok(`事件流追加并查询成功（${events.length} 条）`);

// --- 快照 -----------------------------------------------------------------
await storage.snapshots.put(sceneId, {
  sceneId,
  sequence: 1,
  time: 0,
  step: 1 / 60,
  seed: 42,
  rngState: 7,
  mode: 'sim',
  entities: [],
});
const latest = await storage.snapshots.latest(sceneId);
assert(latest?.sequence === 1, `快照回读失败：${JSON.stringify(latest)}`);
ok('快照写入并回读成功');

// --- 物化状态 -------------------------------------------------------------
await storage.state.upsert(sceneId, [
  {
    entityId: 'e1',
    kind: 'parcel',
    attrs: { weight: 1 },
    transform: { position: [0, 0, 0] },
    dataSource: 'sim',
    updatedSequence: 2,
    updatedAt: 1,
  },
]);
const states = await storage.state.list(sceneId);
assert(states.length === 1 && states[0]?.entityId === 'e1', `状态回读失败：${JSON.stringify(states)}`);
ok('物化状态 upsert 并查询成功');

// --- 指标 -----------------------------------------------------------------
await storage.metrics.put([
  { sceneId, metric: 'throughput', bucketStart: 0, bucketSize: 60, value: 3, count: 1 },
]);
assert((await storage.metrics.query(sceneId)).length === 1, '指标回读失败');
ok('指标写入并查询成功');

// --- 级联删除 -------------------------------------------------------------
assert((await removeScene(storage, sceneId)) === true, 'removeScene 应返回 true');
assert((await storage.scenes.getScene(sceneId)) === null, '删除后场景仍可读到');
assert((await storage.events.query(sceneId)).length === 0, '删除后事件未清理');
assert((await storage.snapshots.latest(sceneId)) === null, '删除后快照未清理');
assert((await storage.state.list(sceneId)).length === 0, '删除后状态未清理');
assert((await storage.metrics.query(sceneId)).length === 0, '删除后指标未清理');
ok('级联删除清理干净（场景/事件/快照/状态/指标）');

assert((await removeScene(storage, 'no-such-scene')) === false, '删除不存在的场景应返回 false');
ok('删除不存在的场景返回 false');

await serverStorage.close();
ok('连接释放');

console.log(`\n✓ Postgres 后端冒烟通过（${checks.length} 项）：${url}`);
