import { describe, expect, test } from 'bun:test';
import { validateAgainstActionSpace } from './policy';
import type { ActionDescriptor, Decision } from './types';

const ACTIONS: ActionDescriptor[] = [
  {
    id: 'MOVE',
    label: '移动',
    reversible: true,
    params: [
      { name: 'direction', kind: 'enum', options: ['up', 'down'] },
      { name: 'steps', kind: 'number', min: 1, max: 3 },
    ],
  },
  {
    id: 'WAIT',
    label: '等待',
    reversible: true,
    params: [{ name: 'rounds', kind: 'number', min: 1, max: 10, optional: true }],
  },
];

const decision = (input: Partial<Decision>): Decision => ({
  action: 'MOVE',
  params: { direction: 'up', steps: 1 },
  confidence: 0.5,
  reasonCode: 'TEST',
  ...input,
});

describe('validateAgainstActionSpace', () => {
  test('合法决策原样通过', () => {
    const verdict = validateAgainstActionSpace(ACTIONS, decision({}));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.decision.params['steps']).toBe(1);
  });

  test('未知动作被拒绝', () => {
    const verdict = validateAgainstActionSpace(ACTIONS, decision({ action: 'BOOM' }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasonCode).toBe('UNKNOWN_ACTION');
  });

  test('枚举越界被拒绝', () => {
    const verdict = validateAgainstActionSpace(ACTIONS, decision({ params: { direction: 'left', steps: 1 } }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues[0]?.code).toBe('PARAM_NOT_ALLOWED');
  });

  test('数值越界被拒绝', () => {
    const verdict = validateAgainstActionSpace(ACTIONS, decision({ params: { direction: 'up', steps: 9 } }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues[0]?.code).toBe('PARAM_OUT_OF_RANGE');
  });

  test('必填参数缺失被拒绝', () => {
    const verdict = validateAgainstActionSpace(ACTIONS, decision({ params: { direction: 'up' } }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues[0]?.code).toBe('MISSING_PARAM');
  });

  test('多余参数被拒绝', () => {
    const verdict = validateAgainstActionSpace(
      ACTIONS,
      decision({ params: { direction: 'up', steps: 1, extra: 1 } }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues[0]?.code).toBe('UNKNOWN_PARAM');
  });

  test('置信度超出 0..1 被拒绝', () => {
    const verdict = validateAgainstActionSpace(ACTIONS, decision({ confidence: 2 }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues[0]?.code).toBe('INVALID_CONFIDENCE');
  });

  test('可选参数缺省即可通过', () => {
    const verdict = validateAgainstActionSpace(ACTIONS, {
      action: 'WAIT',
      params: {},
      confidence: 0.2,
      reasonCode: 'WAIT',
    });
    expect(verdict.ok).toBe(true);
  });
});
