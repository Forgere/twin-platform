import { describe, expect, test } from 'bun:test';
import { buildCalibration, calibrationReport } from './calibration';
import type { DecisionRecord } from './types';

const record = (id: string, confidence: number): DecisionRecord<'X'> => ({
  id,
  at: 0,
  stateHash: 'h',
  decision: { action: 'X', params: {}, confidence, reasonCode: 'R' },
  accepted: true,
});

describe('buildCalibration', () => {
  test('按置信度分桶统计真实命中率', () => {
    const records = [record('1', 0.1), record('2', 0.1), record('3', 0.9), record('4', 0.9)];
    const outcomes: Record<string, boolean> = { '1': false, '2': false, '3': true, '4': true };
    const table = buildCalibration(records, { methodId: 'rule', buckets: 5, success: (item) => outcomes[item.id] });

    expect(table.total).toBe(4);
    expect(table.decided).toBe(4);
    expect(table.buckets).toHaveLength(5);
    const low = table.buckets[0];
    const high = table.buckets[4];
    expect(low?.decisions).toBe(2);
    expect(low?.rate).toBe(0);
    expect(high?.decisions).toBe(2);
    expect(high?.rate).toBe(1);
  });

  test('没有结果的决策不计入校准但计入总数', () => {
    const records = [record('1', 0.5), record('2', 0.5)];
    const table = buildCalibration(records, { methodId: 'jev', success: (item) => (item.id === '1' ? true : undefined) });
    expect(table.total).toBe(2);
    expect(table.decided).toBe(1);
  });

  test('置信度恰好为 1 落入最后一个桶', () => {
    const table = buildCalibration([record('1', 1)], { methodId: 'rule', buckets: 5, success: () => true });
    const last = table.buckets[4];
    expect(last?.decisions).toBe(1);
  });

  test('样本不足时如实报告，不假装准确', () => {
    const table = buildCalibration([], { methodId: 'rule', success: () => true });
    expect(table.decided).toBe(0);
    expect(table.buckets.every((bucket) => bucket.decisions === 0)).toBe(true);
  });
});

describe('calibrationReport', () => {
  test('Brier：自信且正确为 0，自信且错误为 1', () => {
    expect(calibrationReport([record('1', 1)], { methodId: 'm', success: () => true }).brier).toBe(0);
    expect(calibrationReport([record('1', 1)], { methodId: 'm', success: () => false }).brier).toBe(1);
  });

  test('半信半疑且全错：Brier 是 0.25', () => {
    const records = [record('1', 0.5), record('2', 0.5)];
    const report = calibrationReport(records, { methodId: 'm', success: () => false });
    expect(report.brier).toBeCloseTo(0.25, 6);
    expect(report.successRate).toBe(0);
    expect(report.meanConfidence).toBe(0.5);
  });

  test('样本不足时 trustworthy=false，不下结论', () => {
    const few = [record('1', 0.5), record('2', 0.5)];
    expect(calibrationReport(few, { methodId: 'm', success: () => true, minSamples: 5 }).trustworthy).toBe(false);
    const enough = Array.from({ length: 5 }, (_unused, index) => record(String(index), 0.5));
    expect(calibrationReport(enough, { methodId: 'm', success: () => true, minSamples: 5 }).trustworthy).toBe(true);
  });

  test('没有结果的记录不进 Brier', () => {
    const report = calibrationReport([record('1', 0.5)], { methodId: 'm', success: () => undefined });
    expect(report.decided).toBe(0);
    expect(report.brier).toBe(0);
  });
});
