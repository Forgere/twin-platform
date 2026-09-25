import { describe, expect, test } from 'vitest';
import { Rope, ROPE_SEGMENTS, type RopeForces, type Vec3 } from './rope';

const still: RopeForces = { gravity: -9.8, current: [0, 0, 0], surfaceY: -10, floorY: -10 };
const settle = (rope: Rope, from: Vec3, to: Vec3, length: number, forces: RopeForces = still, seconds = 4) => {
  for (let index = 0; index < seconds * 60; index += 1) rope.step(from, to, length, 1 / 60, forces);
};
const lengthOf = (rope: Rope) => {
  let total = 0;
  for (let index = 0; index < ROPE_SEGMENTS; index += 1) {
    const a = rope.point(index);
    const b = rope.point(index + 1);
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return total;
};

describe('软绳', () => {
  test('有余量就自然下垂，线长不变，首尾钉在挂线点上', () => {
    const rope = new Rope();
    const from: Vec3 = [0, 2, 0];
    const to: Vec3 = [1, 2, 0];
    settle(rope, from, to, 1.2);
    expect(rope.point(0)).toEqual(from);
    expect(rope.point(ROPE_SEGMENTS)).toEqual(to);
    expect(rope.point(ROPE_SEGMENTS / 2)[1]).toBeLessThan(1.8);
    expect(lengthOf(rope)).toBeCloseTo(1.2, 1);
  });

  test('两端拉开到线长就绷直，不会被拉长', () => {
    const rope = new Rope();
    settle(rope, [0, 2, 0], [1, 2, 0], 1.2);
    settle(rope, [0, 2, 0], [1.5, 2, 0], 1.2, still, 0.1);
    for (let index = 0; index <= ROPE_SEGMENTS; index += 1) expect(rope.point(index)[1]).toBeCloseTo(2, 9);
  });

  test('碰到底面就躺在底上，不穿下去', () => {
    const rope = new Rope();
    settle(rope, [0, 0.3, 0], [0.2, 0.3, 0], 1.0, { ...still, floorY: 0.05 });
    let lowest = Infinity;
    for (let index = 0; index <= ROPE_SEGMENTS; index += 1) lowest = Math.min(lowest, rope.point(index)[1]);
    expect(lowest).toBeGreaterThanOrEqual(0.05);
    expect(lowest).toBeLessThan(0.06);
  });

  test('走水：水下的线被水流吹向下游；水面以上不受影响', () => {
    const calm = new Rope();
    const drift = new Rope();
    const water: RopeForces = { gravity: -1, current: [0, 0, 0], surfaceY: 5, floorY: -10 };
    // 斜着的线（竿梢那侧高、铅坠那侧低）：静水里往下垂，走水时被推向下游（+X）。
    settle(calm, [0, 2, 0], [0.5, 0, 0], 2.3, water);
    settle(drift, [0, 2, 0], [0.5, 0, 0], 2.3, { ...water, current: [2, 0, 0] });
    expect(drift.point(ROPE_SEGMENTS / 2)[0]).toBeGreaterThan(calm.point(ROPE_SEGMENTS / 2)[0] + 0.2);
  });

  test('同样的 dt 序列得到同样的形状', () => {
    const run = () => {
      const rope = new Rope();
      settle(rope, [0, 2, 0], [1, 1.5, 0.3], 1.4, still, 1);
      return Array.from(rope.nodes);
    };
    expect(run()).toEqual(run());
  });

  test('多出来的线顺滑地垂成弧，不挤成锯齿（相邻两截的折角都很小）', () => {
    const turns = (forces: RopeForces, from: Vec3, to: Vec3, length: number) => {
      const rope = new Rope();
      settle(rope, from, to, length, forces);
      let worst = 0;
      for (let index = 1; index < ROPE_SEGMENTS; index += 1) {
        const [a, b, c] = [rope.point(index - 1), rope.point(index), rope.point(index + 1)];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
        const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v));
        worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, cos))));
      }
      return (worst * 180) / Math.PI;
    };
    // 空气里的主线：竿梢 → 漂，4% 余量。
    expect(turns(still, [0.85, 2.3, 0.5], [0, 1.6, 0], Math.hypot(0.85, 0.7, 0.5) * 1.04)).toBeLessThan(25);
    // 水里的子线：钝时多出 30% 线长，轻重力。
    expect(turns({ gravity: -1.2, current: [0, 0, 0], surfaceY: 5, floorY: 0.08 }, [0, 0.5, 0], [0.14, 0.2, 0], 0.45)).toBeLessThan(35);
  });

  test('柔：端点被猛拖时线先滞后再停稳（不是瞬间变形）', () => {
    const rope = new Rope();
    const water: RopeForces = { gravity: -1.2, current: [0, 0, 0], surfaceY: 5, floorY: -10 };
    settle(rope, [0, 1, 0], [0.3, 0.4, 0], 0.9, water);
    const before = rope.point(ROPE_SEGMENTS / 2);
    // 挪到 (0.5, 0.4)：弦 0.78 < 线长 0.9，线仍有余量（拉满的线本来就该立刻绷直）。
    rope.step([0, 1, 0], [0.5, 0.4, 0], 0.9, 1 / 60, water);
    const lagging = rope.point(ROPE_SEGMENTS / 2);
    settle(rope, [0, 1, 0], [0.5, 0.4, 0], 0.9, water);
    const settled = rope.point(ROPE_SEGMENTS / 2);
    // 一帧之后还没追上最终形状，几秒后停稳。
    expect(Math.hypot(lagging[0] - settled[0], lagging[1] - settled[1])).toBeGreaterThan(0.01);
    expect(Math.hypot(before[0] - settled[0], before[1] - settled[1])).toBeGreaterThan(0.05);
  });

  test('两根子线各往自己一侧松，不交叉', () => {
    const water: RopeForces = { gravity: -1.2, current: [0, 0, 0], surfaceY: 5, floorY: 0.08 };
    const upper = new Rope();
    const lower = new Rope();
    settle(upper, [0, 0.5, 0], [-0.14, 0.12, 0], 0.6, { ...water, spread: [-2, 0, 0] });
    settle(lower, [0, 0.5, 0], [0.14, 0.12, 0], 0.7, { ...water, spread: [2, 0, 0] });
    for (let index = 1; index < ROPE_SEGMENTS; index += 1) {
      expect(upper.point(index)[0]).toBeLessThan(lower.point(index)[0]);
    }
  });
});
