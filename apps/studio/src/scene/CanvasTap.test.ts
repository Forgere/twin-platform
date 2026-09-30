import { describe, expect, test } from 'vitest';
import { CanvasTap } from './CanvasTap';

const point = (pointerId = 1, clientX = 100, clientY = 100, button = 0) => ({ pointerId, clientX, clientY, button });

describe('canvas touch selection', () => {
  test('selects one short tap, including native non-enumerable event properties', () => {
    const tap = new CanvasTap();
    tap.down(Object.create(point()));
    expect(tap.up(point(1, 103))).toBe(true);
    expect(tap.up(point())).toBe(false);
  });

  test('rotation returning to its origin is not a tap', () => {
    const tap = new CanvasTap();
    tap.down(point());
    tap.move(point(1, 150));
    tap.move(point());
    expect(tap.up(point())).toBe(false);
  });

  test('a long move without an intermediate event is not a tap', () => {
    const tap = new CanvasTap();
    tap.down(point());
    expect(tap.up(point(1, 150))).toBe(false);
  });

  test('pinch, third finger, and re-touch before all fingers lift never select', () => {
    const tap = new CanvasTap();
    tap.down(point());
    tap.down(point(2));
    tap.down(point(3));
    expect(tap.up(point(2))).toBe(false);
    tap.down(point(4));
    expect(tap.up(point(1))).toBe(false);
    expect(tap.up(point(3))).toBe(false);
    expect(tap.up(point(4))).toBe(false);
    tap.down(point(5));
    expect(tap.up(point(5))).toBe(true);
  });

  test('cancel clears selection and permits the next tap', () => {
    const tap = new CanvasTap();
    tap.down(point());
    tap.cancel(point());
    expect(tap.up(point())).toBe(false);
    tap.down(point(2));
    expect(tap.up(point(2))).toBe(true);
  });

  test('right button pan does not select', () => {
    const tap = new CanvasTap();
    tap.down(point(1, 100, 100, 2));
    expect(tap.up(point(1, 100, 100, 2))).toBe(false);
  });
});
