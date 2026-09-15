import { describe, expect, test } from 'bun:test';
import type { TwinScene } from '@twin-platform/scene-schema';
import type { WorldBehavior } from './behaviors';
import { TwinWorld } from './world';

const makeScene = (): TwinScene => ({
  version: 1,
  id: 'line-a',
  name: '产线 A',
  entities: [
    {
      id: 'belt-01',
      kind: 'transport',
      transform: { position: [0, 0.8, 0] },
      capabilities: ['move'],
      motion: { points: [[0, 0.8, 0], [8, 0.8, 0]], speed: 1.2 },
    },
    {
      id: 'qc-01',
      kind: 'inspect',
      transform: { position: [8, 0.8, 0] },
      capabilities: ['inspect'],
      attrs: { quality: 'unknown' },
    },
  ],
});

/** 只用注入的 rng 写属性：只要它可复现，整条链路就都是确定性的。 */
const stampBehavior: WorldBehavior = {
  id: 'test:stamp',
  step(ctx) {
    for (const entity of ctx.entities) {
      if (ctx.rng.bool(0.2)) ctx.setAttr(entity.id, 'mark', ctx.rng.int(1000));
    }
  },
};

const fingerprint = (world: TwinWorld): string =>
  JSON.stringify({
    time: world.time,
    entities: world.listEntities().map((entity) => ({
      id: entity.id,
      position: entity.transform.position.map((value) => Math.round(value * 1e6)),
      attrs: entity.attrs,
      status: entity.status ?? null,
    })),
    events: world.getEventLog().map((event) => [event.sequence, event.type, event.occurredAt, event.entityId ?? null]),
  });

const run = (world: TwinWorld, steps: number, dt = 1 / 60): void => {
  for (let i = 0; i < steps; i += 1) world.step(dt);
};

describe('TwinWorld / 确定性', () => {
  test('同种子同输入得到逐位一致的结果', () => {
    const a = new TwinWorld(makeScene(), { seed: 42, behaviors: [stampBehavior] });
    const b = new TwinWorld(makeScene(), { seed: 42, behaviors: [stampBehavior] });
    run(a, 600);
    run(b, 600);
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  test('不同种子会分叉（证明随机真的来自注入的 rng）', () => {
    const a = new TwinWorld(makeScene(), { seed: 42, behaviors: [stampBehavior] });
    const b = new TwinWorld(makeScene(), { seed: 7, behaviors: [stampBehavior] });
    run(a, 600);
    run(b, 600);
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  test('reset() 重放同一集', () => {
    const world = new TwinWorld(makeScene(), { seed: 42, behaviors: [stampBehavior] });
    run(world, 300);
    const first = fingerprint(world);
    world.reset();
    expect(world.time).toBe(0);
    expect(world.getEventLog()).toHaveLength(0);
    run(world, 300);
    expect(fingerprint(world)).toBe(first);
  });

  test('reset(seed) 换成另一集但依然可复现', () => {
    const world = new TwinWorld(makeScene(), { seed: 42, behaviors: [stampBehavior] });
    run(world, 300);
    const first = fingerprint(world);
    world.reset(99);
    run(world, 300);
    expect(fingerprint(world)).not.toBe(first);
  });

  test('渲染帧率抖动不改变仿真结果（固定步长）', () => {
    const scene = makeScene();
    const steady = new TwinWorld(scene, { seed: 5, step: 0.1, behaviors: [stampBehavior] });
    const jittery = new TwinWorld(scene, { seed: 5, step: 0.1, behaviors: [stampBehavior] });

    // 稳定 60Hz：10 次 0.1s
    for (let i = 0; i < 10; i += 1) steady.advance(0.1);
    // 抖动：帧间隔忽长忽短，但总和同样是 1.0s
    for (const delta of [0.21, 0.05, 0.14, 0.33, 0.02, 0.15, 0.09, 0.01]) jittery.advance(delta);

    expect(jittery.stepCount).toBe(steady.stepCount);
    expect(jittery.time).toBeCloseTo(steady.time, 9);
    expect(fingerprint(jittery)).toBe(fingerprint(steady));
  });
});

describe('TwinWorld / 仿真运动', () => {
  test('按 speed × dt 沿路径前进', () => {
    const world = new TwinWorld(makeScene());
    run(world, 60, 1 / 60);
    expect(world.getEntity('belt-01')?.transform.position[0]).toBeCloseTo(1.2, 6);
    expect(world.getEntity('belt-01')?.transform.rotation?.[1]).toBeCloseTo(Math.PI / 2, 6);
  });

  test('clamp 模式停在终点', () => {
    const world = new TwinWorld(makeScene());
    run(world, 600, 1 / 60);
    expect(world.getEntity('belt-01')?.transform.position[0]).toBeCloseTo(8, 6);
  });

  test('repeat 模式回到起点', () => {
    const scene = makeScene();
    const belt = scene.entities[0];
    if (belt?.motion) belt.motion = { ...belt.motion, loop: 'repeat' };
    const world = new TwinWorld(scene);
    run(world, 600, 1 / 60);
    expect(world.getEntity('belt-01')?.transform.position[0]).toBeCloseTo(4, 1);
  });

  test('帧差量只带变化的部分', () => {
    const world = new TwinWorld(makeScene());
    const frame = world.step(1 / 60);
    expect(frame.added).toEqual([]);
    expect(frame.removed).toEqual([]);
    expect(frame.changed.map((delta) => delta.id)).toEqual(['belt-01']);
  });
});

describe('TwinWorld / 外部数据与 hybrid', () => {
  const external = (): TwinWorld => {
    const world = new TwinWorld(makeScene(), { seed: 3 });
    world.setMode('external');
    return world;
  };

  test('external 模式下 pose 信号直接决定位姿', () => {
    const world = external();
    world.ingestExternalFrame({
      entities: [{ id: 'belt-01', signal: { kind: 'pose', frame: 'world', position: [3, 1, 2], heading: 0.25 } }],
    });
    world.step(1 / 60);
    const entity = world.getEntity('belt-01');
    expect(entity?.transform.position).toEqual([3, 1, 2]);
    expect(entity?.transform.rotation?.[1]).toBeCloseTo(0.25, 9);
  });

  test('progress 信号按路径长度换算弧长', () => {
    const world = external();
    world.ingestExternalFrame({ entities: [{ id: 'belt-01', signal: { kind: 'progress', progress: 0.5 } }] });
    world.step(1 / 60);
    expect(world.getEntity('belt-01')?.transform.position[0]).toBeCloseTo(4, 6);
  });

  test('entry 信号由内核用自己的速度推进', () => {
    const world = external();
    world.ingestExternalFrame({ entities: [{ id: 'belt-01', signal: { kind: 'entry', tEnter: 0 } }] });
    run(world, 60, 1 / 60);
    expect(world.getEntity('belt-01')?.transform.position[0]).toBeCloseTo(1.2, 6);
  });

  test('未被投喂的实体保持原状，sim 模式下外部数据完全不生效', () => {
    const world = external();
    world.ingestExternalFrame({ entities: [{ id: 'belt-01', signal: { kind: 'progress', progress: 0.5 } }] });
    world.step(1 / 60);
    expect(world.getEntity('qc-01')?.transform.position).toEqual([8, 0.8, 0]);

    const simWorld = new TwinWorld(makeScene(), { seed: 3 });
    simWorld.ingestExternalFrame({ entities: [{ id: 'belt-01', signal: { kind: 'progress', progress: 0.5 } }] });
    run(simWorld, 60, 1 / 60);
    expect(simWorld.getEntity('belt-01')?.transform.position[0]).toBeCloseTo(1.2, 6);
  });

  test('hybrid 模式逐实体生效：没数据的设备继续用内核', () => {
    const world = new TwinWorld(makeScene(), { seed: 3 });
    world.setMode('hybrid');
    world.setEntityDataSource('belt-01', 'external');
    expect(world.getEntityDataSource('belt-01')).toBe('external');
    expect(world.getEntityDataSource('qc-01')).toBe('sim');

    world.ingestExternalFrame({ entities: [{ id: 'belt-01', signal: { kind: 'progress', progress: 0.25 } }] });
    world.step(1 / 60);
    expect(world.getEntity('belt-01')?.transform.position[0]).toBeCloseTo(2, 6);
  });

  test('外部出现的新实体被登记，并产出 added 差量', () => {
    const world = external();
    world.ingestExternalFrame({
      entities: [{ id: 'agv-07', kind: 'agv', signal: { kind: 'pose', frame: 'world', position: [1, 0, 1] } }],
    });
    const frame = world.step(1 / 60);
    expect(frame.added).toContain('agv-07');
    expect(world.getEntity('agv-07')?.transform.position).toEqual([1, 0, 1]);
    expect(world.getEventLog().some((event) => event.type === 'entity:external-bound')).toBe(true);
  });

  test('local 帧以场景声明的原点为基准，不会逐帧漂移', () => {
    const world = external();
    world.ingestExternalFrame({ entities: [{ id: 'belt-01', signal: { kind: 'pose', frame: 'local', position: [1, 0, 0] } }] });
    world.step(1 / 60);
    world.step(1 / 60);
    world.step(1 / 60);
    expect(world.getEntity('belt-01')?.transform.position[0]).toBeCloseTo(1, 9);
  });
});

describe('TwinWorld / 事件与快照', () => {
  test('sequence 严格单调，occurredAt 记仿真时间', () => {
    const world = new TwinWorld(makeScene());
    run(world, 10, 0.1);
    world.dispatch('test:event', { entityId: 'belt-01', payload: { ok: true } });

    const events = world.getEventLog();
    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(events[events.length - 1]?.occurredAt).toBeCloseTo(1, 9);
  });

  test('drainEvents 只交出未落库的部分', () => {
    const world = new TwinWorld(makeScene());
    world.dispatch('a');
    expect(world.drainEvents().map((event) => event.type)).toEqual(['a']);
    expect(world.drainEvents()).toEqual([]);
    world.dispatch('b');
    expect(world.drainEvents().map((event) => event.type)).toEqual(['b']);
  });

  test('快照恢复后继续推进，结果与不中断一致', () => {
    const scene = makeScene();
    const a = new TwinWorld(scene, { seed: 42, behaviors: [stampBehavior] });
    const b = new TwinWorld(scene, { seed: 42, behaviors: [stampBehavior] });

    run(a, 120);
    const snapshot = a.snapshot();
    run(a, 120);

    run(b, 120);
    b.restore(snapshot);
    run(b, 120);

    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  test('快照包含 rng 状态，恢复后随机序列衔接', () => {
    const world = new TwinWorld(makeScene(), { seed: 8, behaviors: [stampBehavior] });
    run(world, 30);
    const snapshot = world.snapshot();
    world.restore(snapshot);
    run(world, 30);

    const reference = new TwinWorld(makeScene(), { seed: 8, behaviors: [stampBehavior] });
    run(reference, 60);
    expect(fingerprint(world)).toBe(fingerprint(reference));
  });

  test('TwinWorld.fromScene 接受旧版本场景', () => {
    const world = TwinWorld.fromScene(
      { name: 'legacy', entities: [{ id: 'belt', type: 'transport', position: { x: 0, y: 0, z: 0 } }] },
      { seed: 1 },
    );
    expect(world.scene.version).toBe(1);
    expect(world.getEntity('belt')?.kind).toBe('transport');
  });

  test('动态增删实体会被记录到差量里', () => {
    const world = new TwinWorld(makeScene());
    world.addEntity({ id: 'tmp-1', kind: 'parcel', transform: { position: [0, 0, 0] }, capabilities: [] });
    expect(world.step(1 / 60).added).toEqual(['tmp-1']);
    expect(world.removeEntity('tmp-1')).toBe(true);
    expect(world.step(1 / 60).removed).toEqual(['tmp-1']);
  });

  test('非法 dt 直接抛错', () => {
    const world = new TwinWorld(makeScene());
    expect(() => world.step(0)).toThrow(/正数/);
    expect(() => world.advance(-1)).toThrow(/非负/);
  });
});

describe('行为插件', () => {
  test('行为可以改属性、改状态、发事件，且顺序固定', () => {
    const order: string[] = [];
    const first: WorldBehavior = { id: 'a', step: (ctx) => (order.push('a'), ctx.setAttr('qc-01', 'quality', 'ok')) };
    const second: WorldBehavior = {
      id: 'b',
      step: (ctx) => {
        order.push('b');
        if (ctx.entity('qc-01')?.attrs.quality === 'ok') ctx.setStatus('qc-01', 'passed');
      },
    };

    const world = new TwinWorld(makeScene(), { behaviors: [first, second] });
    world.step(1 / 60);

    expect(order).toEqual(['a', 'b']);
    expect(world.getEntity('qc-01')?.attrs.quality).toBe('ok');
    expect(world.getEntity('qc-01')?.status).toBe('passed');
  });

  test('move 沿实体自身路径推进（内核先跑自身运动，再跑行为）', () => {
    const world = new TwinWorld(makeScene(), {
      behaviors: [{ id: 'mover', step: (ctx) => ctx.move('belt-01', 2) }],
    });
    world.step(1 / 60);
    // 1.2 m/s × 1/60 s = 0.02，再加上行为推进的 2 米。
    expect(world.getEntity('belt-01')?.transform.position[0]).toBeCloseTo(2.02, 6);
  });

  test('addBehavior 让插件在世界建好之后再挂载，且按追加顺序执行', () => {
    const world = new TwinWorld(makeScene(), { behaviors: [{ id: 'core', step: () => {} }] });
    const order: string[] = [];
    world.addBehavior({ id: 'plugin-a', step: () => order.push('a') });
    world.addBehavior({ id: 'plugin-b', step: () => order.push('b') });
    world.step(1 / 60);

    expect(world.listBehaviors().map((behavior) => behavior.id)).toEqual(['core', 'plugin-a', 'plugin-b']);
    expect(order).toEqual(['a', 'b']);
    expect(() => world.addBehavior({ id: 'plugin-a', step: () => {} })).toThrow(/已注册/);
  });
});

/**
 * 生产线的两条基本语义：**一处持续产出**（小货物发生器）与**一处持续消耗**
 * （打包站吃掉小货物、卡车拉走大货物）。内核只给通用能力，语义在插件里。
 */
describe('行为生成 / 销毁实体', () => {
  /** 每 20 步产出一个货物，id 由步数派生——确定性来自"时间 → id"，不靠随机。 */
  const spawner: WorldBehavior = {
    id: 'test:spawner',
    step(ctx) {
      const tick = Math.round(ctx.time / ctx.dt);
      if (tick % 20 !== 0) return;
      const id = `goods-${String(tick).padStart(4, '0')}`;
      if (ctx.entity(id)) return;
      ctx.spawn({
        id,
        kind: 'parcel',
        transform: { position: [tick * 0.1, 1, 0] },
        capabilities: ['parcel'],
        visual: { kind: 'box', color: '#ff8800', size: [0.5, 0.5, 0.5] },
        config: { label: '小货物' },
        attrs: { born: ctx.time },
      });
      ctx.emit('goods:produced', { entityId: id });
    },
  };

  /** 每 40 步吃掉最老的一个货物（模拟"2 个小货物打包成 1 个大货物"）。 */
  const consumer: WorldBehavior = {
    id: 'test:consumer',
    step(ctx) {
      const tick = Math.round(ctx.time / ctx.dt);
      if (tick % 40 !== 0) return;
      const oldest = ctx.entities
        .filter((entity) => entity.capabilities.includes('parcel'))
        .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
      if (!oldest) return;
      ctx.despawn(oldest.id);
      ctx.emit('goods:consumed', { entityId: oldest.id });
    },
  };

  const makeFactory = (): TwinWorld => new TwinWorld(makeScene(), { seed: 3, behaviors: [spawner, consumer] });

  test('spawn 出的实体进世界、发事件，despawn 后从世界消失', () => {
    const world = makeFactory();
    // 步内时间先推进再跑行为，所以 tick = 步数：100 步 = tick 100。
    // 产出在 20/40/60/80/100，消耗在 40/80（每次吃掉最老的一个）。
    run(world, 100);

    const produced = world.getEventLog().filter((event) => event.type === 'goods:produced');
    const consumed = world.getEventLog().filter((event) => event.type === 'goods:consumed');
    expect(produced.length).toBe(5);
    expect(consumed.length).toBe(2);

    const alive = world.listEntities().filter((entity) => entity.kind === 'parcel');
    expect(alive.length).toBe(3);
    // 被消耗掉的那两个确实不在了
    for (const event of consumed) expect(world.getEntity(event.entityId as string)).toBeUndefined();
  });

  test('生成出来的实体保留声明（能力 / 外观 / 配置），快照恢复后还在', () => {
    const world = makeFactory();
    run(world, 60); // tick 60：活着 goods-0040 / goods-0060
    const id = 'goods-0060';
    const before = world.getEntity(id);
    expect(before?.capabilities).toEqual(['parcel']);
    expect(before?.visual?.color).toBe('#ff8800');
    expect(before?.config.label).toBe('小货物');

    const snapshot = world.snapshot();
    const restored = new TwinWorld(makeScene(), { seed: 3, behaviors: [spawner, consumer] });
    restored.restore(snapshot);

    const after = restored.getEntity(id);
    expect(after?.capabilities).toEqual(['parcel']);
    expect(after?.visual?.size).toEqual([0.5, 0.5, 0.5]);
    expect(after?.config.label).toBe('小货物');
    expect(after?.attrs.born).toBeCloseTo(before!.attrs.born as number, 9);
    expect(after?.transform.position).toEqual(before!.transform.position);
  });

  test('快照恢复后继续跑，和一路跑到底逐位一致', () => {
    const straight = makeFactory();
    run(straight, 90);
    const snapshot = straight.snapshot();
    run(straight, 90);

    const restored = makeFactory();
    run(restored, 90);
    restored.restore(snapshot);
    run(restored, 90);

    expect(fingerprint(restored)).toBe(fingerprint(straight));
  });

  test('往回跳时，消失的实体会出现在差量 removed 里（不留幽灵）', () => {
    const world = makeFactory();
    run(world, 60); // tick 60：快照里只有 goods-0040 / goods-0060
    const early = world.snapshot();
    run(world, 140); // tick 200：期间又产出 0080..0200

    expect(world.getEntity('goods-0200')).toBeDefined();
    world.restore(early);
    expect(world.getEntity('goods-0200')).toBeUndefined();

    const frame = world.step(1 / 60);
    // 差量必须告诉渲染层"这些实体没了"，否则场景里会留着上一时间线的货物
    expect(frame.removed).toContain('goods-0200');
    expect(frame.removed).toContain('goods-0120');
    // 快照里存在、但恢复前已被消耗的两个，则要作为 added 回来
    expect(frame.added).toEqual(expect.arrayContaining(['goods-0040', 'goods-0060']));
  });

  test('spawn 重复 id 抛错（契约违例交给宿主隔离）', () => {
    const world = new TwinWorld(makeScene(), {
      behaviors: [{ id: 'bad', step: (ctx) => ctx.spawn({ id: 'belt-01', kind: 'parcel', transform: { position: [0, 0, 0] }, capabilities: [] }) }],
    });
    expect(() => world.step(1 / 60)).toThrow(/已存在/);
  });
});

describe('resumeFrom / 事件续写', () => {
  /**
   * 服务端是持久的：一个场景被第二次录制时，仓库里已经有上一次的事件。
   * 不对齐 sequence 就会撞上"必须严格单调"，或者更糟——拼出一条由两条
   * 时间线接起来的假历史。
   */
  test('对齐后新事件从库里的最新 sequence 之后开始编号', () => {
    const world = new TwinWorld(makeScene());
    world.resumeFrom(100);
    world.dispatch('goods:produced', { entityId: 'source' });
    const last = world.getEventLog().at(-1);
    expect(last?.sequence).toBe(101);
  });

  test('对齐到 0（空库）时行为与全新会话一致', () => {
    const world = new TwinWorld(makeScene());
    expect(world.resumeFrom(0)).toBe(1);
    world.dispatch('goods:produced', { entityId: 'source' });
    expect(world.getEventLog().at(-1)?.sequence).toBe(1);
  });

  test('只推进不回退：往小对齐不会把已有事件重新编号', () => {
    const world = new TwinWorld(makeScene());
    world.dispatch('a');
    world.dispatch('b');
    expect(world.getEventLog().map((event) => event.sequence)).toEqual([1, 2]);

    world.resumeFrom(0); // 库里其实是空的，但这个调用不该把游标拉回去
    world.dispatch('c');
    expect(world.getEventLog().map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  test('对齐后 drainEvents 不会重复吐出"已落库"的事件', () => {
    const world = new TwinWorld(makeScene());
    world.resumeFrom(50);
    world.dispatch('goods:produced', { entityId: 'source' });
    // 50 及以前的被认为已落库，只有 51 是待写的。
    const pending = world.drainEvents();
    expect(pending.map((event) => event.sequence)).toEqual([51]);
    expect(world.drainEvents()).toEqual([]);
  });

  test('负数与非数字是无效输入，安全忽略', () => {
    const world = new TwinWorld(makeScene());
    const before = world.resumeFrom(0);
    expect(world.resumeFrom(-5)).toBe(before);
    expect(world.resumeFrom(Number.NaN)).toBe(before);
  });
});
