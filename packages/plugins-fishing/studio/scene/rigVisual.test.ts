import { describe, expect, test } from 'vitest';
import { calculateRigState, rigPosture, type TaidiaoInput } from '@twin-platform/plugins-fishing';
import { driftWobble, flowOffset, rigVisualPose } from './rigVisual';

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

describe('一口鱼：只给出"鱼怎么拖钩"，其余交给受力链', () => {
  const neutral = postureAt(2);

  test('黑漂拖得比顿口远；拖钩时躺着的下钩被提起、饵被吸入；静止弯曲不在这里改', () => {
    const rest = rigVisualPose(postureAt(3, 5), 'none', 0);
    const sink = rigVisualPose(postureAt(3, 5), 'sink', 0.6);
    const nod = rigVisualPose(postureAt(3, 5), 'nod', 0.2);
    expect(sink.drag.out).toBeGreaterThan(nod.drag.out);
    expect(sink.hooks.lower.lie).toBeLessThan(rest.hooks.lower.lie);
    expect(sink.baits.lower).toBeLessThan(rest.baits.lower);
    expect(sink.bend).toEqual(rest.bend);
    expect(sink.bite).toBe(1);
    expect(rest.bite).toBe(0);
  });

  test('只有送漂往上托（漂与主线上浮）；顿口 / 黑漂不自己动漂', () => {
    const lift = rigVisualPose(neutral, 'lift', 0.8);
    expect(lift.floatLift).toBeGreaterThan(0.1);
    expect(lift.mainLift).toBeGreaterThan(0.1);
    expect(rigVisualPose(neutral, 'nod', 0.2).floatLift).toBe(0);
    expect(rigVisualPose(neutral, 'sink', 0.6).mainLift).toBe(0);
  });
});

describe('走水', () => {
  const driftPosture = (() => {
    const result = calculateRigState({ t0: 4, t: 2, w: 1, d: 2 });
    if (!result.ok) throw new Error('bad input');
    return rigPosture(result.state, { drift: true });
  })();

  test('静水不斜；走水斜；加铅后倾角减半', () => {
    expect(rigVisualPose(postureAt(2), 'none', 0).flowTan).toBe(0);
    const drift = rigVisualPose(driftPosture, 'none', 0).flowTan;
    const anti = rigVisualPose(driftPosture, 'none', 0, { antiDrift: true }).flowTan;
    expect(drift).toBeGreaterThan(0.2);
    expect(Math.atan(anti)).toBeCloseTo(Math.atan(drift) / 2, 6);
  });

  test('漂座以上不动，以下越深推得越远', () => {
    expect(flowOffset(1.6, 1.8, 0.25)).toBe(0);
    expect(flowOffset(1.6, 0.6, 0.25)).toBeCloseTo(0.25, 9);
    expect(flowOffset(1.6, 0.2, 0.25)).toBeGreaterThan(flowOffset(1.6, 0.6, 0.25));
  });
  test('走水时漂乱晃、偶有假口般的下沉；静水不晃；同一时刻同一姿态', () => {
    expect(driftWobble(3.2, 0)).toEqual({ dx: 0, dy: 0 });
    const samples = Array.from({ length: 4000 }, (_, index) => driftWobble(index * 0.01, 0.25));
    expect(Math.max(...samples.map((sample) => Math.abs(sample.dx)))).toBeGreaterThan(0.03);
    expect(Math.min(...samples.map((sample) => sample.dy))).toBeLessThan(-0.04);
    expect(driftWobble(12.34, 0.25)).toEqual(driftWobble(12.34, 0.25));
  });
});
