import { describe, expect, test } from 'bun:test';
import { DecisionEngine } from '@twin-platform/decision-core';
import { TwinWorld } from '@twin-platform/world-kernel';
import { fishingDomain } from './domain';
import { FishingEnvironment } from './environment';
import { createFishSimBehavior } from './fishSim';
import { buildFishingScene } from './template';

const simulate = (initialD: number, seconds: number) => {
  const world = new TwinWorld(buildFishingScene({ rig: { d: initialD }, castInterval: 1 }), {
    seed: 5,
    maxStepsPerAdvance: 600,
    behaviors: [createFishSimBehavior()],
  });
  world.runSteps(60 * seconds);
  const attrs = world.getEntity('rig-01')?.attrs ?? {};
  return { casts: Number(attrs.casts), bites: Number(attrs.bites), catches: Number(attrs.catches) };
};

describe('FishingEnvironment · 闭环', () => {
  test('不灵不钝比未到底钓得多（仿真是决策的裁判）', () => {
    const neutral = simulate(2, 1200);
    const offBottom = simulate(0, 1200);
    expect(neutral.catches).toBeGreaterThan(offBottom.catches);
  });

  test('observe -> decide -> step 会应用建议并产出结果', async () => {
    const env = new FishingEnvironment({ seed: 2, horizon: 60, template: { rig: { d: 0 }, castInterval: 1 } });
    // 先空跑几竿，让观察里出现"没口"。
    env.world.runSteps(60 * 5);

    const state = env.observe();
    expect(state.rig.zone).toBe('off_bottom');
    expect(state.intent).toBe('no_bite');

    const engine = new DecisionEngine(fishingDomain);
    const record = await engine.decide(state, { at: env.world.time });
    expect(record.accepted).toBe(true);
    expect(record.decision.action).toBe('ADJUST_FLOAT');

    const outcome = env.step(record.decision);
    expect(outcome.metrics.casts).toBeGreaterThan(0);
    // 往钝 2 目后钓目应为 2（t0=4,t=2,w=1 的不灵不钝点）。
    expect(Number(env.world.getEntity('rig-01')?.attrs.d)).toBe(2);
  });

  test('同种子的环境结果可复现', () => {
    const run = (): number => {
      const env = new FishingEnvironment({ seed: 9, horizon: 300, template: { castInterval: 1 } });
      env.world.runSteps(60 * 300);
      return Number(env.world.getEntity('rig-01')?.attrs.catches ?? -1);
    };
    expect(run()).toBe(run());
  });
});
