import { describe, expect, test } from 'bun:test';
import { calculateRigState, type TaidiaoInput } from './fishingCore';
import { FISHING_ACTION_IDS } from './actionSpace';
import { actionFromChoice, emptyHookBucket, toJevRequest } from './jevQuestions';
import { toFishingState, type FishingContextInput } from './state';

const build = (rig: TaidiaoInput, context: FishingContextInput) => {
  const result = calculateRigState(rig);
  if (!result.ok) throw new Error('测试钓组不合法');
  return toFishingState(result.state, context);
};

describe('emptyHookBucket', () => {
  test('没有信号、偏高、偏低、居中四种分桶', () => {
    expect(emptyHookBucket({ bites: 0, catches: 0, emptyHooks: 0 })).toBe('no_signal');
    expect(emptyHookBucket({ bites: 10, catches: 2, emptyHooks: 8 })).toBe('high');
    expect(emptyHookBucket({ bites: 10, catches: 9, emptyHooks: 1 })).toBe('low');
    expect(emptyHookBucket({ bites: 10, catches: 5, emptyHooks: 5 })).toBe('medium');
  });
});

describe('toJevRequest', () => {
  test('只给类别事实，不给需要比较的原始数值', () => {
    const request = toJevRequest(build({ t0: 4, t: 2, w: 1, d: 1 }, { intent: 'no_bite' }));
    expect(request.state['zone']).toBe('sensitive');
    expect(request.state['intent']).toBe('no_bite');
    for (const value of Object.values(request.state)) expect(typeof value).toBe('string');
    // 原始数值字段不得出现——否则等于让 Jev 做数值比较。
    for (const key of ['bottom_load', 'B', 'w', 'd', 't0', 't']) expect(request.state[key]).toBeUndefined();
  });

  test('一次请求包含封闭的 choice / noul / score', () => {
    const request = toJevRequest(build({ t0: 4, t: 2, w: 1, d: 1 }, {}));
    const choice = request.questions.find((question) => question.kind === 'choice');
    const noul = request.questions.find((question) => question.kind === 'noul');
    const score = request.questions.find((question) => question.kind === 'score');
    expect(choice?.id).toBe('next_action');
    if (choice?.kind === 'choice') expect(choice.options).toEqual([...FISHING_ACTION_IDS]);
    expect(noul?.id).toBe('needs_observe');
    expect(score?.id).toBe('urgency');
    if (score?.kind === 'score') expect(score.levels.length).toBeLessThanOrEqual(10);
  });

  test('把方向/类别也问出来，但幅度留给代码', () => {
    const request = toJevRequest(build({ t0: 4, t: 2, w: 1, d: 1 }, {}));
    const ids = request.questions.map((question) => question.id);
    expect(ids).toEqual(['next_action', 'float_direction', 'bait_target', 'needs_observe', 'urgency']);
    const direction = request.questions.find((question) => question.id === 'float_direction');
    if (direction?.kind === 'choice') expect(direction.options).toEqual(['sensitive', 'blunt']);
  });

  test('choice 结果收敛回封闭动作空间', () => {
    expect(actionFromChoice('ADJUST_FLOAT')).toBe('ADJUST_FLOAT');
    expect(actionFromChoice('TELEPORT')).toBeUndefined();
    expect(actionFromChoice(undefined)).toBeUndefined();
  });
});
