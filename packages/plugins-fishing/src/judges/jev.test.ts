import { describe, expect, test } from 'bun:test';
import { DecisionEngine, buildCalibration, compareJudges } from '@twin-platform/decision-core';
import { createFishingDomain, fishingDomain } from '../domain';
import { calculateRigState, type TaidiaoInput } from '../fishingCore';
import type { JevClient, JevDecision } from '../jevClient';
import { toFishingState, type FishingContextInput } from '../state';
import { createJevJudge } from './jev';

const build = (rig: TaidiaoInput, context: FishingContextInput = {}) => {
  const result = calculateRigState(rig);
  if (!result.ok) throw new Error('测试钓组不合法');
  return toFishingState(result.state, context);
};

const SENSITIVE: TaidiaoInput = { t0: 4, t: 2, w: 1, d: 1 };

const client = (decision: Partial<JevDecision>): JevClient => ({
  id: 'fake-jev',
  decide: async () => ({ actionConfidence: 0.7, observeProbability: 0, ...decision }),
});

describe('createJevJudge', () => {
  test('把 Jev 的 choice 映射成合法决策，方向来自 Jev、幅度由代码兜底', async () => {
    const judge = createJevJudge(client({ action: 'ADJUST_FLOAT', floatDirection: 'blunt', actionConfidence: 0.83 }));
    const state = build(SENSITIVE, { intent: 'bite_no_catch' });
    const decision = await judge.judge(state, { now: 0 });
    expect(decision.action).toBe('ADJUST_FLOAT');
    expect(decision.params['direction']).toBe('blunt');
    expect(decision.params['steps']).toBe(1); // 幅度是代码缺省，不是 Jev 给的
    expect(decision.confidence).toBeCloseTo(0.83, 6);

    const verdict = fishingDomain.policy.validate(state, decision);
    expect(verdict.ok).toBe(true);
  });

  test('Jev 没说方向时，按灵钝状态给保守缺省', async () => {
    const judge = createJevJudge(client({ action: 'ADJUST_FLOAT' }));
    const blunt = await judge.judge(build({ t0: 4, t: 2, w: 1, d: 3 }), { now: 0 });
    expect(blunt.params['direction']).toBe('sensitive');
    const sensitive = await judge.judge(build(SENSITIVE), { now: 0 });
    expect(sensitive.params['direction']).toBe('blunt');
  });

  test('needs_observe 高概率时退到继续观察', async () => {
    const judge = createJevJudge(client({ action: 'CHANGE_SPOT', observeProbability: 0.9 }));
    const decision = await judge.judge(build(SENSITIVE), { now: 0 });
    expect(decision.action).toBe('OBSERVE');
    expect(decision.reasonCode).toBe('JEV_NEEDS_OBSERVE');
  });

  test('请求失败不猜动作，退到继续观察', async () => {
    const failing: JevClient = {
      id: 'down',
      decide: async () => {
        throw new Error('offline');
      },
    };
    const decision = await createJevJudge(failing).judge(build(SENSITIVE), { now: 0 });
    expect(decision.action).toBe('OBSERVE');
    expect(decision.reasonCode).toBe('JEV_UNAVAILABLE');
  });

  test('动作空间之外的返回交给 Policy 拒绝，引擎降级', async () => {
    const engine = new DecisionEngine(createFishingDomain(createJevJudge(client({ action: 'TELEPORT' }))));
    const record = await engine.decide(build(SENSITIVE));
    expect(record.accepted).toBe(false);
    expect(record.degradeReason).toBe('UNKNOWN_ACTION');
    expect(record.decision.action).toBe('OBSERVE');
  });

  test('规则 vs Jev 可对比，且置信度能进校准表', async () => {
    const jevDomain = createFishingDomain(createJevJudge(client({ action: 'ADJUST_FLOAT' })));
    const states = [build(SENSITIVE, { intent: 'bite_no_catch' }), build({ t0: 4, t: 2, w: 1, d: 3 }, { intent: 'no_bite' })];

    const comparison = await compareJudges(fishingDomain, jevDomain, states);
    expect(comparison.states).toBe(2);
    expect(comparison.agreement).toBeGreaterThanOrEqual(0);
    expect(comparison.agreement).toBeLessThanOrEqual(1);

    const engine = new DecisionEngine(jevDomain);
    for (const state of states) await engine.decide(state, { at: 0 });
    const table = buildCalibration(engine.decisionLog.all(), { methodId: 'jev', success: (record) => record.decision.action === 'ADJUST_FLOAT' });
    expect(table.methodId).toBe('jev');
    expect(table.total).toBe(2);
    expect(table.decided).toBe(2);
  });
});
