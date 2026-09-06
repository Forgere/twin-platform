import { describe, expect, test } from 'bun:test';
import { resolveExternalMotion, signalRequiresPath, type ExternalMotionContext } from './external';

const ctx: ExternalMotionContext = {
  time: 10,
  pathLength: 20,
  speed: 2,
  origin: [10, 0, 0],
  yaw: 0,
};

describe('resolveExternalMotion / pose', () => {
  test('world 帧直接给世界位姿', () => {
    const resolved = resolveExternalMotion({ kind: 'pose', frame: 'world', position: [1, 2, 3], heading: 0.5 }, ctx);
    expect(resolved.position).toEqual([1, 2, 3]);
    expect(resolved.heading).toBe(0.5);
  });

  test('local 帧以实体原点 + 偏航换算到世界', () => {
    const resolved = resolveExternalMotion({ kind: 'pose', frame: 'local', position: [1, 0, 0] }, ctx);
    expect(resolved.position?.[0]).toBeCloseTo(11, 9);
    expect(resolved.position?.[2]).toBeCloseTo(0, 9);
  });

  test('local 帧偏航 90° 后 +X 变成 -Z', () => {
    const rotated = resolveExternalMotion({ kind: 'pose', frame: 'local', position: [1, 0, 0] }, { ...ctx, yaw: Math.PI / 2 });
    expect(rotated.position?.[0]).toBeCloseTo(10, 9);
    expect(rotated.position?.[2]).toBeCloseTo(-1, 9);
    expect(rotated.heading).toBeCloseTo(Math.PI / 2, 9);
  });

  test('未声明 frame 时默认 local', () => {
    const resolved = resolveExternalMotion({ kind: 'pose', position: [1, 0, 0] }, ctx);
    expect(resolved.position?.[0]).toBeCloseTo(11, 9);
  });
});

describe('resolveExternalMotion / 路径驱动信号', () => {
  test('progress 乘路径长度，且被钳制到 [0,1]', () => {
    expect(resolveExternalMotion({ kind: 'progress', progress: 0.5 }, ctx).distance).toBeCloseTo(10, 9);
    expect(resolveExternalMotion({ kind: 'progress', progress: 2 }, ctx).distance).toBeCloseTo(20, 9);
    expect(resolveExternalMotion({ kind: 'progress', progress: -1 }, ctx).distance).toBeCloseTo(0, 9);
  });

  test('entry 由内核用自己的速度推进', () => {
    expect(resolveExternalMotion({ kind: 'entry', tEnter: 8 }, ctx).distance).toBeCloseTo(4, 9);
    expect(resolveExternalMotion({ kind: 'entry', tEnter: 12 }, ctx).distance).toBeCloseTo(0, 9);
  });

  test('span 在区间内线性插值，区间外钳制', () => {
    expect(resolveExternalMotion({ kind: 'span', tEnter: 5, tExit: 15 }, ctx).distance).toBeCloseTo(10, 9);
    expect(resolveExternalMotion({ kind: 'span', tEnter: 5, tExit: 15 }, { ...ctx, time: 20 }).distance).toBeCloseTo(20, 9);
    expect(resolveExternalMotion({ kind: 'span', tEnter: 5, tExit: 5 }, ctx).distance).toBeCloseTo(20, 9);
  });

  test('需要路径的信号被标记出来，便于校验场景配置', () => {
    expect(signalRequiresPath({ kind: 'progress', progress: 0 })).toBe(true);
    expect(signalRequiresPath({ kind: 'entry', tEnter: 0 })).toBe(true);
    expect(signalRequiresPath({ kind: 'span', tEnter: 0, tExit: 1 })).toBe(true);
    expect(signalRequiresPath({ kind: 'pose', position: [0, 0, 0] })).toBe(false);
  });
});
