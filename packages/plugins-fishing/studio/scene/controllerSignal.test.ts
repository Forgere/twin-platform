import { afterEach, describe, expect, test } from 'vitest';
import { createFishingViewFixture } from './sceneFixture';

const allocated: ReturnType<typeof createFishingViewFixture>[] = [];
afterEach(() => { for (const run of allocated.splice(0)) run.dispose(); });

/** 通过真实展示接口观察枢轴与鱼，不窥探控制器内部的动画参数。 */
const setup = (attrs: Record<string, string | number | boolean>, time = 0) => {
  const run = createFishingViewFixture();
  allocated.push(run);
  run.attrs({ manualCast: false, inWater: true, ...attrs });
  run.world.runSteps(Math.round(time * 60));
  return run;
};

describe('真实鱼口触发 3D 漂相', () => {
  test('手动抛竿后的延迟鱼口不依赖 casts 变化，重复更新不重启', () => {
    const run = setup({ manualCast: true, casts: 1, bites: 0, pendingBite: false, biteUntil: 0, signal: 'none', bitHook: 'upper' }, 3.1);
    run.frame();
    const idle = run.anchor('hook-upper-01');
    run.attrs({ bites: 1, signal: 'nod', pendingBite: true, biteUntil: 4.6 });
    run.frame();
    expect(run.anchor('hook-upper-01').distanceTo(idle)).toBeGreaterThan(0.001);
    expect(run.biter().visible).toBe(true);
    const first = run.fingerprint();
    run.frame();
    expect(run.fingerprint()).toEqual(first);
    expect(run.world.getEntity('rig-01')?.attrs.casts).toBe(1);
  });

  test('计数本身不重启旧口，signal 清除立即回位', () => {
    const run = setup({ casts: 1, bites: 1, signal: 'sink', nextAt: 6 }, 3.1);
    run.frame();
    const first = run.fingerprint();
    run.attrs({ casts: 2 });
    run.frame();
    expect(run.fingerprint()).toEqual(first);
    run.attrs({ signal: 'none' });
    run.frame();
    expect(run.biter().visible).toBe(false);
    expect(run.fingerprint()).not.toEqual(first);
  });

  test('首次加载不补播过期的口；seek 回当前口中间恢复相同姿态', () => {
    const run = setup({ casts: 3, bites: 2, signal: 'run', nextAt: 9 }, 6.4);
    const snapshot = run.world.snapshot();
    run.frame();
    const first = run.fingerprint();
    expect(run.biter().visible).toBe(true);
    run.world.runSteps(168);
    run.frame();
    expect(run.biter().visible).toBe(false);
    run.world.restore(snapshot);
    run.frame();
    expect(run.fingerprint()).toEqual(first);
  });

  test('旧自动场景无 biteUntil，通过 nextAt 恢复实际鱼口', () => {
    const run = setup({ casts: 1, signal: 'lift', nextAt: 3 }, 0.2);
    run.frame();
    const lifted = run.anchor('float-01').y;
    expect(run.biter().visible).toBe(true);
    run.attrs({ signal: 'none' });
    run.frame();
    expect(lifted).toBeGreaterThan(run.anchor('float-01').y);
  });

  test('不完整旧数据没有有效时间戳，不凭渲染首帧杜撰鱼口', () => {
    const run = setup({ casts: 4, signal: 'nod', nextAt: 0 }, 10);
    run.frame();
    expect(run.biter().visible).toBe(false);
    const before = run.anchor('float-01');
    run.attrs({ signal: 'none' });
    run.frame();
    expect(run.anchor('float-01').toArray()).toEqual(before.toArray());
  });
});
