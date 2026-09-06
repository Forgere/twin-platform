import { describe, expect, test } from 'bun:test';
import type { TwinScene } from '@twin-platform/scene-schema';
import type { WorldEvent, WorldSnapshot } from '@twin-platform/world-kernel';
import { createMemoryStorage } from './index';

const scene: TwinScene = {
  version: 1,
  id: 'line-a',
  name: '产线 A',
  entities: [{ id: 'belt-01', kind: 'transport', transform: { position: [0, 0.8, 0] }, capabilities: ['move'] }],
};

const event = (sequence: number, type = 'item:spawned', entityId = 'belt-01'): WorldEvent => ({
  sequence,
  occurredAt: sequence * 0.1,
  type,
  entityId,
});

const snapshot = (sequence: number): WorldSnapshot => ({
  sceneId: 'line-a',
  sequence,
  time: sequence * 0.1,
  step: 1 / 60,
  seed: 1,
  rngState: 12345,
  mode: 'sim',
  entities: [],
});

describe('createMemoryStorage', () => {
  test('场景可写入、读回、列出，且读到的是副本', async () => {
    const storage = createMemoryStorage();
    await storage.scenes.putScene(scene);

    const loaded = await storage.scenes.getScene('line-a');
    expect(loaded?.name).toBe('产线 A');

    loaded?.entities.push({ id: 'x', kind: 'y', transform: { position: [0, 0, 0] }, capabilities: [] });
    expect((await storage.scenes.getScene('line-a'))?.entities).toHaveLength(1);

    const summaries = await storage.scenes.listScenes();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: 'line-a', name: '产线 A', version: 1 });
    expect(await storage.scenes.getScene('missing')).toBeNull();
  });

  test('事件按 sequence 严格单调写入，重复回放会报错', async () => {
    const storage = createMemoryStorage();
    expect(await storage.events.append('line-a', [event(1), event(2), event(3)])).toBe(3);
    expect(await storage.events.latestSequence('line-a')).toBe(3);
    await expect(storage.events.append('line-a', [event(3)])).rejects.toThrow(/严格单调/);
    await expect(storage.events.append('line-a', [event(2)])).rejects.toThrow(/严格单调/);
    expect(await storage.events.append('line-a', [])).toBe(0);
  });

  test('事件可按 sequence / 类型 / 实体过滤', async () => {
    const storage = createMemoryStorage();
    await storage.events.append('line-a', [
      event(1, 'item:spawned', 'belt-01'),
      event(2, 'item:inspected', 'qc-01'),
      event(3, 'item:spawned', 'belt-01'),
    ]);

    expect(await storage.events.query('line-a', { sinceSequence: 1 })).toHaveLength(2);
    expect(await storage.events.query('line-a', { type: 'item:spawned' })).toHaveLength(2);
    expect(await storage.events.query('line-a', { entityId: 'qc-01' })).toHaveLength(1);
    expect(await storage.events.query('line-a', { sinceSequence: 1, limit: 1 })).toHaveLength(1);
    expect(await storage.events.query('other')).toEqual([]);
  });

  test('快照可取最新，也可取不晚于指定 sequence 的那一份', async () => {
    const storage = createMemoryStorage();
    await storage.snapshots.put('line-a', snapshot(10));
    await storage.snapshots.put('line-a', snapshot(50));
    await storage.snapshots.put('line-a', snapshot(90));

    expect((await storage.snapshots.latest('line-a'))?.sequence).toBe(90);
    expect((await storage.snapshots.atOrBefore('line-a', 60))?.sequence).toBe(50);
    expect((await storage.snapshots.atOrBefore('line-a', 90))?.sequence).toBe(90);
    expect(await storage.snapshots.atOrBefore('line-a', 9)).toBeNull();
  });

  test('clear 清空全部数据', async () => {
    const storage = createMemoryStorage();
    await storage.scenes.putScene(scene);
    await storage.events.append('line-a', [event(1)]);
    await storage.snapshots.put('line-a', snapshot(1));
    storage.clear();

    expect(await storage.scenes.getScene('line-a')).toBeNull();
    expect(await storage.events.latestSequence('line-a')).toBe(0);
    expect(await storage.snapshots.latest('line-a')).toBeNull();
  });
});
