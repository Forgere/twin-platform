import { describe, expect, test } from 'bun:test';
import { applyFeedback } from './feedback';
import { DecisionLog } from './log';

const makeLog = () => {
  const log = new DecisionLog<'X'>('d');
  log.append({
    at: 0,
    stateHash: 'h',
    decision: { action: 'X', params: {}, confidence: 0.6, reasonCode: 'R' },
    accepted: true,
  });
  return log;
};

describe('applyFeedback', () => {
  test('👍 回填 feedback 与 score=1', () => {
    const log = makeLog();
    expect(applyFeedback(log, { decisionId: 'd1', useful: true, at: 5 })).toBe(true);
    expect(log.find('d1')?.feedback?.useful).toBe(true);
    expect(log.find('d1')?.score).toBe(1);
  });

  test('👎 记 0 分', () => {
    const log = makeLog();
    applyFeedback(log, { decisionId: 'd1', useful: false, at: 5 });
    expect(log.find('d1')?.score).toBe(0);
    expect(log.find('d1')?.feedback?.useful).toBe(false);
  });

  test('未知 decisionId 返回 false，不凭空造记录', () => {
    const log = makeLog();
    expect(applyFeedback(log, { decisionId: 'nope', useful: true, at: 1 })).toBe(false);
    expect(log.size).toBe(1);
  });
});
