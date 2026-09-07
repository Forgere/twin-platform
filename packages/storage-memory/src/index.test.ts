import { describe, expect, test } from 'bun:test';
import { runStorageContractTests } from '@twin-platform/storage-testkit';
import type { WorldSnapshot } from '@twin-platform/world-kernel';
import { createMemoryStorage } from './index';

// 与 storage-postgres 跑同一套断言，保证换 Adapter 不需要改调用方。
runStorageContractTests('memory', () => {
  const storage = createMemoryStorage();
  return {
    storage,
    async reset() {
      storage.clear();
    },
  };
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

describe('createMemoryStorage / 内存实现自身的行为', () => {
  test('取出的快照是副本，改动不会写回仓储', async () => {
    const storage = createMemoryStorage();
    await storage.snapshots.put('line-a', snapshot(10));

    const loaded = await storage.snapshots.latest('line-a');
    loaded?.entities.push({ id: 'x', kind: 'y', transform: { position: [0, 0, 0] }, attrs: {}, dataSource: 'sim' });

    expect((await storage.snapshots.latest('line-a'))?.entities).toHaveLength(0);
  });

  test('结束不存在的会话直接抛错，避免静默丢数据', async () => {
    const storage = createMemoryStorage();
    await expect(storage.sessions.finish('missing', 1)).rejects.toThrow(/不存在/);
  });

  test('指标写入空数组返回 0', async () => {
    const storage = createMemoryStorage();
    expect(await storage.metrics.put([])).toBe(0);
  });
});
