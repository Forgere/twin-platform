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
