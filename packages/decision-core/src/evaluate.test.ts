import { describe, expect, test } from 'bun:test';
import { compareJudges, summarizeDecisions } from './evaluate';
import type { DecisionDomain } from './ports';
import type { DecisionRecord, DecisionState } from './types';

interface State extends DecisionState {
  readonly kind: 's';
  readonly value: number;
}

const domain = (id: string, pick: (value: number) => string): DecisionDomain<State> => ({
  id,
  actions: [
    { id: 'A', label: 'A', reversible: true, params: [] },
    { id: 'B', label: 'B', reversible: true, params: [] },
  ],
  judge: {
    id,
    judge: (state) => ({ action: pick(state.value), params: {}, confidence: 0.5, reasonCode: 'R' }),
  },
  policy: { id: 'p', validate: (_state, decision) => ({ ok: true, decision }) },
  fallback: () => ({ action: 'A', params: {}, confidence: 0.1, reasonCode: 'DEGRADED' }),
});

const record = (action: string, confidence: number, accepted: boolean): DecisionRecord<string> => ({
  id: action + confidence,
  at: 0,
  stateHash: 'h',
  decision: { action, params: {}, confidence, reasonCode: 'R' },
  accepted,
});

describe('summarizeDecisions', () => {
  test('统计接受率、动作分布与平均置信度', () => {
    const summary = summarizeDecisions([record('A', 0.5, true), record('A', 0.7, false), record('B', 0.9, true)]);
    expect(summary.total).toBe(3);
    expect(summary.accepted).toBe(2);
    expect(summary.degraded).toBe(1);
    expect(summary.byAction['A']).toBe(2);
    expect(summary.byAction['B']).toBe(1);
    expect(summary.meanConfidence).toBeCloseTo(0.7, 6);
  });

  test('空日志不除零', () => {
    const summary = summarizeDecisions([]);
    expect(summary.meanConfidence).toBe(0);
  });
});

describe('compareJudges', () => {
  test('按动作统计两个判断者的一致率', async () => {
    const states: State[] = [0, 1, 2, 3].map((value) => ({ kind: 's', value }));
    // 规则：value >= 2 选 B，否则 A；Jev：永远 A。
    const comparison = await compareJudges(domain('rule', (value) => (value >= 2 ? 'B' : 'A')), domain('jev', () => 'A'), states);
    expect(comparison.states).toBe(4);
    expect(comparison.agreed).toBe(2);
    expect(comparison.agreement).toBe(0.5);
    expect(comparison.aOnly['B']).toBe(2);
    expect(comparison.bOnly['A']).toBe(2);
  });
});
