import { describe, expect, test } from 'bun:test';
import { TwinWorld } from '@twin-platform/world-kernel';
import { conditionMultipliers, conditionsOf } from './conditions';
import { applyFishingDecision } from './environment';
import { createFishSimBehavior } from './fishSim';
import { loadoutToAttrs, recommendedLoadout } from './loadout';
import { buildFishingScene } from './template';

/**
 * 决策闭环回归：情况 / 装备真的影响鱼口，动作真的改世界。
 *
 * 统计类断言用固定种子 + 足够多的竿数，比较的是"同种子下两种设定"的差异，
 * 不是绝对概率——模型数值可以调，方向不能错。
 */

const RIG = 'rig-01';

function pond(seed = 11): TwinWorld {
  return new TwinWorld(buildFishingScene({ castInterval: 1, rig: { t0: 6, t: 4, w: 1, d: 3.5 } }), {
    seed,
    maxStepsPerAdvance: 600,
    behaviors: [createFishSimBehavior()],
  });
}

function fish(world: TwinWorld, seconds: number): Record<string, unknown> {
  world.runSteps(Math.round(seconds / world.stepSize));
  return { ...(world.getEntity(RIG)?.attrs ?? {}) };
}

describe('钓场情况', () => {
  test('attrs 优先、config 兜底', () => {
    expect(conditionsOf({ config: { drift: true, waterTemperature: 12 } })).toMatchObject({ drift: true, waterTemperature: 12 });
    expect(conditionsOf({ attrs: { drift: false }, config: { drift: true } }).drift).toBe(false);
  });

  test('走水压低鱼口，加铅抗流后恢复大半；小鱼闹窝口多但中鱼率大跌', () => {
    const base = { drift: false, waterTemperature: 20, smallFish: false, antiDrift: false, nestUntil: 0 };
    const drift = conditionMultipliers({ ...base, drift: true }, 0);
    const leaded = conditionMultipliers({ ...base, drift: true, antiDrift: true }, 0);
    expect(drift.bite).toBeLessThan(leaded.bite);
    const small = conditionMultipliers({ ...base, smallFish: true }, 0);
    expect(small.bite).toBeGreaterThan(1);
    expect(small.hook).toBeLessThan(0.5);
    expect(conditionMultipliers({ ...base, nestUntil: 10 }, 5).bite).toBeGreaterThan(1);
  });

  test('仿真里小鱼闹窝：空竿显著变多', () => {
    const calm = fish(pond(), 400);
    const noisy = pond();
    noisy.setAttr(RIG, 'smallFish', true);
    const busy = fish(noisy, 400);
    const emptyRate = (attrs: Record<string, unknown>) => Number(attrs.emptyHooks) / Math.max(1, Number(attrs.bites));
    expect(emptyRate(busy)).toBeGreaterThan(emptyRate(calm) + 0.2);
  });

  test('细线钓草鱼会切线（breaks 计数 + fish:break 事件），推荐线组基本不切', () => {
    const thin = pond(5);
    for (const [key, value] of Object.entries(loadoutToAttrs({ ...recommendedLoadout('grass_carp'), mainLine: 0.8, subLine: 0.4 }))) {
      thin.setAttr(RIG, key, value);
    }
    const thinAttrs = fish(thin, 600);
    expect(Number(thinAttrs.breaks)).toBeGreaterThan(0);
    expect(thin.getEventLog().some((event) => event.type === 'fish:break')).toBe(true);

    const good = pond(5);
    for (const [key, value] of Object.entries(loadoutToAttrs(recommendedLoadout('grass_carp')))) good.setAttr(RIG, key, value);
    expect(Number(fish(good, 600).breaks ?? 0)).toBeLessThan(Number(thinAttrs.breaks));
  });
});

describe('applyFishingDecision：动作落到世界', () => {
  test('调漂 / 改钓层改钓目', () => {
    const world = pond();
    applyFishingDecision(world, { action: 'ADJUST_FLOAT', params: { direction: 'blunt', steps: 1 } }, 0);
    expect(world.getEntity(RIG)?.attrs.d).toBe(4.5);
    applyFishingDecision(world, { action: 'CHANGE_LAYER', params: { direction: 'up', band: 2 } }, 0);
    expect(world.getEntity(RIG)?.attrs.d).toBe(2.5);
  });

  test('加铅：t0 / t 同降、双钩压目不变、标记抗流', () => {
    const world = pond();
    const note = applyFishingDecision(world, { action: 'ADD_LEAD', params: { amount: 'medium' } }, 0);
    const attrs = world.getEntity(RIG)!.attrs;
    expect(attrs.t0).toBe(5);
    expect(attrs.t).toBe(3);
    expect(attrs.antiDrift).toBe(true);
    expect(note).toContain('加铅');
  });

  test('换饵换成目标鱼更爱吃的；改钓组换回推荐规格；换钓位清掉闹窝', () => {
    const world = pond();
    for (const [key, value] of Object.entries(loadoutToAttrs({ ...recommendedLoadout('carp'), bait: 'worm', hookSize: 1 }))) {
      world.setAttr(RIG, key, value);
    }
    world.setAttr(RIG, 'smallFish', true);
    applyFishingDecision(world, { action: 'CHANGE_BAIT', params: { target: 'flavor' } }, 0);
    expect(world.getEntity(RIG)?.attrs.bait).toBe('corn');
    applyFishingDecision(world, { action: 'REBUILD_RIG', params: { target: 'hook' } }, 0);
    expect(world.getEntity(RIG)?.attrs.hookSize).toBe(recommendedLoadout('carp').hookSize);
    applyFishingDecision(world, { action: 'CHANGE_SPOT', params: { urgency: 'now' } }, 0);
    expect(world.getEntity(RIG)?.attrs.smallFish).toBe(false);
  });

  test('补窝设置窝料有效期', () => {
    const world = pond();
    applyFishingDecision(world, { action: 'REFILL_NEST', params: { amount: 'normal' } }, 30);
    expect(world.getEntity(RIG)?.attrs.nestUntil).toBe(120);
  });
});
