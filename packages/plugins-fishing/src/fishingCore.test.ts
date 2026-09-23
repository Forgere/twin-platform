import { describe, expect, test } from 'bun:test';
import { calculateRigState, type RigZone, type TaidiaoInput } from './fishingCore';

const close = (actual: number, expected: number): void => {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-9);
};

/**
 * 标定过的台钓钓组。临界钓目由公式直接给出，测试只做独立核对：
 *   d1 = t - 2w（B = 0）  d2 = t - w + hw（B = hw + w）  d3 = t0（B = H + 2w）
 */
const RIGS: readonly { id: string; input: TaidiaoInput; d1: number; d2: number; d3: number }[] = [
  { id: 'A', input: { t0: 4, t: 2, w: 1 }, d1: 0, d2: 2, d3: 4 },
  { id: 'B', input: { t0: 6, t: 4, w: 1 }, d1: 2, d2: 4, d3: 6 },
  { id: 'C', input: { t0: 8, t: 6, w: 2 }, d1: 2, d2: 5, d3: 8 },
  { id: 'D', input: { t0: 5, t: 3, w: 1.5 }, d1: 0, d2: 2.5, d3: 5 },
  { id: 'E', input: { t0: 7, t: 5, w: 0.5 }, d1: 4, d2: 5.5, d3: 7 },
];

interface Case {
  readonly name: string;
  readonly input: TaidiaoInput;
  readonly b: number;
  readonly zone: RigZone;
}

describe('calculateRigState — 基础用例（20）', () => {
  const CASES: readonly Case[] = [
    { name: 'A/0.5 灵区', input: { t0: 4, t: 2, w: 1, d: 0.5 }, b: 0.5, zone: 'sensitive' },
    { name: 'A/1 灵区', input: { t0: 4, t: 2, w: 1, d: 1 }, b: 1, zone: 'sensitive' },
    { name: 'A/1.5 灵区', input: { t0: 4, t: 2, w: 1, d: 1.5 }, b: 1.5, zone: 'sensitive' },
    { name: 'A/2 不灵不钝', input: { t0: 4, t: 2, w: 1, d: 2 }, b: 2, zone: 'neutral' },
    { name: 'A/2.5 钝区', input: { t0: 4, t: 2, w: 1, d: 2.5 }, b: 2.5, zone: 'blunt' },
    { name: 'A/3 钝区', input: { t0: 4, t: 2, w: 1, d: 3 }, b: 3, zone: 'blunt' },
    { name: 'A/4 铅坠触底', input: { t0: 4, t: 2, w: 1, d: 4 }, b: 4, zone: 'sinker_on_bottom' },
    { name: 'B/3 灵区', input: { t0: 6, t: 4, w: 1, d: 3 }, b: 1, zone: 'sensitive' },
    { name: 'B/4 不灵不钝', input: { t0: 6, t: 4, w: 1, d: 4 }, b: 2, zone: 'neutral' },
    { name: 'B/5 钝区', input: { t0: 6, t: 4, w: 1, d: 5 }, b: 3, zone: 'blunt' },
    { name: 'B/6 铅坠触底', input: { t0: 6, t: 4, w: 1, d: 6 }, b: 4, zone: 'sinker_on_bottom' },
    { name: 'C/4 灵区', input: { t0: 8, t: 6, w: 2, d: 4 }, b: 2, zone: 'sensitive' },
    { name: 'C/5 不灵不钝', input: { t0: 8, t: 6, w: 2, d: 5 }, b: 3, zone: 'neutral' },
    { name: 'C/6 钝区', input: { t0: 8, t: 6, w: 2, d: 6 }, b: 4, zone: 'blunt' },
    { name: 'C/8 铅坠触底', input: { t0: 8, t: 6, w: 2, d: 8 }, b: 6, zone: 'sinker_on_bottom' },
    { name: 'D/1 灵区', input: { t0: 5, t: 3, w: 1.5, d: 1 }, b: 1, zone: 'sensitive' },
    { name: 'D/2.5 不灵不钝', input: { t0: 5, t: 3, w: 1.5, d: 2.5 }, b: 2.5, zone: 'neutral' },
    { name: 'D/4 钝区', input: { t0: 5, t: 3, w: 1.5, d: 4 }, b: 4, zone: 'blunt' },
    { name: 'E/4.5 灵区', input: { t0: 7, t: 5, w: 0.5, d: 4.5 }, b: 0.5, zone: 'sensitive' },
    { name: 'E/6 钝区', input: { t0: 7, t: 5, w: 0.5, d: 6 }, b: 2, zone: 'blunt' },
  ];

  for (const item of CASES) {
    test(item.name, () => {
      const result = calculateRigState(item.input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      close(result.state.bottomLoad, item.b);
      expect(result.state.zone).toBe(item.zone);
    });
  }
});

describe('calculateRigState — 临界钓目', () => {
  for (const rig of RIGS) {
    test(rig.id + ' 钓组的 d1 / d2 / d3 / span', () => {
      const result = calculateRigState({ ...rig.input, d: rig.d1 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      close(result.state.criticalMarks.d1, rig.d1);
      close(result.state.criticalMarks.d2, rig.d2);
      close(result.state.criticalMarks.d3, rig.d3);
      close(result.state.span, rig.d3 - rig.d1);
      close(result.state.adjustableRange.min, rig.d1);
      close(result.state.adjustableRange.max, rig.d3);
    });
  }
});

describe('calculateRigState — 边界用例（10）', () => {
  const CASES: readonly Case[] = [
    { name: 'A 恰在 d1（B=0）判未到底', input: { t0: 4, t: 2, w: 1, d: 0 }, b: 0, zone: 'off_bottom' },
    { name: 'A 刚过 d1 判灵区', input: { t0: 4, t: 2, w: 1, d: 0.0000001 }, b: 1e-7, zone: 'sensitive' },
    { name: 'A 恰在 d2 判不灵不钝', input: { t0: 4, t: 2, w: 1, d: 2 }, b: 2, zone: 'neutral' },
    { name: 'A 略低于 d2 仍偏灵', input: { t0: 4, t: 2, w: 1, d: 1.9999999 }, b: 1.9999999, zone: 'sensitive' },
    { name: 'A 略高于 d2 已偏钝', input: { t0: 4, t: 2, w: 1, d: 2.0000001 }, b: 2.0000001, zone: 'blunt' },
    { name: 'A 略低于 d3 仍偏钝', input: { t0: 4, t: 2, w: 1, d: 3.9999999 }, b: 3.9999999, zone: 'blunt' },
    { name: 'A 恰在 d3 判铅坠触底', input: { t0: 4, t: 2, w: 1, d: 4 }, b: 4, zone: 'sinker_on_bottom' },
    { name: 'C 恰在 d2 判不灵不钝', input: { t0: 8, t: 6, w: 2, d: 5 }, b: 3, zone: 'neutral' },
    { name: 'E 恰在 d1（B=0）判未到底', input: { t0: 7, t: 5, w: 0.5, d: 4 }, b: 0, zone: 'off_bottom' },
    { name: 'E 恰在 d2 判不灵不钝', input: { t0: 7, t: 5, w: 0.5, d: 5.5 }, b: 1.5, zone: 'neutral' },
  ];

  for (const item of CASES) {
    test(item.name, () => {
      const result = calculateRigState(item.input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      close(result.state.bottomLoad, item.b);
      expect(result.state.zone).toBe(item.zone);
    });
  }
});

describe('calculateRigState — 异常输入（10）', () => {
  const CASES: readonly { name: string; input: TaidiaoInput; code: string }[] = [
    { name: 't0 < t 拒绝', input: { t0: 2, t: 4, w: 1, d: 2 }, code: 'HOOK_MARK_NOT_BELOW_NO_HOOK' },
    { name: 't0 = t 拒绝', input: { t0: 4, t: 4, w: 1, d: 2 }, code: 'HOOK_MARK_NOT_BELOW_NO_HOOK' },
    { name: 'w = 0 拒绝', input: { t0: 4, t: 2, w: 0, d: 2 }, code: 'BAIT_WEIGHT_NOT_POSITIVE' },
    { name: 'w < 0 拒绝', input: { t0: 4, t: 2, w: -1, d: 2 }, code: 'BAIT_WEIGHT_NOT_POSITIVE' },
    { name: 'd < 0 拒绝', input: { t0: 4, t: 2, w: 1, d: -1 }, code: 'CAST_MARK_NEGATIVE' },
    { name: 't0 = 0 拒绝', input: { t0: 0, t: -1, w: 1, d: 2 }, code: 'NO_HOOK_MARK_NOT_POSITIVE' },
    { name: 't0 < 0 拒绝', input: { t0: -1, t: -2, w: 1, d: 2 }, code: 'NO_HOOK_MARK_NOT_POSITIVE' },
    { name: 't 为 NaN 拒绝', input: { t0: 4, t: Number.NaN, w: 1, d: 2 }, code: 'NOT_FINITE' },
    { name: 'w 为 Infinity 拒绝', input: { t0: 4, t: 2, w: Number.POSITIVE_INFINITY, d: 2 }, code: 'NOT_FINITE' },
    { name: 'd 为 NaN 拒绝', input: { t0: 4, t: 2, w: 1, d: Number.NaN }, code: 'NOT_FINITE' },
  ];

  for (const item of CASES) {
    test(item.name, () => {
      const result = calculateRigState(item.input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.code)).toContain(item.code as never);
    });
  }
});

describe('calculateRigState — 真实钓组（10）', () => {
  const CASES: readonly Case[] = [
    { name: '冬钓小鲫 偏灵', input: { t0: 4, t: 2, w: 0.8, d: 1.5 }, b: 1.1, zone: 'sensitive' },
    { name: '冬钓小鲫 偏钝', input: { t0: 4, t: 2, w: 0.8, d: 3 }, b: 2.6, zone: 'blunt' },
    { name: '春秋中鲫 偏钝', input: { t0: 6, t: 4, w: 1.2, d: 4.5 }, b: 2.9, zone: 'blunt' },
    { name: '春秋中鲫 不灵不钝', input: { t0: 6, t: 4, w: 1.2, d: 3.8 }, b: 2.2, zone: 'neutral' },
    { name: '走水前夕 偏灵', input: { t0: 8, t: 6, w: 1.5, d: 4 }, b: 1, zone: 'sensitive' },
    { name: '深水搓饵 偏钝', input: { t0: 7, t: 5, w: 2, d: 5 }, b: 4, zone: 'blunt' },
    { name: '浅水拉饵 偏灵', input: { t0: 3, t: 2, w: 0.5, d: 1.5 }, b: 0.5, zone: 'sensitive' },
    { name: '大饵重压 不灵不钝', input: { t0: 9, t: 7, w: 3, d: 5 }, b: 4, zone: 'neutral' },
    { name: '钩重偏大 不灵不钝', input: { t0: 8, t: 6, w: 1, d: 6 }, b: 2, zone: 'neutral' },
    { name: '铅坠触底边缘', input: { t0: 6, t: 4, w: 1.5, d: 7 }, b: 6, zone: 'sinker_on_bottom' },
  ];

  for (const item of CASES) {
    test(item.name, () => {
      const result = calculateRigState(item.input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      close(result.state.bottomLoad, item.b);
      expect(result.state.zone).toBe(item.zone);
    });
  }
});

describe('calculateRigState — 受力分解', () => {
  test('B 恰好等于四段承重之和', () => {
    const result = calculateRigState({ t0: 8, t: 6, w: 2, d: 6 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const loads = result.state.loads;
    close(loads.lowerBait + loads.lowerHook + loads.upperBait + loads.upperHook, result.state.bottomLoad);
  });

  test('未到底时双钩双饵全部悬浮', () => {
    const result = calculateRigState({ t0: 4, t: 2, w: 1, d: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.hookState).toBe('suspended');
    expect(result.state.baitState).toBe('suspended');
  });

  test('不灵不钝时下钩躺底、上钩仍悬', () => {
    const result = calculateRigState({ t0: 8, t: 6, w: 2, d: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.hookState).toBe('lower_on_bottom');
    expect(result.state.baitState).toBe('lower_settled');
  });

  test('铅坠触底时整串承重', () => {
    const result = calculateRigState({ t0: 4, t: 2, w: 1, d: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.hookState).toBe('sinker');
    expect(result.state.baitState).toBe('both_settled');
  });
});
