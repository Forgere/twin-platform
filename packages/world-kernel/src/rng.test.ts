import { describe, expect, test } from 'bun:test';
import { createRng } from './rng';

describe('createRng', () => {
  test('同种子产生同序列', () => {
    const a = createRng(42);
    const b = createRng(42);
    const left = Array.from({ length: 16 }, () => a.next());
    const right = Array.from({ length: 16 }, () => b.next());
    expect(left).toEqual(right);
  });

  test('不同种子产生不同序列', () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(a.next()).not.toBe(b.next());
  });

  test('输出落在 [0,1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test('int / range / bool 行为正确', () => {
    const rng = createRng(11);
    for (let i = 0; i < 200; i += 1) {
      const value = rng.int(5);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(5);
      const scoped = rng.range(-2, 3);
      expect(scoped).toBeGreaterThanOrEqual(-2);
      expect(scoped).toBeLessThan(3);
    }
    expect(createRng(3).bool(1)).toBe(true);
    expect(createRng(3).bool(0)).toBe(false);
  });

  test('weighted 尊重权重，全零权重退化为等概率', () => {
    const rng = createRng(2024);
    const items = ['a', 'b', 'c'];
    const weights = { a: 0, b: 1, c: 0 };
    for (let i = 0; i < 50; i += 1) expect(rng.weighted(items, (item) => weights[item])).toBe('b');

    const fair = createRng(5);
    const picks = new Set(Array.from({ length: 60 }, () => fair.weighted(items, () => 0)));
    expect(picks.size).toBeGreaterThan(1);
  });

  test('状态可导出并恢复，用于快照续算', () => {
    const rng = createRng(99);
    rng.next();
    rng.next();
    const state = rng.getState();
    const expected = [rng.next(), rng.next(), rng.next()];

    rng.setState(state);
    expect([rng.next(), rng.next(), rng.next()]).toEqual(expected);
  });

  test('空数组与非法种子直接抛错，不静默返回', () => {
    expect(() => createRng(1).pick([])).toThrow();
    expect(() => createRng(Number.NaN)).toThrow(/seed/);
  });
});
