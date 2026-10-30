import { describe, expect, test } from 'bun:test';
import {
  DecisionEngine,
  DecisionLog,
  calibrationReport,
  compareRecorded,
  type DecisionDomain,
  type Judge,
} from '@twin-platform/decision-core';
import type { FishingActionId } from './actionSpace';
import { createFishingDomain, fishingDomain } from './domain';
import { FishingEnvironment } from './environment';
import { fishingSuccess } from './evaluator';
import type { FishingState } from './state';

/** 一个"只会观望"的判断者，用来给对比提供第二个方法。 */
const observeOnlyJudge: Judge<FishingState, FishingActionId> = {
  id: 'observe-only',
  judge: () => ({ action: 'OBSERVE', params: { casts: 3 }, confidence: 0.35, reasonCode: 'SCRIPTED_OBSERVE' }),
};

/**
 * 跑一段闭环：observe -> decide -> step -> 回填结果。
 *
 * 每一步都把这一步的 outcome 挂到对应记录上，所以跑完就是一份
 * "决策 + 状态指纹 + 事后结果" 的评测数据集。
 */
async function episode(
  domain: DecisionDomain<FishingState, FishingActionId>,
  seed: number,
  steps: number,
): Promise<DecisionLog<FishingActionId>> {
  const env = new FishingEnvironment({ seed, horizon: 60, template: { castInterval: 1 } });
  const log = new DecisionLog<FishingActionId>();
  const engine = new DecisionEngine(domain, log);
  for (let index = 0; index < steps; index += 1) {
    const state = env.observe();
    const record = await engine.decide(state, { at: env.world.time });
    log.attachOutcome(record.id, env.step(record.decision));
  }
  return log;
}

describe('闭环评测', () => {
  test('跑完一段就有结果、能校准，且同种子可复现', async () => {
    const log = await episode(fishingDomain, 4, 20);
    const report = calibrationReport(log.all(), { methodId: 'rule', success: fishingSuccess, buckets: 4, minSamples: 3 });

    expect(report.total).toBe(20);
    expect(report.decided).toBe(20);
    expect(report.buckets).toHaveLength(4);
    expect(report.brier).toBeGreaterThanOrEqual(0);
    expect(report.brier).toBeLessThanOrEqual(1);
    expect(report.meanConfidence).toBeGreaterThan(0);

    const again = await episode(fishingDomain, 4, 20);
    const repeat = calibrationReport(again.all(), { methodId: 'rule', success: fishingSuccess, buckets: 4, minSamples: 3 });
    expect(repeat.brier).toBe(report.brier);
    expect(repeat.successRate).toBe(report.successRate);
  });

  test('两个判断者按结果对比，样本够时给结论', async () => {
    const ruleLog = await episode(fishingDomain, 7, 12);
    const observeLog = await episode(createFishingDomain(observeOnlyJudge), 7, 12);
    const comparison = compareRecorded(
      { methodId: 'rule', records: ruleLog.all() },
      { methodId: 'observe-only', records: observeLog.all() },
      { success: fishingSuccess, minSamples: 5 },
    );
    expect(comparison.a.decided).toBe(12);
    expect(comparison.b.decided).toBe(12);
    expect(['a', 'b', 'tie']).toContain(comparison.winner);
  });

  test('用户反馈优先于仿真评分', async () => {
    const log = await episode(fishingDomain, 1, 1);
    const record = log.all()[0];
    if (!record) throw new Error('没有记录');
    log.attachOutcome(record.id, { at: 1, metrics: { catchRate: 0.9 } });
    expect(fishingSuccess(record)).toBe(true);
    // 仿真说成功、用户说不管用 —— 以用户为准。
    record.feedback = { decisionId: record.id, useful: false, at: 2 };
    expect(fishingSuccess(record)).toBe(false);
  });

  test('没有结果时不算失败，也不参与校准', () => {
    expect(fishingSuccess({ id: 'x', at: 0, stateHash: 'h', decision: { action: 'OBSERVE', params: {}, confidence: 0.5, reasonCode: 'R' }, accepted: true })).toBeUndefined();
  });
});
