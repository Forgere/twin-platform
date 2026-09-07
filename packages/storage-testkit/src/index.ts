import { describe, expect, test } from 'bun:test';
import type { TwinScene } from '@twin-platform/scene-schema';
import type { WorldEvent, WorldSnapshot } from '@twin-platform/world-kernel';
import type { EntityStateRecord, MetricRollup, ReplaySession, TwinStorage } from '@twin-platform/storage-contracts';

/**
 * 共享仓储契约测试。
 *
 * `storage-memory` 和 `storage-postgres` 跑同一套断言：新增一个 Adapter 时只要
 * 实现接口并调用本函数，就能证明它和内存实现行为一致。
 *
 * 独立成一个包而不是塞进 `storage-contracts`，是因为它依赖 `bun:test`：
 * 仓库没装 `bun-types`，测试文件一律不参与类型检查，把它放进运行时包会让
 * `typecheck` 要么失败、要么得为测试留一堆排除规则。
 */

export interface StorageTestHarness {
  storage: TwinStorage;
  /** 每个用例开始前清空全部数据。 */
  reset(): Promise<void>;
}

export const contractScene: TwinScene = {
  version: 1,
  id: 'contract-scene',
  name: '契约测试场景',
  entities: [
    { id: 'belt-01', kind: 'transport', transform: { position: [0, 0, 0] }, capabilities: ['move'] },
  ],
};

function makeEvent(sequence: number, patch: Partial<WorldEvent> = {}): WorldEvent {
  return { sequence, occurredAt: sequence * 0.5, type: 'contract:tick', entityId: 'belt-01', ...patch };
}

function makeSnapshot(sequence: number, time: number): WorldSnapshot {
  return {
    sceneId: contractScene.id,
    sequence,
    time,
    step: 1 / 60,
    seed: 7,
    rngState: sequence,
    mode: 'sim',
    entities: [
      {
        id: 'belt-01',
        kind: 'transport',
        transform: { position: [time, 0, 0] },
        attrs: { speed: 1 },
        dataSource: 'sim',
        motionDistance: time,
      },
    ],
  };
}

function makeSession(id: string, patch: Partial<ReplaySession> = {}): ReplaySession {
  return {
    id,
    sceneId: contractScene.id,
    sceneVersion: contractScene.version,
    seed: 7,
    step: 1 / 60,
    mode: 'sim',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

/**
 * @param name 套件名（写实现名，失败时一眼看出是哪个 Adapter）。
 * @param create 返回待测试的实现；每个用例都会重新创建并 `reset()`。
 */
export function runStorageContractTests(name: string, create: () => StorageTestHarness | Promise<StorageTestHarness>): void {
  describe(`仓储契约 / ${name}`, () => {
    test('场景可写入、读回、列出，且读到的是副本', async () => {
      const { storage } = await create();
      await storage.scenes.putScene(contractScene);

      const loaded = await storage.scenes.getScene(contractScene.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.name).toBe('契约测试场景');

      loaded?.entities.push({ id: 'mutated', kind: 'unknown', transform: { position: [0, 0, 0] }, capabilities: [] });
      expect((await storage.scenes.getScene(contractScene.id))?.entities).toHaveLength(1);

      const summaries = await storage.scenes.listScenes();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.id).toBe(contractScene.id);
      expect(await storage.scenes.getScene('missing')).toBeNull();
    });

    test('事件按 sequence 严格单调写入，重复回放会报错', async () => {
      const { storage } = await create();
      expect(await storage.events.append(contractScene.id, [makeEvent(1), makeEvent(2)])).toBe(2);
      await expect(storage.events.append(contractScene.id, [makeEvent(2)])).rejects.toThrow();
      await expect(storage.events.append(contractScene.id, [makeEvent(1)])).rejects.toThrow();
      expect(await storage.events.latestSequence(contractScene.id)).toBe(2);
      expect(await storage.events.latestSequence('missing-scene')).toBe(0);
    });

    test('事件可按 sequence / 类型 / 实体过滤', async () => {
      const { storage } = await create();
      await storage.events.append(contractScene.id, [
        makeEvent(1),
        makeEvent(2, { type: 'custom', entityId: 'other' }),
        makeEvent(3, { type: 'custom' }),
      ]);

      expect(await storage.events.query(contractScene.id)).toHaveLength(3);
      expect(await storage.events.query(contractScene.id, { sinceSequence: 1 })).toHaveLength(2);
      expect(await storage.events.query(contractScene.id, { untilSequence: 2 })).toHaveLength(2);
      expect(await storage.events.query(contractScene.id, { type: 'custom' })).toHaveLength(2);
      expect(await storage.events.query(contractScene.id, { entityId: 'other' })).toHaveLength(1);
      expect(await storage.events.query(contractScene.id, { limit: 2 })).toHaveLength(2);
      expect(await storage.events.query('missing-scene')).toEqual([]);
    });

    test('分叉时截断事件，旧时间线的未来事件被丢弃', async () => {
      const { storage } = await create();
      await storage.events.append(contractScene.id, [makeEvent(1), makeEvent(2), makeEvent(3)]);

      expect(await storage.events.truncateAfter(contractScene.id, 2)).toBe(1);
      expect(await storage.events.latestSequence(contractScene.id)).toBe(2);
      expect(await storage.events.query(contractScene.id)).toHaveLength(2);
      expect(await storage.events.truncateAfter(contractScene.id, 0)).toBe(2);
      expect(await storage.events.truncateAfter('missing-scene', 0)).toBe(0);
    });

    test('快照可取最新、按 sequence 与按时间回溯', async () => {
      const { storage } = await create();
      await storage.snapshots.put(contractScene.id, makeSnapshot(1, 10));
      await storage.snapshots.put(contractScene.id, makeSnapshot(5, 30));
      await storage.snapshots.put(contractScene.id, makeSnapshot(9, 60));

      expect((await storage.snapshots.latest(contractScene.id))?.sequence).toBe(9);
      expect((await storage.snapshots.atOrBefore(contractScene.id, 6))?.sequence).toBe(5);
      expect((await storage.snapshots.atOrBefore(contractScene.id, 1))?.sequence).toBe(1);
      expect(await storage.snapshots.atOrBefore(contractScene.id, 0)).toBeNull();
      expect((await storage.snapshots.atOrBeforeTime(contractScene.id, 45))?.time).toBe(30);
      expect((await storage.snapshots.atOrBeforeTime(contractScene.id, 10))?.time).toBe(10);
      expect(await storage.snapshots.atOrBeforeTime(contractScene.id, 1)).toBeNull();
      expect(await storage.snapshots.latest('missing-scene')).toBeNull();
    });

    test('会话可写入、列出、结束并记住时长', async () => {
      const { storage } = await create();
      await storage.sessions.put(makeSession('s-1', { label: '基线' }));
      await storage.sessions.put(makeSession('s-2'));

      expect((await storage.sessions.get('s-1'))?.label).toBe('基线');
      expect(await storage.sessions.list(contractScene.id)).toHaveLength(2);
      expect(await storage.sessions.list('missing-scene')).toEqual([]);

      await storage.sessions.finish('s-1', 42.5);
      expect((await storage.sessions.get('s-1'))?.duration).toBe(42.5);
      expect((await storage.sessions.get('s-2'))?.duration).toBeUndefined();
      expect(await storage.sessions.get('missing')).toBeNull();
    });

    test('最新状态投影按实体 upsert，后写覆盖先写', async () => {
      const { storage } = await create();
      const base: EntityStateRecord = {
        entityId: 'belt-01',
        kind: 'transport',
        attrs: { speed: 1 },
        transform: { position: [0, 0, 0] },
        dataSource: 'sim',
        updatedSequence: 1,
        updatedAt: 0,
      };
      expect(await storage.state.upsert(contractScene.id, [base])).toBe(1);
      await storage.state.upsert(contractScene.id, [
        { ...base, status: 'running', attrs: { speed: 2 }, transform: { position: [1, 0, 0] }, updatedSequence: 5, updatedAt: 2 },
        { ...base, entityId: 'belt-02', updatedSequence: 5, updatedAt: 2 },
      ]);

      const latest = await storage.state.get(contractScene.id, 'belt-01');
      expect(latest?.status).toBe('running');
      expect(latest?.attrs.speed).toBe(2);
      expect(latest?.transform.position).toEqual([1, 0, 0]);
      expect(await storage.state.list(contractScene.id)).toHaveLength(2);
      expect(await storage.state.get(contractScene.id, 'missing')).toBeNull();
      expect(await storage.state.list('missing-scene')).toEqual([]);
    });

    test('指标按桶累加，同桶重复写入会相加', async () => {
      const { storage } = await create();
      const rollup = (patch: Partial<MetricRollup> = {}): MetricRollup => ({
        sceneId: contractScene.id,
        metric: 'event.count',
        bucketStart: 0,
        bucketSize: 60,
        value: 1,
        count: 1,
        ...patch,
      });

      await storage.metrics.put([rollup()]);
      await storage.metrics.put([rollup(), rollup({ bucketStart: 60 })]);
      expect(await storage.metrics.put([rollup({ entityId: 'belt-01' })])).toBe(1);

      const all = await storage.metrics.query(contractScene.id);
      expect(all).toHaveLength(3);
      expect(all.find((item) => item.bucketStart === 0 && item.entityId === undefined)?.count).toBe(2);
      expect(await storage.metrics.query(contractScene.id, { metric: 'nope' })).toEqual([]);
      expect(await storage.metrics.query(contractScene.id, { fromBucket: 60 })).toHaveLength(1);
      expect(await storage.metrics.query(contractScene.id, { entityId: 'belt-01' })).toHaveLength(1);
      expect(await storage.metrics.query('missing-scene')).toEqual([]);
    });

    test('reset 之后所有仓储都回到空状态', async () => {
      const harness = await create();
      const { storage } = harness;
      await storage.scenes.putScene(contractScene);
      await storage.events.append(contractScene.id, [makeEvent(1)]);
      await storage.snapshots.put(contractScene.id, makeSnapshot(1, 1));
      await storage.sessions.put(makeSession('s-1'));
      await storage.state.upsert(contractScene.id, [
        { entityId: 'belt-01', kind: 'transport', attrs: {}, transform: { position: [0, 0, 0] }, dataSource: 'sim', updatedSequence: 1, updatedAt: 0 },
      ]);
      await storage.metrics.put([
        { sceneId: contractScene.id, metric: 'event.count', bucketStart: 0, bucketSize: 60, value: 1, count: 1 },
      ]);

      await harness.reset();

      expect(await storage.scenes.listScenes()).toEqual([]);
      expect(await storage.events.latestSequence(contractScene.id)).toBe(0);
      expect(await storage.snapshots.latest(contractScene.id)).toBeNull();
      expect(await storage.sessions.list(contractScene.id)).toEqual([]);
      expect(await storage.state.list(contractScene.id)).toEqual([]);
      expect(await storage.metrics.query(contractScene.id)).toEqual([]);
    });
  });
}
