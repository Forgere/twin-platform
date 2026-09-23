import { describe, expect, test } from 'bun:test';
import { calculateRigState } from './fishingCore';
import {
  DEFAULT_LOADOUT,
  TARGET_FISH,
  estimateMarks,
  loadoutChecks,
  loadoutEffects,
  loadoutFromAttrs,
  loadoutToAttrs,
  recommendedLoadout,
} from './loadout';
import { presetById } from './presets';

/**
 * 目标鱼 + 装备回归。
 *
 * 关键约定：
 * - 每条鱼的**推荐装备**必须零 error（向导的默认选项不能自己打自己脸）；
 * - 常识性错误（子线不细于主线、钩对鱼太大 / 太小）一定报 error；
 * - 倍率是单调的：配得越差，口越少 / 中得越少 / 断得越多；
 * - 模拟测量给出的调目必须是 calculateRigState 能接受的合法组合。
 */

describe('目标鱼与装备', () => {
  test('每条鱼的推荐装备零 error，推荐预设存在', () => {
    for (const fish of TARGET_FISH) {
      const loadout = recommendedLoadout(fish.id);
      const errors = loadoutChecks(loadout).filter((check) => check.level === 'error');
      expect({ fish: fish.id, errors }).toEqual({ fish: fish.id, errors: [] });
      expect(loadout.subLine).toBeLessThan(loadout.mainLine);
      expect(presetById(fish.presetId)).toBeDefined();
    }
  });

  test('子线不细于主线 → error', () => {
    const loadout = { ...recommendedLoadout('carp'), mainLine: 1.5, subLine: 1.5 };
    expect(loadoutChecks(loadout).some((check) => check.level === 'error' && check.part === 'line')).toBe(true);
  });

  test('钩对鲫鱼太大 → error，并压低咬钩与中鱼倍率', () => {
    const good = recommendedLoadout('crucian');
    const bigHook = { ...good, hookSize: 6 };
    expect(loadoutChecks(bigHook).some((check) => check.level === 'error' && check.part === 'hook')).toBe(true);
    expect(loadoutEffects(bigHook).biteMul).toBeLessThan(loadoutEffects(good).biteMul);
    expect(loadoutEffects(bigHook).hookMul).toBeLessThan(loadoutEffects(good).hookMul);
  });

  test('细线钓草鱼：断线概率明显上升；推荐装备断线概率低', () => {
    const good = recommendedLoadout('grass_carp');
    const thin = { ...good, subLine: 0.4, mainLine: 0.8 };
    expect(loadoutEffects(good).breakChance).toBeLessThan(0.1);
    expect(loadoutEffects(thin).breakChance).toBeGreaterThan(0.25);
    expect(loadoutChecks(thin).some((check) => check.level === 'error' && check.part === 'line')).toBe(true);
  });

  test('鱼不爱吃的饵降低咬钩倍率', () => {
    const crucian = recommendedLoadout('crucian');
    expect(loadoutEffects({ ...crucian, bait: 'corn' }).biteMul).toBeLessThan(loadoutEffects(crucian).biteMul);
  });

  test('鱼种的灵钝偏好：鲫鱼偏灵、鲤鱼偏钝', () => {
    const crucian = loadoutEffects(recommendedLoadout('crucian')).zoneBite;
    const carp = loadoutEffects(recommendedLoadout('carp')).zoneBite;
    expect(crucian.sensitive).toBeGreaterThan(crucian.blunt);
    expect(carp.blunt).toBeGreaterThan(carp.sensitive);
  });

  test('attrs 往返一致；缺失 / 非法值逐项回退默认', () => {
    const loadout = { ...recommendedLoadout('tilapia'), rodLength: 6.3 };
    expect(loadoutFromAttrs(loadoutToAttrs(loadout))).toEqual(loadout);
    expect(loadoutFromAttrs(undefined)).toEqual(DEFAULT_LOADOUT);
    expect(loadoutFromAttrs({ targetFish: 'whale', hookSize: -1, bait: 'pizza' })).toEqual(DEFAULT_LOADOUT);
  });

  test('模拟测量：每套推荐装备都给出合法调目（t < t0，w > 0，半目取整）', () => {
    for (const fish of TARGET_FISH) {
      const marks = estimateMarks(recommendedLoadout(fish.id));
      expect(marks.t).toBeLessThan(marks.t0);
      expect(marks.w).toBeGreaterThan(0);
      expect((marks.t * 2) % 1).toBe(0);
      expect((marks.w * 2) % 1).toBe(0);
      expect(calculateRigState({ ...marks, d: marks.t }).ok).toBe(true);
    }
  });

  test('漂越小，同一副钩饵压的目数越多', () => {
    const base = recommendedLoadout('carp');
    const small = estimateMarks({ ...base, floatSize: 1.5 });
    const large = estimateMarks({ ...base, floatSize: 4 });
    expect(small.t0 - small.t).toBeGreaterThan(large.t0 - large.t);
    expect(small.w).toBeGreaterThan(large.w);
  });
});
