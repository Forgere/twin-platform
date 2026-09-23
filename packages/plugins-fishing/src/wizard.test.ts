import { describe, expect, test } from 'bun:test';
import { wizardAdvance, wizardRigState, wizardStart, wizardSuggestPreset } from './wizard';
import { presetById } from './presets';

/**
 * 调漂向导状态机回归。
 *
 * 关键约定：
 * - 每步的用户输入非法时**不推进、给原因**，与 fishingCore 的 issue 风格一致；
 * - 预设只决定目标钓目 d，t/w 一律用实测值；
 * - 完成时 `wizardRigState()` 必须能算出合法钓组（否则写入世界时会炸）。
 */

describe('调漂向导', () => {
  test('五步完整走通：测量 -> 预设 -> 找底 -> 完成', () => {
    let state = wizardStart();
    expect(state.step).toBe('measure_t0');

    state = wizardAdvance(state, { kind: 't0', value: 6 }).state;
    expect(state.step).toBe('measure_t');

    state = wizardAdvance(state, { kind: 't', value: 4 }).state;
    expect(state.step).toBe('measure_w');

    state = wizardAdvance(state, { kind: 'w', value: 1 }).state;
    expect(state.step).toBe('choose_preset');

    state = wizardAdvance(state, { kind: 'preset', presetId: 'diao4-diao2' }).state;
    expect(state.step).toBe('find_bottom');
    // 调四钓二（d=2）在 B = d+2w−t = 0 的临界上——经典理论里这就是"下饵轻触底"，
    // 分区落在 off_bottom 边界；真实用户会继续上推找底，这里走同一流程。
    expect(state.d).toBe(2);
    expect(wizardRigState(state)?.zone).toBe('off_bottom');

    state = wizardAdvance(state, { kind: 'adjust', delta: 0.5 }).state;
    state = wizardAdvance(state, { kind: 'adjust', delta: 0.5 }).state;
    expect(state.d).toBe(3);
    expect(wizardRigState(state)?.zone).toBe('sensitive');

    const done = wizardAdvance(state, { kind: 'confirm' });
    expect(done.ok).toBe(true);
    expect(done.state.step).toBe('done');

    const rig = wizardRigState(done.state);
    expect(rig).toBeDefined();
    expect(rig?.zone).toBe('sensitive');
  });

  test('t >= t0 被拒：钩有重量，带钩调目必然更低', () => {
    let state = wizardAdvance(wizardStart(), { kind: 't0', value: 4 }).state;
    const rejected = wizardAdvance(state, { kind: 't', value: 4 });
    expect(rejected.ok).toBe(false);
    expect(rejected.issue).toContain('小于无钩调目');
    expect(rejected.state.step).toBe('measure_t');
  });

  test('t0 / w 非法值不推进', () => {
    expect(wizardAdvance(wizardStart(), { kind: 't0', value: 0 }).ok).toBe(false);
    expect(wizardAdvance(wizardStart(), { kind: 't0', value: NaN }).ok).toBe(false);

    const withT0 = wizardAdvance(wizardStart(), { kind: 't0', value: 5 }).state;
    const withT = wizardAdvance(withT0, { kind: 't', value: 3 }).state;
    expect(wizardAdvance(withT, { kind: 'w', value: 0 }).ok).toBe(false);
    expect(wizardAdvance(withT, { kind: 'w', value: Infinity }).ok).toBe(false);
  });

  test('调平水钓二：t = 0 合法（平水是真实调法），找底后能进钝区', () => {
    let state = wizardAdvance(wizardStart(), { kind: 't0', value: 2 }).state;
    state = wizardAdvance(state, { kind: 't', value: 0 }).state;
    state = wizardAdvance(state, { kind: 'w', value: 1 }).state;
    state = wizardAdvance(state, { kind: 'preset', presetId: 'ping-shui-diao2' }).state;
    expect(state.d).toBe(2);
    // t=0, w=1, d=2 → B = 2 + 2 - 0 = 4 = H+2w（H=2）→ 铅坠触底
    expect(wizardRigState(state)?.zone).toBe('sinker_on_bottom');
  });

  test('find_bottom 阶段可微调钓目，不越界', () => {
    let state = wizardAdvance(wizardStart(), { kind: 't0', value: 6 }).state;
    state = wizardAdvance(state, { kind: 't', value: 4 }).state;
    state = wizardAdvance(state, { kind: 'w', value: 1 }).state;
    state = wizardAdvance(state, { kind: 'preset', presetId: 'diao4-diao2' }).state;

    state = wizardAdvance(state, { kind: 'adjust', delta: 0.5 }).state;
    expect(state.d).toBe(2.5);
    state = wizardAdvance(state, { kind: 'adjust', delta: -2 }).state;
    expect(state.d).toBe(0.5);
    // 再往下减被夹到 0，不出负钓目
    state = wizardAdvance(state, { kind: 'adjust', delta: -1 }).state;
    expect(state.d).toBe(0);
  });

  test('预设推荐按实测单饵压目就近匹配', () => {
    let state = wizardAdvance(wizardStart(), { kind: 't0', value: 5 }).state;
    state = wizardAdvance(state, { kind: 't', value: 3 }).state;
    state = wizardAdvance(state, { kind: 'w', value: 0.8 }).state;
    expect(wizardSuggestPreset(state).id).toBe('diao3-diao1');

    // 没测完时兜底给调四钓二
    expect(wizardSuggestPreset(wizardStart()).id).toBe('diao4-diao2');
    expect(presetById('diao4-diao2')).toBeDefined();
  });

  test('错误的输入类型给明确提示', () => {
    const state = wizardAdvance(wizardStart(), { kind: 't0', value: 6 }).state;
    const wrong = wizardAdvance(state, { kind: 'w', value: 1 });
    expect(wrong.ok).toBe(false);
    expect(wrong.issue).toContain('带钩调目');
  });
});
