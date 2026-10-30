import { describe, expect, test } from 'bun:test';
import { DecisionEngine, summarizeDecisions } from '@twin-platform/decision-core';
import { FISHING_ACTIONS, FISHING_ACTION_IDS } from './actionSpace';
import { createFishingDomain, fishingDomain } from './domain';
import { calculateRigState, type TaidiaoInput } from './fishingCore';
import type { Judge } from '@twin-platform/decision-core';
import type { FishingActionId } from './actionSpace';
import { toFishingState, type FishingContextInput, type FishingState } from './state';

const build = (rig: TaidiaoInput, context: FishingContextInput): FishingState => {
  const result = calculateRigState(rig);
  if (!result.ok) throw new Error('测试钓组不合法');
  return toFishingState(result.state, context);
};

const SENSITIVE: TaidiaoInput = { t0: 4, t: 2, w: 1, d: 1 };

describe('fishingDomain', () => {
  test('规则 Judge 的输出全部落在封闭动作空间内', async () => {
    const intents: FishingContextInput[] = [
      {},
      { intent: 'no_bite' },
      { intent: 'bite_no_catch' },
      { drift: true },
    ];
    for (const context of intents) {
      const state = build(SENSITIVE, context);
      const verdict = fishingDomain.policy.validate(state, await fishingDomain.judge.judge(state, { now: 0 }));
      expect(verdict.ok).toBe(true);
    }
  });

  test('降级动作必须属于动作空间', () => {
    const state = build(SENSITIVE, {});
    const fallback = fishingDomain.fallback(state, 'UNKNOWN_ACTION');
    expect(FISHING_ACTION_IDS).toContain(fallback.action);
  });

  test('动作空间里有可逆与不可逆动作', () => {
    expect(FISHING_ACTIONS.some((action) => action.reversible)).toBe(true);
    expect(FISHING_ACTIONS.some((action) => !action.reversible)).toBe(true);
  });

  test('引擎端到端：判断被接受且可评测', async () => {
    const engine = new DecisionEngine(fishingDomain);
    const record = await engine.decide(build(SENSITIVE, { intent: 'bite_no_catch' }), { at: 12 });
    expect(record.accepted).toBe(true);
    expect(record.decision.action).toBe('ADJUST_FLOAT');
    expect(record.stateHash).toHaveLength(8);

    engine.decisionLog.attachOutcome(record.id, { at: 20, metrics: { biteRate: 0.4 } });
    const summary = summarizeDecisions(engine.decisionLog.all());
    expect(summary.total).toBe(1);
    expect(summary.byAction['ADJUST_FLOAT']).toBe(1);
  });

  test('换 Judge 即换判断源：非法输出被降级', async () => {
    const broken: Judge<FishingState, FishingActionId> = {
      id: 'broken',
      judge: () => ({ action: 'TELEPORT' as FishingActionId, params: {}, confidence: 0.99, reasonCode: 'NONSENSE' }),
    };
    const engine = new DecisionEngine(createFishingDomain(broken));
    const record = await engine.decide(build(SENSITIVE, {}));
    expect(record.accepted).toBe(false);
    expect(record.degradeReason).toBe('UNKNOWN_ACTION');
    expect(record.decision.action).toBe('OBSERVE');
  });
});
