import { describe, expect, test } from 'bun:test';
import { buildPath, filletPolyline, samplePath } from './path';

const straight: [number, number, number][] = [
  [0, 0, 0],
  [10, 0, 0],
];

const lShape: [number, number, number][] = [
  [0, 0, 0],
  [10, 0, 0],
  [10, 0, 10],
];

describe('buildPath / samplePath', () => {
  test('直线长度与中点正确，偏航沿 +X 为 π/2', () => {
    const path = buildPath(straight);
    expect(path.length).toBeCloseTo(10, 9);
    const sample = samplePath(path, 5);
    expect(sample.position[0]).toBeCloseTo(5, 9);
    expect(sample.position[1]).toBeCloseTo(0, 9);
    expect(sample.heading).toBeCloseTo(Math.PI / 2, 9);
  });

  test('距离被钳制在 [0, length]，越界不抛错', () => {
    const path = buildPath(straight);
    expect(samplePath(path, -5).position[0]).toBeCloseTo(0, 9);
    expect(samplePath(path, 999).position[0]).toBeCloseTo(10, 9);
  });

  test('L 形路径长度≈两段之和，圆角只吃掉折角', () => {
    const path = buildPath(lShape, { cornerRadius: 0.5 });
    expect(path.length).toBeGreaterThan(19);
    expect(path.length).toBeLessThanOrEqual(20);
  });

  test('直段保持笔直：圆角前后采样点仍在 z=0 上', () => {
    const path = buildPath(lShape, { cornerRadius: 0.5 });
    for (const distance of [0, 1, 2, 3, 8, 9]) {
      expect(samplePath(path, distance).position[2]).toBeCloseTo(0, 6);
    }
  });

  test('退化路径不会炸', () => {
    const path = buildPath([[1, 2, 3]]);
    expect(path.length).toBe(0);
    expect(samplePath(path, 5).position).toEqual([1, 2, 3]);
  });
});

describe('filletPolyline', () => {
  test('少于三个点原样返回副本', () => {
    const result = filletPolyline(straight);
    expect(result).toEqual(straight);
    expect(result[0]).not.toBe(straight[0]);
  });

  test('半径为 0 时保持尖角，段数不增加太多', () => {
    const result = filletPolyline(lShape, 0);
    expect(result).toHaveLength(4);
  });

  test('圆角会密化折角', () => {
    const result = filletPolyline(lShape, 0.5, 6);
    expect(result.length).toBeGreaterThan(3);
  });
});
