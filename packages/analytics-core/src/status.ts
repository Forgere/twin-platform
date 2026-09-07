import type { WorldEvent } from '@twin-platform/world-kernel';
import { emptyBuckets, type MetricSeries } from './window';

/**
 * 从事件流反推"某实体在某一状态待了多久"。
 *
 * 状态时长是**区间**而不是点：只有"进入 busy"和"进入 idle"两条事件，
 * 才知道 busy 持续了多久。所以这里先把事件流折成区间，再在区间上算
 * 利用率和停机——直接在事件上数个数是错的。
 *
 * 事件不是状态机：日志有容量上限、回放可能从中间开始，因此第一段区间
 * 之前的时间视为"未知"，不计入任何状态；最后一段区间用 `until` 收口。
 */

export interface StatusInterval {
  entityId: string;
  status: string;
  from: number;
  /** 区间结束时间；开区间，下一段从这里接上。 */
  to: number;
}

export interface StatusTimelineOptions {
  /** 状态事件类型，默认 `entity:status`。 */
  statusEvent?: string;
  /** payload 里读状态用的键，默认 `status`。 */
  statusKey?: string;
  /** 收口时间；缺省用最后一条事件的时间。 */
  until?: number;
}

export function statusIntervals(events: readonly WorldEvent[], options: StatusTimelineOptions = {}): StatusInterval[] {
  const type = options.statusEvent ?? 'entity:status';
  const key = options.statusKey ?? 'status';
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const until = options.until ?? (ordered.length === 0 ? 0 : Math.max(...ordered.map((event) => event.occurredAt)));

  const intervals: StatusInterval[] = [];
  const open = new Map<string, { status: string; from: number }>();

  for (const event of ordered) {
    if (event.type !== type || event.entityId === undefined) continue;
    const raw = event.payload?.[key] ?? event.detail;
    if (typeof raw !== 'string' || raw === '') continue;

    const existing = open.get(event.entityId);
    if (existing && event.occurredAt > existing.from) {
      intervals.push({ entityId: event.entityId, status: existing.status, from: existing.from, to: event.occurredAt });
    }
    open.set(event.entityId, { status: raw, from: event.occurredAt });
  }

  for (const [entityId, pending] of open) {
    if (until > pending.from) intervals.push({ entityId, status: pending.status, from: pending.from, to: until });
  }

  // 区间按实体、再按开始时间排序：顺序即契约，比较两次运行要逐位一致
  return intervals.sort((a, b) => (a.entityId === b.entityId ? a.from - b.from : a.entityId < b.entityId ? -1 : 1));
}

export interface StatusDuration {
  entityId: string;
  status: string;
  duration: number;
}

/** 把区间按 (实体, 状态) 合并成总时长。 */
export function durationByStatus(intervals: readonly StatusInterval[]): StatusDuration[] {
  const totals = new Map<string, StatusDuration>();
  for (const interval of intervals) {
    const id = `${interval.entityId}::${interval.status}`;
    const existing = totals.get(id);
    if (existing) {
      existing.duration += interval.to - interval.from;
      continue;
    }
    totals.set(id, { entityId: interval.entityId, status: interval.status, duration: interval.to - interval.from });
  }
  return [...totals.values()].sort((a, b) => (a.entityId === b.entityId ? (a.status < b.status ? -1 : 1) : a.entityId < b.entityId ? -1 : 1));
}

/** 区间与窗口的重叠长度，利用率和停机都靠它落在正确的时间窗里。 */
export function overlap(interval: StatusInterval, from: number, to: number): number {
  return Math.max(0, Math.min(interval.to, to) - Math.max(interval.from, from));
}

export interface UtilizationRow {
  entityId: string;
  /** 0…1。 */
  utilization: number;
  busy: number;
  /** 窗口内有状态记录的总时长；它是分母，不是窗口长度。 */
  observed: number;
}

/**
 * 设备利用率 = busy 时长 / 有状态记录的时长。
 *
 * 分母用 observed 而不是窗口长度：回放从中间开始时，窗口开头并没有状态记录，
 * 拿窗口长度当分母会把利用率系统性算低。
 */
export function utilizationByEntity(
  intervals: readonly StatusInterval[],
  options: { busyStatuses: readonly string[]; from?: number; to?: number } ,
): UtilizationRow[] {
  const from = options.from ?? 0;
  const to = options.to ?? Number.POSITIVE_INFINITY;
  const rows = new Map<string, UtilizationRow>();

  for (const interval of intervals) {
    const span = overlap(interval, from, to);
    if (span <= 0) continue;
    const row = rows.get(interval.entityId) ?? { entityId: interval.entityId, utilization: 0, busy: 0, observed: 0 };
    row.observed += span;
    if (options.busyStatuses.includes(interval.status)) row.busy += span;
    rows.set(interval.entityId, row);
  }

  const result = [...rows.values()].sort((a, b) => (a.entityId < b.entityId ? -1 : 1));
  for (const row of result) row.utilization = row.observed === 0 ? 0 : row.busy / row.observed;
  return result;
}

/** 把区间时长摊进时间桶：区间跨桶时按重叠长度分摊，不做"整段算在起点桶"。 */
export function durationSeries(
  id: string,
  intervals: readonly StatusInterval[],
  options: { bucketSize: number; until: number; statuses?: readonly string[] },
): MetricSeries {
  const buckets = emptyBuckets(options.bucketSize, options.until);
  for (const interval of intervals) {
    if (options.statuses && !options.statuses.includes(interval.status)) continue;
    for (const bucket of buckets) {
      const span = overlap(interval, bucket.start, bucket.end);
      if (span <= 0) continue;
      bucket.value += span;
      bucket.count += 1;
    }
  }
  return { id, bucketSize: options.bucketSize, buckets };
}

export interface DowntimeRow {
  entityId: string;
  /** 停机总时长（秒）。 */
  downtime: number;
  /** 停机次数：连续区间算一次，避免"抖一下"被数成两次。 */
  occurrences: number;
}

export function downtimeByEntity(
  intervals: readonly StatusInterval[],
  options: { downStatuses: readonly string[]; from?: number; to?: number },
): DowntimeRow[] {
  const from = options.from ?? 0;
  const to = options.to ?? Number.POSITIVE_INFINITY;
  const rows = new Map<string, DowntimeRow>();

  for (const interval of intervals) {
    if (!options.downStatuses.includes(interval.status)) continue;
    const span = overlap(interval, from, to);
    if (span <= 0) continue;
    const row = rows.get(interval.entityId) ?? { entityId: interval.entityId, downtime: 0, occurrences: 0 };
    row.downtime += span;
    row.occurrences += 1;
    rows.set(interval.entityId, row);
  }

  return [...rows.values()].sort((a, b) => (a.entityId < b.entityId ? -1 : 1));
}
