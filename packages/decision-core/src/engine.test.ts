import { describe, expect, test } from 'bun:test';
import { DecisionEngine } from './engine';
import { DecisionLog } from './log';
import type { DecisionDomain, Judge } from './ports';
import type { ActionDescriptor, Decision, DecisionState } from './types';

interface TestState extends DecisionState {
  readonly kind: 'test';
  readonly value: number;
}

const ACTIONS: ActionDescriptor<'OBSERVE' | 'ACT'>[] = [
  { id: 'OBSERVE', label: '观察', reversible: true, params: [{ name: 'rounds', kind: 'number', min: 1, max: 5 }] },
  { id: 'ACT', label: '动作', reversible: true, params: [{ name: 'level', kind: 'number', min: 1, max: 3 }] },
];

const makeDomain = (judge: Judge<TestState, 'OBSERVE' | 'ACT'>): DecisionDomain<TestState, 'OBSERVE' | 'ACT'> => ({
  id: 'test',
  actions: ACTIONS,
  judge,
  policy: {
    id: 'test-policy',
    validate: (_state, decision) => {
      const descriptor = ACTIONS.find((item) => item.id === decision.action);
      if (!descriptor) return { ok: false, reasonCode: 'UNKNOWN_ACTION', issues: [] };
      return { ok: true, decision };
    },
  },
  fallback: () => ({ action: 'OBSERVE', params: { rounds: 1 }, confidence: 0.1, reasonCode: 'DEGRADED' }),
});

const state = (value: number): TestState => ({ kind: 'test', value });

describe('DecisionEngine', () => {
  test('合法判断被接受并写入日志', async () => {
    const engine = new DecisionEngine<TestState, 'OBSERVE' | 'ACT'>(
      makeDomain({
        id: 'ok',
        judge: () => ({ action: 'ACT', params: { level: 2 }, confidence: 0.8, reasonCode: 'GO' }),
      }),
    );
    const record = await engine.decide(state(1), { at: 0 });
    expect(record.accepted).toBe(true);
    expect(record.decision.action).toBe('ACT');
    expect(record.at).toBe(0);
    expect(engine.decisionLog.size).toBe(1);
  });

  test('非法判断被降级为 fallback 并记录原因', async () => {
    const engine = new DecisionEngine<TestState, 'OBSERVE' | 'ACT'>(
      makeDomain({
        id: 'bad',
        judge: () => ({ action: 'BOOM' as 'ACT', params: {}, confidence: 0.9, reasonCode: 'NOPE' }),
      }),
    );
    const record = await engine.decide(state(1));
    expect(record.accepted).toBe(false);
    expect(record.degradeReason).toBe('UNKNOWN_ACTION');
    expect(record.decision.action).toBe('OBSERVE');
  });

  test('同一输入两次判断逐位一致（除递增 id）', async () => {
    const judge: Judge<TestState, 'OBSERVE' | 'ACT'> = {
      id: 'stable',
      judge: (input) => ({ action: 'ACT', params: { level: input.value }, confidence: 0.6, reasonCode: 'S' }),
    };
    const engine = new DecisionEngine<TestState, 'OBSERVE' | 'ACT'>(makeDomain(judge));
    const first = await engine.decide(state(2));
    const second = await engine.decide(state(2));
    expect(first.id).not.toBe(second.id);
    expect(second.stateHash).toBe(first.stateHash);
    expect(second.decision).toEqual(first.decision);
  });

  test('日志可回填结果并往返序列化', async () => {
    const engine = new DecisionEngine<TestState, 'OBSERVE' | 'ACT'>(
      makeDomain({
        id: 'ok',
        judge: () => ({ action: 'ACT', params: { level: 1 }, confidence: 0.5, reasonCode: 'GO' }),
      }),
    );
    const record = await engine.decide(state(3));
    expect(engine.decisionLog.attachOutcome(record.id, { at: 10, metrics: { catch: 1 } })).toBe(true);
    expect(engine.decisionLog.attachScore(record.id, 1)).toBe(true);

    const restored = DecisionLog.fromJSON(engine.decisionLog.toJSON());
    expect(restored.size).toBe(1);
    expect(restored.all()[0]?.outcome?.metrics['catch']).toBe(1);
    const next = restored.append({ at: 11, stateHash: 'x', decision: record.decision, accepted: true });
    expect(next.id).toBe('d2');
  });

  test('回填不存在的记录返回 false', () => {
    const log = new DecisionLog<'OBSERVE'>('d');
    expect(log.attachScore('missing', 1)).toBe(false);
    expect(log.attachOutcome('missing', { at: 0, metrics: {} })).toBe(false);
  });
});
