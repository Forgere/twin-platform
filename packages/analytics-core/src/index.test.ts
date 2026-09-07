import { describe, expect, test } from 'bun:test';
import type { WorldEvent } from '@twin-platform/world-kernel';
import type { MetricDescriptor } from '@twin-platform/plugin-sdk';
import {
  countByType,
  countSeries,
  downtimeByEntity,
  durationByStatus,
  durationSeries,
  lineMetrics,
  computeMetric,
  ratePerMinute,
  seriesLatest,
  seriesPeak,
  seriesTotal,
  statusIntervals,
  stepSeries,
  sumByKey,
  sumSeries,
  utilizationByEntity,
} from './index';

let seq = 1;
const ev = (occurredAt: number, type: string, entityId?: string, payload?: Record<string, string | number | boolean>): WorldEvent => ({
  sequence: seq++,
  occurredAt,
  type,
  ...(entityId !== undefined ? { entityId } : {}),
  ...(payload !== undefined ? { payload } : {}),
});

describe('窗口聚合', () => {
  test('计数按桶落位，速率换算成每分钟', () => {
    const events = [ev(1, 'parcel:exit'), ev(2, 'parcel:exit'), ev(61, 'parcel:exit')];
    const series = countSeries('t', events, { bucketSize: 60, until: 120 });
    expect(series.buckets.map((bucket) => bucket.value)).toEqual([2, 1]);
    expect(ratePerMinute(series).buckets.map((bucket) => bucket.value)).toEqual([2, 1]);

    const half = countSeries('t', events, { bucketSize: 30, until: 90 });
    expect(half.buckets.map((bucket) => bucket.value)).toEqual([2, 0, 1]);
    expect(ratePerMinute(half).buckets[0]?.value).toBe(4); // 30 秒 2 件 = 4 件/分钟
  });

  test('求和读 payload 数字，非数字按 0 计', () => {
    const events = [ev(1, 'energy', 'a', { kwh: 2.5 }), ev(2, 'energy', 'a', { kwh: 'x' }), ev(3, 'other', 'a', { note: 9 })];
    expect(seriesTotal(sumSeries('e', events, { bucketSize: 60, valueKey: 'kwh' }))).toBe(2.5);
    expect(sumByKey(events, 'kwh')).toBe(2.5);
    expect(countByType(events)).toEqual({ energy: 2, other: 1 });
  });

  test('积压是阶梯水位，空桶沿用上一桶', () => {
    const events = [ev(0, 'parcel:enter'), ev(1, 'parcel:enter'), ev(2, 'parcel:enter'), ev(10, 'parcel:exit')];
    const series = stepSeries('backlog', events, { bucketSize: 5, enterTypes: ['parcel:enter'], exitTypes: ['parcel:exit'], until: 20 });
    expect(series.buckets.map((bucket) => bucket.value)).toEqual([3, 3, 2, 2]);
    expect(seriesLatest(series)).toBe(2);
    expect(seriesPeak(series)).toBe(3);
  });
});

describe('状态时长', () => {
  const events = [
    ev(0, 'entity:status', 'a', { status: 'busy' }),
    ev(10, 'entity:status', 'a', { status: 'idle' }),
    ev(20, 'entity:status', 'a', { status: 'busy' }),
    ev(25, 'entity:status', 'b', { status: 'down' }),
  ];

  test('事件流折成区间，末段用 until 收口', () => {
    const intervals = statusIntervals(events, { until: 30 });
    // 按 (实体, from) 排序：a 的 busy[0,10) → idle[10,20) → busy[20,30)，b 的 down[25,30)
    expect(intervals).toEqual([
      { entityId: 'a', status: 'busy', from: 0, to: 10 },
      { entityId: 'a', status: 'idle', from: 10, to: 20 },
      { entityId: 'a', status: 'busy', from: 20, to: 30 },
      { entityId: 'b', status: 'down', from: 25, to: 30 },
    ]);
  });

  test('时长按 (实体, 状态) 合并', () => {
    expect(durationByStatus(statusIntervals(events, { until: 30 }))).toEqual([
      { entityId: 'a', status: 'busy', duration: 20 },
      { entityId: 'a', status: 'idle', duration: 10 },
      { entityId: 'b', status: 'down', duration: 5 },
    ]);
  });

  test('利用率分母是"有记录时长"，不是窗口长度', () => {
    const utilization = utilizationByEntity(statusIntervals(events, { until: 30 }), { busyStatuses: ['busy'] });
    expect(utilization).toEqual([
      { entityId: 'a', utilization: 20 / 30, busy: 20, observed: 30 },
      { entityId: 'b', utilization: 0, busy: 0, observed: 5 },
    ]);
  });

  test('停机按时长累加并记次数，可按窗口裁剪', () => {
    const intervals = statusIntervals(events, { until: 30 });
    expect(downtimeByEntity(intervals, { downStatuses: ['down'] })).toEqual([{ entityId: 'b', downtime: 5, occurrences: 1 }]);
    expect(downtimeByEntity(intervals, { downStatuses: ['down'], from: 26, to: 30 })).toEqual([{ entityId: 'b', downtime: 4, occurrences: 1 }]);
  });

  test('区间跨桶时按重叠分摊', () => {
    const series = durationSeries('d', [{ entityId: 'a', status: 'busy', from: 3, to: 12 }], { bucketSize: 5, until: 15 });
    expect(series.buckets.map((bucket) => Number(bucket.value.toFixed(3)))).toEqual([2, 5, 2]);
  });
});

describe('插件指标计算', () => {
  const events = [
    ev(0, 'parcel:enter', 'p1', {}),
    ev(1, 'parcel:exit', 'p1', { weight: 3 }),
    ev(2, 'parcel:exit', 'p2', { weight: 4 }),
    ev(3, 'entity:status', 'a', { status: 'busy' }),
    ev(9, 'entity:status', 'a', { status: 'idle' }),
  ];

  test('count / sum / duration / last 四种聚合都按描述符算', () => {
    const descriptors: MetricDescriptor[] = [
      { id: 'exits', label: '出库件数', eventTypes: ['parcel:exit'], aggregation: 'count', groupByEntity: true },
      { id: 'weight', label: '总重量', eventTypes: ['parcel:exit'], aggregation: 'sum', valueKey: 'weight' },
      { id: 'busy', label: '忙碌时长', eventTypes: ['entity:status'], aggregation: 'duration', valueKey: 'busy' },
      { id: 'lastWeight', label: '末件重量', eventTypes: ['parcel:exit'], aggregation: 'last', valueKey: 'weight' },
    ];
    const computed = descriptors.map((descriptor) => computeMetric(descriptor, events, { bucketSize: 60, until: 60 }));

    expect(computed[0]?.total).toBe(2);
    expect(computed[0]?.byEntity).toEqual({ p1: 1, p2: 1 });
    expect(computed[1]?.total).toBe(7);
    expect(computed[2]?.total).toBe(6); // busy 3→9
    expect(computed[3]?.latest).toBe(4);
  });

  test('同输入两次计算逐位一致', () => {
    const descriptor: MetricDescriptor = { id: 'exits', label: '出库件数', eventTypes: ['parcel:exit'], aggregation: 'count' };
    const a = computeMetric(descriptor, events, { bucketSize: 5, until: 30 });
    const b = computeMetric(descriptor, events, { bucketSize: 5, until: 30 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('产线指标集', () => {
  test('吞吐、积压、利用率、停机一次算全', () => {
    const events = [
      ev(0, 'parcel:enter', 'p1', {}),
      ev(1, 'parcel:enter', 'p2', {}),
      ev(2, 'entity:status', 'belt-01', { status: 'busy' }),
      ev(30, 'parcel:exit', 'p1', {}),
      ev(40, 'entity:status', 'belt-01', { status: 'down' }),
      ev(50, 'entity:status', 'belt-01', { status: 'busy' }),
      ev(60, 'parcel:exit', 'p2', {}),
    ];

    const metrics = lineMetrics(events, {
      bucketSize: 60,
      enterTypes: ['parcel:enter'],
      exitTypes: ['parcel:exit'],
      busyStatuses: ['busy'],
      downStatuses: ['down'],
      until: 60,
    });

    expect(metrics.throughput.buckets[0]?.value).toBe(2); // 60 秒 2 件 = 2 件/分钟
    // 窗口末端 t=60 的最后一件刚好离开，但按 [start,end) 半开约定它属于下一个
    // （不存在的）桶，因此桶末在制数量 = 1（p2 还在 60⁻）。
    expect(metrics.backlog.buckets[0]?.value).toBe(1);
    expect(metrics.utilization[0]).toEqual({ entityId: 'belt-01', utilization: 48 / 58, busy: 48, observed: 58 });
    expect(metrics.downtime[0]).toEqual({ entityId: 'belt-01', downtime: 10, occurrences: 1 });
  });

  test('中途回放时积压取桶末水位，不会因缺开头而算成 0', () => {
    const events = [ev(5, 'parcel:enter', 'p1', {}), ev(25, 'parcel:enter', 'p2', {}), ev(35, 'parcel:exit', 'p1', {})];
    const metrics = lineMetrics(events, {
      bucketSize: 10,
      enterTypes: ['parcel:enter'],
      exitTypes: ['parcel:exit'],
      busyStatuses: [],
      downStatuses: [],
      until: 60,
    });
    // p1@5 入、p2@25 入、p1@35 出：各桶末在制 = [1,1,2,1,1,1]
    expect(metrics.backlog.buckets.map((bucket) => bucket.value)).toEqual([1, 1, 2, 1, 1, 1]);
  });
});
