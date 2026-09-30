import { describe, expect, test } from 'vitest';
import { solveRigChain, solveRigChainBuoyant, subLineLength, SUBLINE_SIDE, type ChainRest, type V3 } from './rigChain';

const FLOOR = 0;
const rest = (bendLower: number): ChainRest => ({
  float: [0, 2.0, 0],
  sinker: [0, 0.75, 0],
  swivel: [0, 0.6, 0],
  upper: [-0.14, 0.35, 0],
  lower: [0.14, 0.2, 0],
  bend: { upper: 0, lower: bendLower },
  floorY: FLOOR,
});
const drag = (r: ChainRest, out: number): V3 => [r.lower[0] + out, r.lower[1], r.lower[2]];
const lowerLen = (r: ChainRest, s: { swivel: V3; lower: V3; bend: { lower: number } }) =>
  subLineLength(s.swivel, s.lower, s.bend.lower, SUBLINE_SIDE.lower, r.floorY);
const len = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('受力链：线拉动，不伸缩', () => {
  test('不拖 = 静止位', () => {
    const r = rest(0.3);
    const solved = solveRigChain(r, r.lower);
    expect(solved.float).toEqual(r.float);
    expect(solved.swivel).toEqual(r.swivel);
    expect(solved.bend.lower).toBeCloseTo(0.3, 3);
  });

  test('拖钩：子线弧长、主线各段长度都守恒；8 字环、铅坠、漂被依次拉下来', () => {
    const r = rest(0);
    const solved = solveRigChain(r, drag(r, 0.6));
    expect(lowerLen(r, solved)).toBeCloseTo(lowerLen(r, { ...r, bend: r.bend }), 3);
    expect(len(solved.swivel, solved.sinker)).toBeCloseTo(len(r.swivel, r.sinker), 6);
    expect(len(solved.sinker, solved.float)).toBeCloseTo(len(r.sinker, r.float), 6);
    expect(solved.swivel[1]).toBeLessThan(r.swivel[1]);
    expect(solved.sinker[1]).toBeLessThan(r.sinker[1]);
    expect(solved.float[1]).toBeLessThan(r.float[1]);
  });

  test('钝（子线弯）：先把弯拉直，同样一拖漂下得更少；轻拖时漂完全不动', () => {
    const sensitive = rest(0);
    const blunt = rest(0.8);
    const dropOf = (r: ChainRest, out: number) => r.float[1] - solveRigChain(r, drag(r, out)).float[1];
    expect(dropOf(blunt, 0.6)).toBeLessThan(dropOf(sensitive, 0.6));
    const light = solveRigChain(blunt, drag(blunt, 0.05));
    expect(light.float).toEqual(blunt.float);
    expect(light.bend.lower).toBeLessThan(0.8);
    expect(light.bend.lower).toBeGreaterThan(0);
  });

  test('8 字环被拉远时，没被咬的上钩也被子线拖着走', () => {
    const r = rest(0);
    const solved = solveRigChain(r, drag(r, 1.2));
    expect(solved.upper).not.toEqual(r.upper);
  });
  test('拖得再远，8 字环和铅坠也只贴着水底走，不穿到底下', () => {
    const r = rest(0);
    const solved = solveRigChain(r, drag(r, 5));
    expect(solved.swivel[1]).toBeGreaterThanOrEqual(FLOOR);
    expect(solved.sinker[1]).toBeGreaterThanOrEqual(FLOOR);
  });

  test('漂有浮力：拖得再远，漂也只被拉下去上限那么多；上限内与不限一致', () => {
    const r = rest(0);
    const limit = { drop: 0.3, shift: 0.05 };
    const capped = solveRigChainBuoyant(r, drag(r, 3), 'lower', limit);
    expect(r.float[1] - capped.float[1]).toBeLessThanOrEqual(0.3 + 1e-9);
    expect(Math.abs(capped.float[0] - r.float[0])).toBeLessThanOrEqual(0.05 + 1e-9);
    const light = drag(r, 0.2);
    expect(solveRigChainBuoyant(r, light, 'lower', limit)).toEqual(solveRigChain(r, light, 'lower'));
  });

  test('咬上钩：拖的是上钩，下钩被子线带着走', () => {
    const r = rest(0);
    const target: V3 = [r.upper[0] - 1.2, r.upper[1], r.upper[2]];
    const solved = solveRigChain(r, target, 'upper');
    expect(solved.upper).toEqual(target);
    expect(solved.lower).not.toEqual(r.lower);
    expect(solved.float[1]).toBeLessThan(r.float[1]);
  });

  test('漂被拉时是往下沉，不被横着拖走', () => {
    const r = rest(0);
    const solved = solveRigChain(r, drag(r, 1.2), 'lower');
    expect(solved.float[0]).toBe(r.float[0]);
    expect(solved.float[1]).toBeLessThan(r.float[1]);
  });
});
