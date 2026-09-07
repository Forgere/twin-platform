import type { MetricDescriptor } from '@twin-platform/plugin-sdk';
import type { WorldEvent } from '@twin-platform/world-kernel';
import {
  durationByStatus,
  durationSeries,
  downtimeByEntity,
  statusIntervals,
  utilizationByEntity,
  type DowntimeRow,
  type StatusInterval,
  type UtilizationRow,
} from './status';
import { countSeries, emptySeries, ratePerMinute, seriesLatest, seriesTotal, stepSeries, sumSeries, type MetricSeries } from './window';

/**
 * 指标计算：插件声明"有什么指标"，这里负责把它算出来。
 *
 * 插件只给描述符（`MetricDescriptor`），不写计算代码——同一套"吞吐/积压/利用率"
 * 语义在插件间保持一致，比较不同产线的方案才有意义。
 *
 * 全部纯函数：同输入必然同输出，`bun test` 里可以直接比对两次结果。
 */

export interface ComputedMetric {
  descriptor: MetricDescriptor;
  series: MetricSeries;
  /** 全窗口累计值。 */
  total: number;
  /** 最新值（`last` / 积压类指标读它）。 */
  latest: number;
  /** 按实体拆分（描述符声明 `groupByEntity` 时才有）。 */
  byEntity?: Record<string, number>;
}

export interface ComputeOptions {
  bucketSize: number;
  /** 收口时间；缺省用最后一条事件的时间。 */
  until?: number;
  /** 状态事件类型与 payload 键，`duration` 类指标要用。 */
  statusEvent?: string;
  statusKey?: string;
}

export function computeMetric(descriptor: MetricDescriptor, events: readonly WorldEvent[], options: ComputeOptions): ComputedMetric {
  const horizon = options.until ?? (events.length === 0 ? 0 : Math.max(...events.map((event) => event.occurredAt)));
  const scoped = events.filter((event) => descriptor.eventTypes.includes(event.type));

  let series: MetricSeries;
  switch (descriptor.aggregation) {
    case 'count':
      series = countSeries(descriptor.id, scoped, { bucketSize: options.bucketSize, until: horizon });
      break;
    case 'sum':
      series = sumSeries(descriptor.id, scoped, { bucketSize: options.bucketSize, until: horizon, valueKey: descriptor.valueKey ?? 'value' });
      break;
    case 'duration': {
      const intervals = statusIntervals(events, { statusEvent: options.statusEvent, statusKey: options.statusKey, until: horizon });
      const scopedIntervals = descriptor.valueKey ? intervals.filter((interval) => interval.status === descriptor.valueKey) : intervals;
      series = durationSeries(descriptor.id, scopedIntervals, { bucketSize: options.bucketSize, until: horizon });
      break;
    }
    case 'last': {
      series = emptySeries(descriptor.id, options.bucketSize);
      const last = scoped[scoped.length - 1];
      const raw = last?.payload?.[descriptor.valueKey ?? 'value'];
      if (last && typeof raw === 'number' && Number.isFinite(raw)) {
        const index = Math.floor(last.occurredAt / options.bucketSize);
        while (series.buckets.length <= index) {
          const i = series.buckets.length;
          series.buckets.push({ start: i * options.bucketSize, end: (i + 1) * options.bucketSize, value: 0, count: 0 });
        }
        const bucket = series.buckets[index];
        if (bucket) {
          bucket.value = raw;
          bucket.count = 1;
        }
      }
      break;
    }
  }

  const computed: ComputedMetric = {
    descriptor,
    series,
    total: descriptor.aggregation === 'last' ? seriesLatest(series) : seriesTotal(series),
    latest: seriesLatest(series),
  };

  if (descriptor.groupByEntity) computed.byEntity = sumByEntity(scoped, descriptor);
  return computed;
}

export function computeMetrics(descriptors: readonly MetricDescriptor[], events: readonly WorldEvent[], options: ComputeOptions): ComputedMetric[] {
  return descriptors.map((descriptor) => computeMetric(descriptor, events, options));
}

function sumByEntity(events: readonly WorldEvent[], descriptor: MetricDescriptor): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of events) {
    if (event.entityId === undefined) continue;
    const value = descriptor.aggregation === 'count' ? 1 : readNumber(event.payload?.[descriptor.valueKey ?? 'value']);
    out[event.entityId] = (out[event.entityId] ?? 0) + value;
  }
  return sortRecord(out);
}

const readNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** 记录要按 key 排序输出：对象键顺序也算契约的一部分。 */
function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ---------------------------------------------------------------------------
// 产线指标集（阶段 D 验收口径）
// ---------------------------------------------------------------------------

export interface LineMetricsOptions {
  bucketSize: number;
  /** "进入产线"事件类型，例如 `parcel:enter`。 */
  enterTypes: readonly string[];
  /** "离开产线"事件类型，例如 `parcel:exit`。 */
  exitTypes: readonly string[];
  /** 算作"忙"的状态值。 */
  busyStatuses: readonly string[];
  /** 算作"停机"的状态值。 */
  downStatuses: readonly string[];
  until?: number;
  statusEvent?: string;
  statusKey?: string;
}

export interface LineMetrics {
  /** 吞吐（件/分钟）。 */
  throughput: MetricSeries;
  /** 积压（件），取桶末在制数量。 */
  backlog: MetricSeries;
  utilization: UtilizationRow[];
  downtime: DowntimeRow[];
  intervals: StatusInterval[];
}

/**
 * 一期要的四个产线指标：吞吐、积压、设备利用率、停机时间。
 *
 * 它们全部从事件流算出来，不读渲染层、不读世界当前状态——
 * 所以同一段历史可以在服务端重算，也可以拿两个方案的事件流直接比大小。
 */
export function lineMetrics(events: readonly WorldEvent[], options: LineMetricsOptions): LineMetrics {
  const horizon = options.until ?? (events.length === 0 ? 0 : Math.max(...events.map((event) => event.occurredAt)));
  const intervals = statusIntervals(events, { statusEvent: options.statusEvent, statusKey: options.statusKey, until: horizon });

  return {
    throughput: ratePerMinute(countSeries('throughput', events, { bucketSize: options.bucketSize, types: options.exitTypes, until: horizon })),
    backlog: stepSeries('backlog', events, { bucketSize: options.bucketSize, enterTypes: options.enterTypes, exitTypes: options.exitTypes, until: horizon }),
    utilization: utilizationByEntity(intervals, { busyStatuses: options.busyStatuses, to: horizon }),
    downtime: downtimeByEntity(intervals, { downStatuses: options.downStatuses, to: horizon }),
    intervals,
  };
}

export { durationByStatus };
