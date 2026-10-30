import type { TwinValue } from '@twin-platform/scene-schema';

/**
 * 不可变事件日志——"后台记录"。
 *
 * 事件是真相：状态可以由事件重放出来，反过来不行。因此
 * - `sequence` 严格单调、从 1 开始，是回放和断点续算的唯一游标；
 * - `occurredAt` 记仿真时间（不是 `Date.now()`），保证可重放；
 * - 日志有界：长时间运行不能让内存无限涨，超限丢最旧的并计数。
 */

export interface WorldEvent {
  sequence: number;
  /** 仿真时间（秒）。 */
  occurredAt: number;
  type: string;
  entityId?: string;
  /** 给人看的一句话。 */
  detail?: string;
  /** 给机器看的结构化数据，直接进 `twin_events` 的 jsonb。 */
  payload?: Record<string, TwinValue>;
}

export type WorldEventInput = Omit<WorldEvent, 'sequence' | 'occurredAt'>;

export class EventLog {
  private readonly events: WorldEvent[] = [];
  private next = 1;
  private flushed = 0;
  private droppedCount = 0;

  constructor(private readonly capacity = 4096) {
    if (capacity <= 0) throw new Error('事件日志容量必须是正数。');
  }

  /** 下一个将被使用的 sequence。 */
  get nextSequence(): number {
    return this.next;
  }

  /** 因容量限制被丢弃的旧事件数量。 */
  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * 把 sequence 游标对到**已经落库**的进度上（续写，而不是从头覆盖）。
   *
   * 为什么必须：事件流是 append-only 的真相。一个场景被第二次录制时，
   * 仓库里已经有上一次的事件；若新会话仍从 sequence 1 开始，写入就会被
   * "sequence 必须严格单调"挡回来——更糟的是如果放行，新时间线的事件会接在
   * 旧事件后面，回放出来的是两条时间线拼接的假历史。
   *
   * 只推进、不回退，也不动内存里已有的事件：这个方法表达的是
   * "承认库里已经记到 `sequence` 了，接下来的从它之后开始编号"。
   */
  resumeFrom(sequence: number): void {
    if (!Number.isFinite(sequence) || sequence < 0) return;
    const base = Math.floor(sequence);
    if (base > this.flushed) this.flushed = base;
    if (base + 1 > this.next) this.next = base + 1;
  }

  append(input: WorldEventInput, occurredAt: number): WorldEvent {
    const event: WorldEvent = { sequence: this.next, occurredAt, ...input };
    this.next += 1;
    this.events.push(event);
    while (this.events.length > this.capacity) {
      this.events.shift();
      this.droppedCount += 1;
      this.flushed = Math.max(0, this.flushed - 1);
    }
    return event;
  }

  /** 全部在内存中的事件（受容量限制）。 */
  all(): readonly WorldEvent[] {
    return this.events;
  }

  /** 取 sequence 严格大于 `sequence` 的事件。 */
  since(sequence: number): WorldEvent[] {
    return this.events.filter((event) => event.sequence > sequence);
  }

  /** 取最后 n 条。 */
  latest(count: number): WorldEvent[] {
    return this.events.slice(Math.max(0, this.events.length - count));
  }

  /**
   * 取出并确认"尚未落库"的事件。仓储 Adapter 每帧或每批调用一次，
   * 成功写入后再丢弃，避免丢事件。
   */
  takePending(): WorldEvent[] {
    const pending = this.since(this.flushed);
    const last = pending[pending.length - 1];
    this.flushed = last ? last.sequence : this.flushed;
    return pending;
  }

  clear(): void {
    this.events.length = 0;
    this.next = 1;
    this.flushed = 0;
    this.droppedCount = 0;
  }

  /**
   * 把游标直接挪到 `sequence`，后续事件从这里继续编号；**只丢快照之后的事件**。
   *
   * 回放分叉用：世界恢复到某个快照后，事件流必须回到快照当时的 sequence，
   * 否则重算产生的事件会带着"未来"的编号写库，破坏严格单调。
   *
   * 关键：**快照之前的历史不能被清掉**。那条旧历史仍然属于新时间线（仓储侧对应
   * `truncateAfter(sequence - 1)`，保留的就是这一段）。以前这里 `events.length = 0`，
   * 于是内存日志只剩回跳之后重算出来的几条——累计口径的不变量（守恒 / 全链路）
   * 拿它去比"此刻还活着的物料"，必然算出"不守恒"的假红灯。
   *
   * 丢头（容量上限丢掉的最旧事件）不会因回跳而回来：`droppedCount` 保留，
   * 只有真的清空日志（回到起点）才归零——窗口不完整这件事必须继续如实报告。
   */
  resetTo(sequence: number): void {
    if (!Number.isInteger(sequence) || sequence < 1) throw new Error('sequence 必须是不小于 1 的整数。');
    let cut = this.events.length;
    while (cut > 0 && (this.events[cut - 1]?.sequence ?? 0) >= sequence) cut -= 1;
    this.events.length = cut;
    this.next = sequence;
    this.flushed = sequence - 1;
    if (cut === 0) this.droppedCount = 0;
  }
}
