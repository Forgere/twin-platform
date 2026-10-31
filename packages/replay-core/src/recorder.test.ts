import { describe, expect, test } from 'bun:test';
import type { TwinScene } from '@twin-platform/scene-schema';
import { createMemoryStorage } from '@twin-platform/storage-memory';
import type { WorldBehavior } from '@twin-platform/world-kernel';
import { TwinWorld } from '@twin-platform/world-kernel';
import { SessionRecorder } from './recorder';

/**
 * 录制测试的重点是"录制不能改变世界"：同一个世界开着录制跑和不开录制跑，
 * 结果必须完全一致，否则录下来的就不是真相。
 */

const scene: TwinScene = {
  version: 1,
  id: 'replay-line',
  name: '回放测试产线',
  entities: [
    { id: 'belt-01', kind: 'transport', transform: { position: [0, 0, 0] }, capabilities: ['move'] },
    {
      id: 'cargo-01',
      kind: 'parcel',
      transform: { position: [0, 1, 0] },
      capabilities: ['move'],
      motion: { points: [[0, 1, 0], [9, 1, 0]], speed: 1.5, loop: 'repeat' },
    },
  ],
};

/** 每 30 步用注入的 rng 抛一个事件——用来检验事件流与 rng 状态一起被记录下来。 */
const emitter: WorldBehavior = {
  id: 'test:emit',
  step(ctx) {
    if (ctx.time <= 0) return;
    if (Math.round(ctx.time * 60) % 30 !== 0) return;
    ctx.emit('cargo:passed', { entityId: 'cargo-01', payload: { jitter: ctx.rng.next() } });
  },
};

const makeWorld = (): TwinWorld => new TwinWorld(scene, { seed: 20260907, behaviors: [emitter] });

describe('SessionRecorder', () => {
  test('落库事件、快照、状态投影与指标，且不改变世界推进', async () => {
    const storage = createMemoryStorage();
    const world = makeWorld();
    const recorder = new SessionRecorder(world, storage, {
      sessionId: 's-1',
      snapshotIntervalSteps: 60,
      now: () => '2026-09-07T00:00:00.000Z',
    });

    await recorder.start();
    for (let i = 0; i < 180; i += 1) await recorder.tick(world.step());
    await recorder.close();

    // 事件：每 30 步一条，180 步共 6 条
    const events = await storage.events.query('replay-line');
    expect(events).toHaveLength(6);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.every((event) => event.type === 'cargo:passed')).toBe(true);

    // 快照：初始 + 每 60 步 + close
    expect((await storage.snapshots.latest('replay-line'))?.time).toBeCloseTo(3, 6);

    // 投影：只记录变化过的实体，且是最新值
    const projected = await storage.state.get('replay-line', 'cargo-01');
    expect(projected).not.toBeNull();
    expect(projected?.kind).toBe('parcel');
    const bare = world.getEntity('cargo-01');
    expect(projected?.transform.position).toEqual(bare?.transform.position);
    expect(await storage.state.get('replay-line', 'belt-01')).toBeNull();

    // 指标：总数 + 分类
    const total = await storage.metrics.query('replay-line', { metric: 'event.count' });
    expect(total.reduce((sum, item) => sum + item.count, 0)).toBe(6);
    const typed = await storage.metrics.query('replay-line', { metric: 'event:cargo:passed' });
    expect(typed[0]?.entityId).toBe('cargo-01');

    // 会话结束写入时长
    expect((await storage.sessions.get('s-1'))?.duration).toBeCloseTo(3, 6);
  });

  test('录制与不录制跑出同一个世界', async () => {
    const storage = createMemoryStorage();
    const recorded = makeWorld();
    const recorder = new SessionRecorder(recorded, storage, { sessionId: 's-r', now: () => 'fixed' });
    await recorder.start();

    const bare = makeWorld();
    for (let i = 0; i < 120; i += 1) {
      const a = recorded.step();
      const b = bare.step();
      await recorder.tick(a);
      expect(b.time).toBeCloseTo(a.time, 12);
    }

    expect(bare.getEntity('cargo-01')?.transform.position).toEqual(recorded.getEntity('cargo-01')?.transform.position);
    expect(bare.getEventLog()).toHaveLength(recorded.getEventLog().length);
  });

  test('会话结束后再 tick 直接抛错，避免写出半截时间线', async () => {
    const storage = createMemoryStorage();
    const world = makeWorld();
    const recorder = new SessionRecorder(world, storage, { sessionId: 's-2', now: () => 'fixed' });
    await recorder.start();
    await recorder.close();

    await expect(recorder.tick()).rejects.toThrow(/已结束/);
  });

  test('会话 id 省略时带创建时间，重复录制不会互相覆盖', async () => {
    const storage = createMemoryStorage();
    const first = new SessionRecorder(makeWorld(), storage, { now: () => '2026-01-01T00:00:00.000Z' });
    const second = new SessionRecorder(makeWorld(), storage, { now: () => '2026-01-01T00:00:01.000Z' });
    await first.start();
    await second.start();

    expect(first.session.id).not.toBe(second.session.id);
    expect(await storage.sessions.list('replay-line')).toHaveLength(2);
    // 同内容的场景只登记一次：版本历史里不该出现"每次起仿真一行"的重复文档。
    expect(await storage.scenes.listVersions('replay-line')).toHaveLength(1);
  });

  test('场景内容变了才新增版本，录制器不替场景发布', async () => {
    const storage = createMemoryStorage();
    const world = makeWorld();
    await new SessionRecorder(world, storage, { sessionId: 's-a', now: () => 'fixed' }).start();

    const before = world.scene.entities[0]!.transform;
    world.applySceneOps([
      { type: 'setTransform', entityId: 'belt-01', before, after: { position: [1.5, 0, 0] } },
    ]);
    await new SessionRecorder(world, storage, { sessionId: 's-b', now: () => 'fixed' }).start();

    const versions = await storage.scenes.listVersions('replay-line');
    expect(versions.map((item) => item.version)).toEqual([1, 2]);
    expect((await storage.scenes.getVersion('replay-line', 2))?.entities[0]?.transform.position).toEqual([1.5, 0, 0]);
  });
});
