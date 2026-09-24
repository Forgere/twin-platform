import { describe, expect, test } from 'bun:test';
import { TwinWorld, type WorldEvent } from '@twin-platform/world-kernel';
import { calculateRigState } from './fishingCore';
import { biteProbability, createFishSimBehavior, fishingLayout, hookProbability, temperatureFactor } from './fishSim';
import { buildFishingScene } from './template';

describe('鱼口模型', () => {
  test('不灵不钝咬钩率最高，灵区中鱼率最低', () => {
    expect(biteProbability('neutral')).toBeGreaterThan(biteProbability('blunt'));
    expect(biteProbability('blunt')).toBeGreaterThan(biteProbability('off_bottom'));
    expect(hookProbability('neutral')).toBeGreaterThan(hookProbability('sensitive'));
  });

  test('水温 18~24 度最活跃，两侧衰减', () => {
    expect(temperatureFactor(20)).toBe(1);
    expect(temperatureFactor(10)).toBeLessThan(1);
    expect(temperatureFactor(30)).toBeLessThan(1);
    expect(temperatureFactor(0)).toBe(0.2);
  });
});

describe('fishingLayout', () => {
  test('底承重越大，下钩越贴底', () => {
    const floating = calculateRigState({ t0: 4, t: 2, w: 1, d: 0 });
    const settled = calculateRigState({ t0: 4, t: 2, w: 1, d: 4 });
    expect(floating.ok && settled.ok).toBe(true);
    if (!floating.ok || !settled.ok) return;
    const a = fishingLayout({ t0: 4, t: 2, w: 1, d: 0 }, floating.state, { depth: 2 });
    const b = fishingLayout({ t0: 4, t: 2, w: 1, d: 4 }, settled.state, { depth: 2 });
    expect(a.lowerHook[1]).toBeGreaterThan(b.lowerHook[1]);
  });
});

const fingerprint = (events: readonly WorldEvent[], attrs: Record<string, unknown>): string =>
  JSON.stringify({ events: events.map((event) => event.type + ':' + JSON.stringify(event.payload ?? {})), attrs });

describe('fish-sim 行为', () => {
  test('同种子两次运行逐位一致', () => {
    const run = (): string => {
      const world = new TwinWorld(buildFishingScene({ castInterval: 1 }), {
        seed: 7,
        maxStepsPerAdvance: 600,
        behaviors: [createFishSimBehavior()],
      });
      world.runSteps(60 * 120);
      return fingerprint(world.getEventLog(), { ...(world.getEntity('rig-01')?.attrs ?? {}) });
    };
    expect(run()).toBe(run());
  });

  test('抛竿会累计计数并发出 fish:cast', () => {
    const world = new TwinWorld(buildFishingScene({ castInterval: 1 }), {
      seed: 3,
      maxStepsPerAdvance: 600,
      behaviors: [createFishSimBehavior()],
    });
    world.runSteps(60 * 30);
    const attrs = world.getEntity('rig-01')?.attrs ?? {};
    expect(Number(attrs.casts)).toBeGreaterThan(20);
    expect(world.getEventLog().some((event) => event.type === 'fish:cast')).toBe(true);
  });

  test('有口才记咬的是哪只钩，上下钩都会被咬；无口记 none', () => {
    const world = new TwinWorld(buildFishingScene({ castInterval: 1 }), {
      seed: 11,
      maxStepsPerAdvance: 600,
      behaviors: [createFishSimBehavior()],
    });
    world.runSteps(60 * 400);
    const casts = world.getEventLog().filter((event) => event.type === 'fish:cast');
    const hooks = new Set(casts.filter((event) => event.payload?.bite === true).map((event) => event.payload?.bitHook));
    expect(hooks).toEqual(new Set(['upper', 'lower']));
    expect(casts.filter((event) => event.payload?.bite !== true).every((event) => event.payload?.bitHook === 'none')).toBe(true);
  });

  test('布局实体跟着钓组动，不是静态装饰', () => {
    const world = new TwinWorld(buildFishingScene({ rig: { d: 0 } }), {
      seed: 1,
      maxStepsPerAdvance: 600,
      behaviors: [createFishSimBehavior()],
    });
    world.step(1 / 60);
    const before = world.getEntity('hook-lower-01')?.transform.position[1];
    world.setAttr('rig-01', 'd', 4);
    world.step(1 / 60);
    const after = world.getEntity('hook-lower-01')?.transform.position[1];
    expect(typeof before).toBe('number');
    expect(after).not.toBe(before);
  });
});

describe('钓组阶段（rigPhase）', () => {
  const world = (rigPhase?: string, extra: Record<string, number> = {}) => {
    const instance = new TwinWorld(buildFishingScene({ castInterval: 1 }), {
      seed: 3,
      maxStepsPerAdvance: 600,
      behaviors: [createFishSimBehavior()],
    });
    if (rigPhase) instance.setAttr('rig-01', 'rigPhase', rigPhase);
    for (const [key, value] of Object.entries(extra)) instance.setAttr('rig-01', key, value);
    return instance;
  };

  test('向导没走完（setup）/ 找底中不抛竿', () => {
    for (const phase of ['setup', 'find_bottom', 'measure_t0']) {
      const target = world(phase);
      target.runSteps(60 * 30);
      expect(Number(target.getEntity('rig-01')?.attrs.casts ?? 0)).toBe(0);
      expect(target.getEventLog().some((event) => event.type === 'fish:cast')).toBe(false);
    }
  });

  test('缺省阶段即 fishing：旧场景照常抛竿', () => {
    const target = world();
    target.runSteps(60 * 30);
    expect(Number(target.getEntity('rig-01')?.attrs.casts)).toBeGreaterThan(20);
  });

  test('测量阶段：铅坠吊在半水，漂尾按 setupMarks 露出，不挂钩时钩收在 8 字环', () => {
    const target = world('measure_t0', { setupMarks: 6 });
    target.runSteps(2);
    const y = (id: string): number => target.getEntity(id)?.transform.position[1] ?? NaN;
    const config = target.getEntity('rig-01')?.config as { surfaceY: number; depth: number };
    expect(y('sinker-01')).toBeCloseTo(config.surfaceY - config.depth / 2, 5);
    expect(y('hook-upper-01')).toBeCloseTo(y('swivel-01'), 5);

    const higher = world('measure_t0', { setupMarks: 8 });
    higher.runSteps(2);
    expect(higher.getEntity('float-01')!.transform.position[1]).toBeGreaterThan(y('float-01'));

    const hooked = world('measure_t', { setupMarks: 4 });
    hooked.runSteps(2);
    const hy = (id: string): number => hooked.getEntity(id)?.transform.position[1] ?? NaN;
    expect(hy('hook-upper-01')).toBeLessThan(hy('swivel-01'));
    expect(hy('hook-lower-01')).toBeLessThan(hy('hook-upper-01'));
  });
});
