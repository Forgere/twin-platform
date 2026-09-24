import { describe, expect, test } from 'vitest';
import { calculateRigState, rigPosture, type TaidiaoInput } from '@twin-platform/plugins-fishing';
import { rigVisualPose } from './rigVisual';

/** t0=4, w=1 时底承重 B = d + 2 − t：d 小 → 离底，d 大 → 越来越钝直到走铅。 */
const postureAt = (t: number, d = 2) => {
  const input: TaidiaoInput = { t0: 4, t, w: 1, d };
  const result = calculateRigState(input);
  if (!result.ok) throw new Error('bad input');
  return rigPosture(result.state);
};

describe('钓组水下姿态随调钓状态变化', () => {
  test('越钝：钩躺得越平、饵越扁、子线越弯；离底时全部悬垂绷直', () => {
    const zones = [0.5, 3, 4, 5, 7].map((d) => [postureAt(3, d).zone, rigVisualPose(postureAt(3, d), 'none', 0)] as const);
    const [offBottom] = zones;
    expect(offBottom[0]).toBe('off_bottom');
    expect(offBottom[1].hooks.lower.lie).toBe(0);
    expect(offBottom[1].bend.lower).toBe(0);
    expect(offBottom[1].sinkerLie).toBe(0);

    const blunt = zones[zones.length - 1][1];
    expect(blunt.hooks.lower.lie).toBe(1);
    expect(blunt.baits.lower).toBeLessThan(1);
    expect(blunt.bend.lower).toBeGreaterThan(0.5);
    // 单调：越往钝走，下钩子线只会更弯。
    for (let index = 1; index < zones.length; index += 1) {
      expect(zones[index][1].bend.lower).toBeGreaterThanOrEqual(zones[index - 1][1].bend.lower);
    }
  });

  test('走铅：铅坠平躺', () => {
    const posture = postureAt(2, 6);
    expect(posture.sinker.code).toBe('on_bottom');
    expect(rigVisualPose(posture, 'none', 0).sinkerLie).toBe(1);
  });
});

describe('一口鱼沿主线传到每个零件', () => {
  const neutral = postureAt(2);

  test('黑漂：主线下移、下钩被拖远、它的子线拉直、饵被吸入；上钩不被拖', () => {
    const rest = rigVisualPose(postureAt(1), 'none', 0);
    const pose = rigVisualPose(postureAt(1), 'sink', 0.6);
    expect(pose.hooks.lower.out).toBeGreaterThan(0.3);
    expect(pose.bend.lower).toBeLessThan(rest.bend.lower);
    expect(pose.baits.lower).toBeLessThan(rest.baits.lower);
    expect(pose.hooks.lower.lie).toBeLessThan(rest.hooks.lower.lie);
    expect(pose.hooks.upper.out).toBe(0);
    expect(pose.bite).toBe(1);
    expect(rest.bite).toBe(0);
  });

  test('送漂：主线与铅坠被托起，下钩饵上浮', () => {
    const pose = rigVisualPose(neutral, 'lift', 0.8);
    expect(pose.mainDy).toBeGreaterThan(0.1);
    expect(pose.hooks.lower.dy).toBeGreaterThan(0.2);
  });

  test('顿口：悬着的铅坠跟着主线往下顿；走铅时拽不动', () => {
    expect(rigVisualPose(neutral, 'nod', 0.2).mainDy).toBeLessThan(0);
    expect(rigVisualPose(postureAt(2, 6), 'nod', 0.2).mainDy).toBe(0);
  });
});
