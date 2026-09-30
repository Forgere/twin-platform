import { describe, expect, test } from 'vitest';
import { floatSignalPose, MARK, SIGNAL_DURATION } from './floatSignal';

const peak = (signal: Parameters<typeof floatSignalPose>[0], key: 'dy' | 'dx') => {
  let best = 0;
  for (let t = 0; t < SIGNAL_DURATION; t += 0.01) {
    const value = floatSignalPose(signal, t)[key];
    if (Math.abs(value) > Math.abs(best)) best = value;
  }
  return best;
};

describe('漂相动作', () => {
  test('顿口下顿约 1 目，送漂上顶约 2 目，黑漂整支没入（超过漂尾 5 目）', () => {
    expect(peak('nod', 'dy')).toBeCloseTo(-MARK, 5);
    expect(peak('lift', 'dy')).toBeCloseTo(MARK * 2, 5);
    expect(peak('sink', 'dy')).toBeLessThan(-MARK * 5);
    expect(peak('run', 'dx')).toBeGreaterThan(0);
  });

  test('无信号、开始前、结束后都停在静止位', () => {
    for (const [signal, t] of [['none', 0.5], ['nod', -0.1], ['sink', SIGNAL_DURATION]] as const) {
      expect(floatSignalPose(signal, t)).toEqual({ dy: 0, dx: 0, tilt: 0 });
    }
    // 回位是连续的：结束前一刻已经接近静止。
    expect(Math.abs(floatSignalPose('sink', SIGNAL_DURATION - 0.01).dy)).toBeLessThan(0.01);
  });
});

describe('钩被鱼拖', () => {
  test('黑漂拖得最远，送漂把钩饵往上托，无口不动', async () => {
    const { hookPullPose } = await import('./floatSignal');
    const at = (signal: Parameters<typeof hookPullPose>[0]) => hookPullPose(signal, 0.6);
    expect(at('sink').out).toBeGreaterThan(at('nod').out);
    expect(at('lift').dy).toBeGreaterThan(0.1);
    expect(hookPullPose('none', 0.6)).toEqual({ out: 0, dy: 0, shake: 0 });
    expect(hookPullPose('sink', SIGNAL_DURATION)).toEqual({ out: 0, dy: 0, shake: 0 });
  });
});
