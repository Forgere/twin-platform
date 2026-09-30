import { describe, expect, test } from 'bun:test';
import { TwinWorld } from '@twin-platform/world-kernel';
import { createFishSimBehavior, LIFT_WINDOW } from './fishSim';
import { buildFishingScene } from './template';

const makeWorld = () => {
  const world = new TwinWorld(buildFishingScene({ castInterval: 0.5 }), { seed: 5, behaviors: [createFishSimBehavior()] });
  world.setAttr('rig-01', 'fishingMode', 'sim');
  world.setAttr('rig-01', 'manualCast', true);
  return world;
};
const attrs = (world: TwinWorld) => world.getEntity('rig-01')!.attrs;
const cast = (world: TwinWorld) => { world.setAttr('rig-01', 'cast', true); world.step(); };
const lift = (world: TwinWorld) => { world.setAttr('rig-01', 'lift', true); world.step(); };
const untilBite = (world: TwinWorld) => {
  for (let i = 0; i < 60 * 120 && attrs(world).pendingBite !== true; i++) world.step();
  expect(attrs(world).pendingBite).toBe(true);
};

describe('手动抛竿', () => {
  test('未抛不消耗随机数；一次抛竿等多轮鱼口也只计一竿，连点不重置', () => {
    const world = makeWorld();
    const rng = world.snapshot().rngState;
    world.runSteps(600);
    expect(attrs(world).casts).toBe(0);
    expect(world.snapshot().rngState).toEqual(rng);
    cast(world);
    const nextAt = attrs(world).nextAt;
    expect(attrs(world).casts).toBe(1);
    expect(attrs(world).inWater).toBe(true);
    cast(world);
    expect(attrs(world).casts).toBe(1);
    expect(attrs(world).nextAt).toBe(nextAt);
    untilBite(world);
    expect(attrs(world).casts).toBe(1);
    expect(world.getEventLog().filter((event) => event.type === 'fish:cast')).toHaveLength(1);
    expect(world.getEventLog().filter((event) => event.type === 'fish:bite')).toHaveLength(1);
    lift(world);
    expect(attrs(world).inWater).toBe(false);
    expect(attrs(world).pendingBite).toBe(false);
    const bites = attrs(world).bites;
    world.runSteps(600);
    expect(attrs(world).bites).toBe(bites);
    expect(attrs(world).casts).toBe(1);
  });

  test('收空竿和错过鱼口都回到待抛；新一竿清掉旧反馈与意图', () => {
    const world = makeWorld();
    cast(world);
    lift(world);
    expect(attrs(world).lastLift).toBe('blank');
    expect(attrs(world).inWater).toBe(false);
    cast(world);
    expect(attrs(world).lastLift).toBe('');
    expect(attrs(world).lift).toBe(false);
    untilBite(world);
    world.runSteps(Math.ceil(LIFT_WINDOW * 60));
    expect(attrs(world).lastLift).toBe('missed');
    expect(attrs(world).inWater).toBe(false);
    expect(attrs(world).signal).toBe('none');
    expect(attrs(world).bitHook).toBe('none');
    expect(attrs(world).missedBites).toBe(1);
  });

  test('超过窗口的提竿不能结算中鱼；岸上的残留提竿意图被消费', () => {
    const world = makeWorld();
    lift(world);
    expect(attrs(world).lift).toBe(false);
    expect(attrs(world).lastLift).toBeUndefined();
    cast(world);
    untilBite(world);
    world.setAttr('rig-01', 'biteUntil', world.time);
    lift(world);
    expect(attrs(world).lastLift).toBe('missed');
    expect(attrs(world).catches).toBe(0);
  });

  test('中鱼事件使用咬钩时鱼种，不跟随后来的目标鱼切换', () => {
    const world = makeWorld();
    for (let i = 0; i < 30; i++) {
      world.setAttr('rig-01', 'targetFish', 'crucian');
      cast(world);
      untilBite(world);
      expect(attrs(world).biteFish).toBe('crucian');
      world.setAttr('rig-01', 'targetFish', 'tilapia');
      lift(world);
      if (attrs(world).lastLift === 'caught') break;
    }
    const event = world.getEventLog().find((event) => event.type === 'fish:lift' && event.payload?.result === 'caught');
    expect(event?.payload?.fishId).toBe('crucian');
  });

  test('同种子同操作逐位一致；等待鱼口和已咬钩快照都可确定性恢复', () => {
    const run = () => {
      const world = makeWorld();
      for (let i = 0; i < 600; i++) {
        if (i % 120 === 0) world.setAttr('rig-01', 'cast', true);
        if (attrs(world).pendingBite) world.setAttr('rig-01', 'lift', true);
        world.step();
      }
      return JSON.stringify(world.snapshot());
    };
    expect(run()).toBe(run());
    for (const pending of [false, true]) {
      const world = makeWorld();
      cast(world);
      if (pending) untilBite(world);
      const snapshot = world.snapshot();
      const finish = () => {
        if (!pending) untilBite(world);
        lift(world);
        return { snapshot: world.snapshot(), events: world.getEventLog().filter((event) => event.sequence >= snapshot.sequence) };
      };
      const expected = finish();
      world.restoreFrom(snapshot);
      expect(finish()).toEqual(expected);
    }
  });

  test('显式自动提竿仍走旧自动流程，不被手动抛竿开关拦截', () => {
    const world = makeWorld();
    world.setAttr('rig-01', 'autoLift', true);
    world.runSteps(600);
    expect(Number(attrs(world).casts)).toBeGreaterThan(10);
    expect(attrs(world).inWater).toBeUndefined();
  });
});
