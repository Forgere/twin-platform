import { describe, expect, test } from 'bun:test';
import type { TwinScene } from '@twin-platform/scene-schema';
import { TwinWorld, type WorldBehavior } from '@twin-platform/world-kernel';
import { createMemoryStorage } from '@twin-platform/storage-memory';
import { ReplayController, eventFingerprint, worldFingerprint, type ExternalFrameSource } from './index';

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

const emitter: WorldBehavior = {
  id: 'test:emit',
  step(ctx) {
    if (Math.round(ctx.time * 60) % 30 !== 0) return;
    ctx.emit('cargo:passed', { entityId: 'cargo-01', payload: { jitter: ctx.rng.next() } });
  },
};

const makeWorld = (): TwinWorld => new TwinWorld(scene, { seed: 20260907, behaviors: [emitter], maxStepsPerAdvance: 600 });

/** 确定性外部帧源：按时间升序喂世界位姿，可 rewind 重放。 */
class FakePoseSource implements ExternalFrameSource {
  private cursor = 0;

  constructor(private readonly frames: readonly { t: number; id: string; position: [number, number, number] }[]) {}

  get duration(): number {
    return this.frames[this.frames.length - 1]?.t ?? 0;
  }

  feedTo(world: TwinWorld, time: number): void {
    while (this.cursor < this.frames.length && (this.frames[this.cursor] as { t: number }).t <= time) {
      const frame = this.frames[this.cursor] as { t: number; id: string; position: [number, number, number] };
      this.cursor += 1;
      world.ingestExternalFrame({
        sourceTime: frame.t,
        entities: [{ id: frame.id, signal: { kind: 'pose', frame: 'world', position: frame.position } }],
      });
    }
  }

  rewind(): void {
    this.cursor = 0;
  }
}

const STEP = 1 / 60;

describe('ReplayController / 倍速不改变结果', () => {
  test('1× 与 10× 跑到同一时刻，世界与事件指纹一致', () => {
    const slow = new ReplayController({ world: makeWorld(), storage: createMemoryStorage() });
    const fast = new ReplayController({ world: makeWorld(), storage: createMemoryStorage() });

    slow.play(1);
    fast.play(10);

    for (let i = 0; i < 300; i += 1) slow.advance(STEP);
    for (let i = 0; i < 30; i += 1) fast.advance(STEP);

    expect(slow.world.stepCount).toBe(300);
    expect(fast.world.stepCount).toBe(300);
    expect(worldFingerprint(fast.world)).toBe(worldFingerprint(slow.world));
    expect(eventFingerprint(fast.world.getEventLog())).toBe(eventFingerprint(slow.world.getEventLog()));
  });

  test('帧率抖动（30Hz/144Hz/掉帧）不影响结果', () => {
    const steady = new ReplayController({ world: makeWorld(), storage: createMemoryStorage() });
    const jittery = new ReplayController({ world: makeWorld(), storage: createMemoryStorage() });
    steady.play(1);
    jittery.play(1);

    const pattern = [1 / 30, 1 / 144, 0.25, 1 / 60, 0.5];
    let cursor = 0;
    while (jittery.world.stepCount < 300) {
      jittery.advance(pattern[cursor % pattern.length] as number);
      cursor += 1;
    }
    // 一帧可能补好几步，最终步数会略微超过；把稳定的那个补到同一时刻再比
    while (steady.world.stepCount < jittery.world.stepCount) steady.advance(STEP);

    expect(jittery.world.stepCount).toBeGreaterThan(300);
    expect(worldFingerprint(jittery.world)).toBe(worldFingerprint(steady.world));
  });

  test('暂停后 advance 不推进世界', () => {
    const controller = new ReplayController({ world: makeWorld(), storage: createMemoryStorage() });
    controller.play(1);
    controller.advance(STEP);
    controller.pause();
    const before = controller.world.stepCount;
    controller.advance(STEP);
    controller.advance(STEP);
    expect(controller.world.stepCount).toBe(before);
    expect(controller.playing).toBe(false);
  });
});

describe('ReplayController / 定位靠重算', () => {
  test('回跳到过去再跳回来，结果与一路播放一致', async () => {
    const storage = createMemoryStorage();
    const world = makeWorld();
    const controller = new ReplayController({ world, storage });
    await storage.snapshots.put('replay-line', world.snapshot());

    controller.play(1);
    for (let i = 0; i < 300; i += 1) controller.advance(STEP);
    const atFive = worldFingerprint(world);
    const eventsAtFive = eventFingerprint(world.getEventLog());

    await controller.seek(2);
    expect(world.time).toBeCloseTo(2, 9);
    const atTwo = worldFingerprint(world);

    await controller.seek(5);
    expect(worldFingerprint(world)).toBe(atFive);
    expect(eventFingerprint(world.getEventLog())).toBe(eventsAtFive);

    await controller.seek(2);
    expect(worldFingerprint(world)).toBe(atTwo);
  });

  test('没有快照时从头重算，结果依然一致', async () => {
    const storage = createMemoryStorage();
    const world = makeWorld();
    const controller = new ReplayController({ world, storage });

    controller.play(1);
    for (let i = 0; i < 120; i += 1) controller.advance(STEP);
    const atTwo = worldFingerprint(world);

    await controller.seek(1);
    await controller.seek(2);
    expect(worldFingerprint(world)).toBe(atTwo);
  });

  test('定位跨度超过上限直接报错，不把主线程拖死', async () => {
    const controller = new ReplayController({ world: makeWorld(), storage: createMemoryStorage(), maxSeekSteps: 10 });
    await expect(controller.seek(100)).rejects.toThrow(/跨度过大/);
  });

  test('回跳即分叉：之后的事件被截断，新时间线编号连续', async () => {
    const storage = createMemoryStorage();
    const world = makeWorld();
    const controller = new ReplayController({
      world,
      storage,
      onFrame: (frame) => {
        void storage.events.append('replay-line', world.drainEvents().map((event) => ({ ...event })));
      },
    });
    await storage.snapshots.put('replay-line', world.snapshot());

    controller.play(1);
    for (let i = 0; i < 120; i += 1) controller.advance(STEP);
    await controller.snapshot(); // t=2 处留下一条分叉基线
    for (let i = 0; i < 180; i += 1) controller.advance(STEP);
    expect(await storage.events.latestSequence('replay-line')).toBe(10);

    await controller.seek(2);
    expect(world.time).toBeCloseTo(2, 9);
    expect(await storage.events.latestSequence('replay-line')).toBe(4);

    for (let i = 0; i < 180; i += 1) controller.advance(STEP);
    const events = await storage.events.query('replay-line');
    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences[0]).toBe(1);
  });
});

describe('ReplayController / 外部数据源回放', () => {
  test('外部模式下 seek 前后，同一时刻的世界一致', async () => {
    const storage = createMemoryStorage();
    const frames = Array.from({ length: 20 }, (_, index) => ({
      t: (index + 1) * 0.1,
      id: 'cargo-01',
      position: [index * 0.4, 1, 0] as [number, number, number],
    }));
    const world = new TwinWorld(scene, { seed: 1, mode: 'external', maxStepsPerAdvance: 600 });
    const controller = new ReplayController({ world, storage, source: new FakePoseSource(frames) });
    await storage.snapshots.put('replay-line', world.snapshot());

    controller.play(1);
    for (let i = 0; i < 120; i += 1) controller.advance(STEP);
    const atTwo = worldFingerprint(world);
    expect(world.getEntity('cargo-01')?.dataSource).toBe('external');

    await controller.seek(1);
    await controller.seek(2);
    expect(worldFingerprint(world)).toBe(atTwo);
  });

  test('时间轴长度取会话时长、数据源时长与当前时间的最大值', async () => {
    const storage = createMemoryStorage();
    const world = makeWorld();
    const controller = new ReplayController({ world, storage, source: new FakePoseSource([{ t: 5, id: 'x', position: [0, 0, 0] }]) });
    await storage.sessions.put({
      id: 's',
      sceneId: 'replay-line',
      sceneVersion: 1,
      seed: 1,
      step: STEP,
      mode: 'sim',
      createdAt: '2026-01-01T00:00:00.000Z',
      duration: 12,
    });

    await controller.load();
    expect(controller.duration).toBe(12);

    controller.play(1);
    for (let i = 0; i < 60 * 20; i += 1) controller.advance(STEP);
    expect(controller.duration).toBeCloseTo(20, 6);
  });
});

describe('ReplayController / 暂停时的状态改动也要出帧', () => {
  test('暂停（含 idle）时 advance 不推进世界，但把 pending 的改动刷成帧并通知 onFrame', () => {
    const frames: { changed: { id: string }[] }[] = [];
    const controller = new ReplayController({
      world: makeWorld(),
      storage: createMemoryStorage(),
      onFrame: (frame) => frames.push(frame),
    });

    controller.world.setTransform('belt-01', { position: [2, 0, 0] }); // 布局编辑走的就是这条路
    const frame = controller.advance(STEP);

    expect(frame.changed.map((change) => change.id)).toContain('belt-01');
    expect(controller.world.stepCount).toBe(0); // 没推进
    expect(frames.at(-1)?.changed.map((change) => change.id)).toContain('belt-01'); // 录制器也收到了

    // 改动刷出去之后，下一帧就干净了（dirty 不会攒着重复上报）
    expect(controller.advance(STEP).changed).toEqual([]);
  });
});
