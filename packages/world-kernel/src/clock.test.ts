import { describe, expect, test } from 'bun:test';
import { FixedStepClock } from './clock';

describe('FixedStepClock', () => {
  test('把真实帧间隔切成整数固定步长', () => {
    const clock = new FixedStepClock({ step: 0.1 });
    expect(clock.advance(0.25)).toBe(2);
    expect(clock.alpha).toBeCloseTo(0.5, 6);
    expect(clock.advance(0.05)).toBe(1);
    expect(clock.advance(0.01)).toBe(0);
  });

  test('只有 tick 才推进仿真时间', () => {
    const clock = new FixedStepClock({ step: 0.1 });
    clock.advance(0.35);
    expect(clock.time).toBe(0);
    clock.tick();
    clock.tick();
    expect(clock.time).toBeCloseTo(0.2, 9);
    expect(clock.stepCount).toBe(2);
  });

  test('卡顿后最多补 maxSteps 步，不雪崩', () => {
    const clock = new FixedStepClock({ step: 1 / 60, maxStepsPerAdvance: 8 });
    expect(clock.advance(10)).toBe(8);
    expect(clock.alpha).toBe(0);
  });

  test('拒绝负的或非有限的 delta', () => {
    const clock = new FixedStepClock();
    expect(() => clock.advance(-1)).toThrow(/非负/);
    expect(() => clock.advance(Number.NaN)).toThrow(/非负/);
  });

  test('reset 回到零', () => {
    const clock = new FixedStepClock({ step: 0.1 });
    clock.advance(0.5);
    clock.tick();
    clock.reset();
    expect(clock.time).toBe(0);
    expect(clock.stepCount).toBe(0);
    expect(clock.alpha).toBe(0);
  });

  test('非法步长直接抛错', () => {
    expect(() => new FixedStepClock({ step: 0 })).toThrow(/正数/);
  });
});
