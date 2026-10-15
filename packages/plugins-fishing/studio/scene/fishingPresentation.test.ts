import { describe, expect, test } from 'vitest';
import { liftWindowOf } from '@twin-platform/plugins-fishing';
import { MAX_FLOAT_DROP } from './floatSignal';
import { createFishingViewFixture as setup } from './sceneFixture';

describe('抛竿 / 入水 / 鱼口的实际钓组表现', () => {
  test('向导从双钩到单饵承接测量目数，不被旧钓目覆盖', () => {
    const run = setup();
    try {
      run.attrs({ t0: 8, t: 6, w: 1.5, d: 4, drift: false, rigPhase: 'measure_t0', setupMarks: 4.5 });
      run.frame();
      const markH = run.meshes.get('float-01')!.userData.waterline.markH as number;
      let previous = run.anchor('float-01').y;
      for (const [phase, marks] of [['measure_t', 3.5], ['measure_w', 2.5], ['measure_w', 1.5]] as const) {
        run.attrs({ rigPhase: phase, setupMarks: marks });
        run.frame();
        const current = run.anchor('float-01').y;
        expect(previous - current).toBeCloseTo(markH, 9);
        expect(run.world.getEntity('rig-01')!.attrs.d).toBe(4);
        expect(run.meshes.get('hook-upper-01')!.visible).toBe(true);
        expect(run.meshes.get('hook-lower-01')!.visible).toBe(true);
        expect(run.meshes.get('bait-upper-01')!.visible).toBe(false);
        expect(run.meshes.get('bait-lower-01')!.visible).toBe(phase === 'measure_w');
        previous = current;
      }
    } finally {
      run.dispose();
    }
  });

  test('无测量预览值时按阶段取 t0、t、t-w；找底和作钓仍取 d', () => {
    const run = setup();
    try {
      run.attrs({ t0: 4.5, t: 3.5, w: 1, d: 4, drift: false, rigPhase: 'measure_t0' });
      run.frame();
      const markH = run.meshes.get('float-01')!.userData.waterline.markH as number;
      const initial = run.anchor('float-01').y;
      for (const [phase, marks] of [['measure_t', 3.5], ['measure_w', 2.5]] as const) {
        run.attrs({ rigPhase: phase });
        run.frame();
        expect(initial - run.anchor('float-01').y).toBeCloseTo((4.5 - marks) * markH, 9);
      }
      for (const phase of ['find_bottom', 'fishing']) {
        run.attrs({ rigPhase: phase, setupMarks: 1, inWater: true });
        run.frame();
        expect(initial - run.anchor('float-01').y).toBeCloseTo(0.5 * markH, 9);
      }
    } finally {
      run.dispose();
    }
  });

  test('未抛竿与收竿不再显示水下钓组；测量和找底预览仍显示', () => {
    const run = setup();
    run.frame();
    for (const id of ['rig-01', 'float-01', 'sinker-01', 'hook-lower-01', 'bait-lower-01']) expect(run.meshes.get(id)?.visible, id).toBe(false);
    expect(run.meshes.get('rod-01')?.visible).toBe(true);
    for (const phase of ['measure_t0', 'find_bottom']) {
      run.attrs({ rigPhase: phase });
      run.frame();
      expect(run.meshes.get('float-01')?.visible).toBe(true);
      expect(run.meshes.get('rig-01')?.visible).toBe(true);
    }
    run.attrs({ rigPhase: 'fishing', inWater: true, castAt: 0, casts: 1 });
    run.frame();
    expect(run.meshes.get('float-01')?.visible).toBe(true);
    run.attrs({ inWater: false, pendingBite: false, signal: 'none' });
    run.frame();
    expect(run.meshes.get('rig-01')?.visible).toBe(false);
    expect(run.biter().visible).toBe(false);
    run.dispose();
  });

  test('新抛竿的漂钩从水面附近入水，再下沉至真实布局，钓线始终接着对应挂点', () => {
    const run = setup();
    run.attrs({ inWater: true, castAt: 0, casts: 1 });
    run.frame();
    const entry = run.anchor('hook-lower-01').y;
    expect(entry).toBeGreaterThan(1.8);
    run.world.runSteps(24);
    run.frame();
    expect(run.anchor('hook-lower-01').y).toBeLessThan(entry);
    run.world.runSteps(36);
    run.frame();
    expect(run.anchor('hook-lower-01').y).toBeLessThan(0.5);
    for (const [key, line] of run.lines()) {
      const [from, to] = key.split('->');
      expect(line.from.distanceTo(run.anchor(from!))).toBeLessThan(1e-8);
      expect(line.to.distanceTo(run.anchor(to!))).toBeLessThan(1e-8);
    }
    run.dispose();
  });

  test('延迟黑漂按 biteUntil 还原当前口龄，鱼、饵、钩、线同步，漂下沉仍受浮力上限约束', () => {
    const run = setup();
    run.world.runSteps(60 * 4);
    run.attrs({ inWater: true, castAt: 0, casts: 1, bites: 0, signal: 'none' });
    run.frame();
    const idleFloat = run.anchor('float-01').y;
    run.attrs({ bites: 1, signal: 'sink', bitHook: 'lower', pendingBite: true, biteUntil: run.world.time + liftWindowOf('sink') - 0.6 });
    run.frame();
    const drop = idleFloat - run.anchor('float-01').y;
    expect(drop).toBeGreaterThan(0.1);
    expect(drop).toBeLessThanOrEqual(MAX_FLOAT_DROP.sink + 1e-6);
    expect(run.biter().visible).toBe(true);
    expect(run.anchor('hook-lower-01').x).toBeGreaterThan(0.3);
    for (const [key, line] of run.lines()) {
      const [from, to] = key.split('->');
      expect(line.from.distanceTo(run.anchor(from!))).toBeLessThan(1e-8);
      expect(line.to.distanceTo(run.anchor(to!))).toBeLessThan(1e-8);
    }
    run.attrs({ signal: 'none', pendingBite: false });
    run.frame();
    expect(run.biter().visible).toBe(false);
    expect(run.anchor('float-01').y).toBeCloseTo(idleFloat, 9);
    run.dispose();
  });

  test('暂停不推进世界，多次 update 不受历史帧影响；seek 相同快照恢复相同节点', () => {
    const run = setup();
    run.world.runSteps(120);
    run.attrs({ inWater: true, castAt: 0, casts: 1, bites: 1, drift: true, pendingBite: true, signal: 'run', bitHook: 'upper', biteUntil: run.world.time + liftWindowOf('run') - 0.5 });
    const snapshot = run.world.snapshot();
    run.frame();
    const original = run.fingerprint();
    const lines = run.lines();
    run.frame();
    expect(run.fingerprint()).toEqual(original);
    expect(run.lines()).toEqual(lines);
    run.frame();
    expect(run.fingerprint()).toEqual(original);
    run.world.runSteps(12);
    run.frame();
    expect(run.fingerprint()).not.toEqual(original);
    run.world.restore(snapshot);
    run.frame();
    expect(run.fingerprint()).toEqual(original);
    expect(run.lines()).toEqual(lines);
    run.dispose();
  });
});
