import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractScene, runStorageContractTests } from '@twin-platform/storage-testkit';
import type { WorldSnapshot } from '@twin-platform/world-kernel';
import { createFileStorage } from './index';

/**
 * 与 memory / postgres 跑同一套契约断言——换 Adapter 不该改调用方，
 * 这条由共享测试保证，而不是靠人记得补。
 */
runStorageContractTests('file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twin-file-'));
  const storage = createFileStorage({ path: join(dir, 'twin.json'), autoFlush: false });
  await storage.ready();
  return {
    storage,
    async reset() {
      await storage.clear();
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

/** 每个用例一个独立临时目录，避免互相污染。 */
async function withStorage(fn: (storage: ReturnType<typeof createFileStorage>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'twin-file-x-'));
  const storage = createFileStorage({ path: join(dir, 'twin.json'), autoFlush: false });
  await storage.ready();
  try {
    await fn(storage);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('createFileStorage / 文件实现自身的行为', () => {
  test('flush 之后重开进程还能读回场景（持久化的全部意义）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'twin-file-p-'));
    const path = join(dir, 'twin.json');
    try {
      const first = createFileStorage({ path, autoFlush: false });
      await first.ready();
      await first.scenes.putScene(contractScene);
      await first.snapshots.put('contract-scene', snapshot(7));
      await first.flush();

      // 模拟进程重启：新实例读同一个文件。
      const second = createFileStorage({ path, autoFlush: false });
      await second.ready();
      expect((await second.scenes.getScene('contract-scene'))?.name).toBe('契约测试场景');
      expect((await second.snapshots.latest('contract-scene'))?.sequence).toBe(7);
      expect(await second.scenes.listScenes()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('没 flush 就重开，窗口内的改动会丢（这是设计，不是 bug）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'twin-file-l-'));
    const path = join(dir, 'twin.json');
    try {
      const first = createFileStorage({ path, autoFlush: false });
      await first.ready();
      await first.scenes.putScene(contractScene);
      // 故意不 flush。

      const second = createFileStorage({ path, autoFlush: false });
      await second.ready();
      expect(await second.scenes.getScene('contract-scene')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('自动 flush：等过一个窗口后数据落到磁盘', async () => {
    await withStorage(async (storage) => {
      // autoFlush 在 withStorage 里关掉了，这里单独开一个验证时间窗生效。
      expect(storage.path.endsWith('twin.json')).toBe(true);
    });

    const dir = await mkdtemp(join(tmpdir(), 'twin-file-a-'));
    const path = join(dir, 'twin.json');
    try {
      const storage = createFileStorage({ path, flushMs: 20 });
      await storage.ready();
      await storage.scenes.putScene(contractScene);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const text = await readFile(path, 'utf8');
      expect(text).toContain('contract-scene');
      await storage.flush();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('数据文件不存在时正常启动为空库，不抛错', async () => {
    await withStorage(async (storage) => {
      expect(await storage.scenes.listScenes()).toEqual([]);
      expect(await storage.events.latestSequence('nope')).toBe(0);
    });
  });

  test('落盘内容是合法 JSON 且带版本号', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'twin-file-j-'));
    const path = join(dir, 'twin.json');
    try {
      const storage = createFileStorage({ path, autoFlush: false });
      await storage.ready();
      await storage.scenes.putScene(contractScene);
      await storage.flush();

      const parsed = JSON.parse(await readFile(path, 'utf8')) as {
        version: number;
        scenes: unknown;
        sceneHistory: Record<string, { version: number; kind: string }[]>;
      };
      expect(parsed.version).toBe(2);
      expect(Object.keys(parsed.scenes)).toEqual(['contract-scene']);
      expect(parsed.sceneHistory['contract-scene']).toEqual([{ version: 1, kind: 'snapshot', scene: contractScene, createdAt: expect.any(String) }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('读取 v1 文件时给每份现有场景补一条 v1 快照', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'twin-file-m-'));
    const path = join(dir, 'twin.json');
    try {
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          scenes: { 'contract-scene': { scene: contractScene, updatedAt: '2026-10-01T00:00:00.000Z' } },
        }),
        'utf8',
      );
      const storage = createFileStorage({ path, autoFlush: false });
      await storage.ready();

      expect((await storage.scenes.listVersions('contract-scene')).map((item) => item.version)).toEqual([1]);
      expect((await storage.scenes.listScenes())[0]?.version).toBe(1);
      expect((await storage.scenes.getVersion('contract-scene', 1))?.name).toBe(contractScene.name);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('删除场景会连带清掉它的事件、快照、状态与指标', async () => {
    await withStorage(async (storage) => {
      const scene = contractScene;
      await storage.scenes.putScene(scene);
      await storage.snapshots.put(scene.id, snapshot(1));
      await storage.state.upsert(scene.id, [
        { entityId: 'belt-01', kind: 'transport', attrs: {}, transform: { position: [0, 0, 0] }, dataSource: 'sim', updatedSequence: 1, updatedAt: 0 },
      ]);
      await storage.metrics.put([{ sceneId: scene.id, metric: 'tick', bucketStart: 0, bucketSize: 1, value: 1, count: 1 }]);

      // remove 是文件实现额外提供的（服务端 DELETE 用），契约里没有。
      const removed = await (storage.scenes as unknown as { remove(id: string): Promise<boolean> }).remove(scene.id);
      expect(removed).toBe(true);
      expect(await storage.scenes.getScene(scene.id)).toBeNull();
      expect(await storage.snapshots.latest(scene.id)).toBeNull();
      expect(await storage.state.list(scene.id)).toEqual([]);
      expect(await storage.metrics.query(scene.id)).toEqual([]);
      expect(await (storage.scenes as unknown as { remove(id: string): Promise<boolean> }).remove(scene.id)).toBe(false);
    });
  });

  test('reload 能捡回外部对文件的改动', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'twin-file-r-'));
    const path = join(dir, 'twin.json');
    try {
      const writer = createFileStorage({ path, autoFlush: false });
      await writer.ready();
      await writer.scenes.putScene(contractScene);
      await writer.flush();

      // reader 先启动，此时只有一个场景。
      const reader = createFileStorage({ path, autoFlush: false });
      await reader.ready();
      expect(await reader.scenes.listScenes()).toHaveLength(1);

      // 外部（这里是另一个实例）又写了一个场景进去。
      await writer.scenes.putScene({ ...contractScene, id: 'scene-2', name: '后加的' });
      await writer.flush();

      // 不 reload 的话 reader 还是旧视图；reload 之后才看得到。
      expect(await reader.scenes.listScenes()).toHaveLength(1);
      await reader.reload();
      expect(await reader.scenes.listScenes()).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // 临时目录已在各用例里清理，这里留作将来统一收尾的钩子。
  });
});
