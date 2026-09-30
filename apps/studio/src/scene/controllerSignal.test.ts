import { describe, expect, test, vi } from 'vitest';
import { TwinSceneController } from './TwinSceneController';
import { SIGNAL_DURATION } from './floatSignal';

/** 不建 WebGL，直接执行真实控制器的鱼口追踪方法，末端只观察传给钓组姿态的参数。 */
const setup = (attrs: Record<string, unknown>, time = 0) => {
  const animateRig = vi.fn();
  const world = { time, getEntity: () => ({ attrs, config: { castInterval: 3 } }) };
  const controller = Object.assign(Object.create(TwinSceneController.prototype), {
    controller: { world }, entityMeshes: new Map(), animateRig,
  }) as { animateFloatSignal: () => void };
  return { world, animateRig, frame: () => controller.animateFloatSignal() };
};

describe('真实鱼口触发 3D 漂相', () => {
  test('手动抛竿以后才来的鱼口：casts 不变，按 biteUntil 复原口龄', () => {
    const attrs = { fishingMode: 'sim', autoLift: false, manualCast: true, inWater: true, casts: 1, bites: 0, pendingBite: false, biteUntil: 0, signal: 'none', bitHook: 'upper' };
    const { frame, animateRig } = setup(attrs, 3.1);
    frame();
    Object.assign(attrs, { bites: 1, signal: 'nod', pendingBite: true, biteUntil: 4.6 });
    frame();
    expect(animateRig).toHaveBeenLastCalledWith('nod', 'upper', expect.closeTo(0.1, 9), 1);
    frame();
    expect(animateRig).toHaveBeenLastCalledWith('nod', 'upper', expect.closeTo(0.1, 9), 1);
  });

  test('计数本身不重启旧口，signal 清除立即回位', () => {
    const attrs = { casts: 1, bites: 1, signal: 'sink', nextAt: 6 };
    const { world, frame, animateRig } = setup(attrs, 3.1);
    frame();
    attrs.casts = 2;
    world.time = 3.3;
    frame();
    expect(animateRig.mock.lastCall?.[2]).toBeCloseTo(0.3);
    attrs.signal = 'none';
    frame();
    expect(animateRig).toHaveBeenLastCalledWith('none', 'lower', SIGNAL_DURATION, 1);
  });

  test('首次加载不补播已过期的口；seek 到当前口中间显示对应姿态', () => {
    const attrs = { casts: 3, bites: 2, signal: 'run', nextAt: 9 };
    const { world, frame, animateRig } = setup(attrs, 9.2);
    frame();
    expect(animateRig).toHaveBeenLastCalledWith('none', 'lower', SIGNAL_DURATION, 1);
    world.time = 6.4;
    frame();
    expect(animateRig).toHaveBeenLastCalledWith('run', 'lower', expect.closeTo(0.4, 9), 1);
  });

  test('旧自动场景没有 biteUntil，通过 nextAt 与抛竿间隔取真实口龄', () => {
    const attrs = { casts: 1, signal: 'lift', nextAt: 3 };
    const { frame, animateRig } = setup(attrs, 0.2);
    frame();
    expect(animateRig).toHaveBeenLastCalledWith('lift', 'lower', 0.2, 1);
  });

  test('不完整旧数据没有时间戳，不凭渲染首帧杜撰新鱼口', () => {
    const { frame, animateRig } = setup({ casts: 4, signal: 'nod' }, 10);
    frame();
    expect(animateRig).toHaveBeenLastCalledWith('none', 'lower', SIGNAL_DURATION, 1);
  });
});
