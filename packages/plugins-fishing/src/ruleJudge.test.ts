import { describe, expect, test } from 'bun:test';
import { calculateRigState, type TaidiaoInput } from './fishingCore';
import { ruleJudge } from './ruleJudge';
import { toFishingState, type FishingContextInput } from './state';

const build = (rig: TaidiaoInput, context: FishingContextInput) => {
  const result = calculateRigState(rig);
  if (!result.ok) throw new Error('测试钓组不合法');
  return toFishingState(result.state, context);
};

const SENSITIVE: TaidiaoInput = { t0: 4, t: 2, w: 1, d: 1 };
const BLUNT: TaidiaoInput = { t0: 4, t: 2, w: 1, d: 3 };
const OFF_BOTTOM: TaidiaoInput = { t0: 4, t: 2, w: 1, d: 0 };

describe('ruleJudge', () => {
  test('走水优先于其它判断', () => {
    const decision = ruleJudge.judge(build(SENSITIVE, { drift: true, intent: 'no_bite' }), { now: 0 });
    expect(decision.action).toBe('ADD_LEAD');
    expect(decision.reasonCode).toBe('DRIFT_DETECTED');
  });

  test('有口不中 + 偏灵：往钝 1 目', () => {
    const decision = ruleJudge.judge(build(SENSITIVE, { intent: 'bite_no_catch' }), { now: 0 });
    expect(decision.action).toBe('ADJUST_FLOAT');
    expect(decision.params['direction']).toBe('blunt');
    expect(decision.params['steps']).toBe(1);
  });

  test('有口不中 + 偏钝：先查饵态', () => {
    const decision = ruleJudge.judge(build(BLUNT, { intent: 'bite_no_catch' }), { now: 0 });
    expect(decision.action).toBe('CHANGE_BAIT');
    expect(decision.params['target']).toBe('state');
  });

  test('没口 + 未到底：往钝 2 目找底', () => {
    const decision = ruleJudge.judge(build(OFF_BOTTOM, { intent: 'no_bite' }), { now: 0 });
    expect(decision.action).toBe('ADJUST_FLOAT');
    expect(decision.params['steps']).toBe(2);
  });

  test('没口 + 偏钝：试深一层', () => {
    const decision = ruleJudge.judge(build(BLUNT, { intent: 'no_bite' }), { now: 0 });
    expect(decision.action).toBe('CHANGE_LAYER');
    expect(decision.params['direction']).toBe('down');
  });

  test('没口 + 偏灵：先换味型', () => {
    const decision = ruleJudge.judge(build(SENSITIVE, { intent: 'no_bite' }), { now: 0 });
    expect(decision.action).toBe('CHANGE_BAIT');
    expect(decision.params['target']).toBe('flavor');
  });

  test('没有明确问题：要求继续观察', () => {
    const decision = ruleJudge.judge(build(SENSITIVE, {}), { now: 0 });
    expect(decision.action).toBe('OBSERVE');
    expect(decision.reasonCode).toBe('INSUFFICIENT_SIGNAL');
  });
});
