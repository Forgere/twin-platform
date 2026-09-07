import type { ReplaySession, TwinStorage } from '@twin-platform/storage-contracts';
import type { FrameDelta, TwinWorld, WorldEvent } from '@twin-platform/world-kernel';

/**
 * 时间轴回放控制器。
 *
 * 三条硬规则：
 * 1. **倍速只改变一帧吃几个步长，绝不影响结果。** 1× 和 100× 跑完同一段时间的
 *    世界指纹必须相同，否则回放就只是动画。
 * 2. **定位靠重算，不靠插值。** `seek(t)` 永远是"恢复 t 之前最近的快照 + 按固定步长
 *    推到 t"，因此跳到任意时刻得到的结果和一路播放过来一致。
 * 3. **往回跳就是分叉。** 回跳后旧时间线之后的事件必须截断，否则回放出来的历史是
 *    两条时间线拼起来的假历史（见 `EventRepository.truncateAfter`）。
 */

const STEP_EPSILON = 1e-9;

export type ReplayState = 'idle' | 'playing' | 'paused';

/**
 * 外部数据源：CSV / MQTT / WebSocket 适配器实现它就能接入回放。
 *
 * 关键要求是**可重放**：`rewind()` 之后按同样的时间顺序重新喂一遍，必须得到
 * 同样的帧序列。所以实现里不允许读挂钟、不允许 `Math.random()`。
 */
export interface ExternalFrameSource {
  /** 数据源覆盖的仿真时长（秒），决定时间轴长度。 */
  readonly duration?: number;
  /** 把"尚未喂过且不晚于 time"的帧喂进世界；重复调用幂等。 */
  feedTo(world: TwinWorld, time: number): void;
  /** 回到起点。seek 之后重新喂帧时调用。 */
  rewind(): void;
}

export interface ReplayControllerOptions {
  world: TwinWorld;
  storage: TwinStorage;
  sceneId?: string;
  source?: ExternalFrameSource;
  /**
   * 单帧最多补的步数（默认 600）。60Hz 下 1× 用 1 步、10× 用 10 步，
   * 想跑 100× 就得把它调到 100 以上——步长不变，确定性不变。
   */
  maxStepsPerAdvance?: number;
  /** 一次定位最多重算多少步，防止把主线程打死（默认 200000，约 55 分钟仿真）。 */
  maxSeekSteps?: number;
  /** 每帧回调，用于把差量交给 `SessionRecorder.tick` 或渲染层。 */
  onFrame?: (frame: FrameDelta) => void;
}

export class ReplayController {
  readonly world: TwinWorld;
  readonly storage: TwinStorage;

  private readonly sceneId: string;
  private readonly maxSteps: number;
  private readonly maxSeekSteps: number;
  private readonly onFrame: ((frame: FrameDelta) => void) | undefined;
  private stateValue: ReplayState = 'idle';
  private speedValue = 1;
  private carry = 0;
  private sessionValue: ReplaySession | undefined;
  private sourceValue: ExternalFrameSource | undefined;

  constructor(options: ReplayControllerOptions) {
    this.world = options.world;
    this.storage = options.storage;
    this.sceneId = options.sceneId ?? options.world.scene.id;
    this.sourceValue = options.source;
    this.maxSteps = options.maxStepsPerAdvance ?? 600;
    this.maxSeekSteps = options.maxSeekSteps ?? 200_000;
    this.onFrame = options.onFrame;
  }

  get state(): ReplayState {
    return this.stateValue;
  }

  get playing(): boolean {
    return this.stateValue === 'playing';
  }

  get speed(): number {
    return this.speedValue;
  }

  get time(): number {
    return this.world.time;
  }

  get session(): ReplaySession | undefined {
    return this.sessionValue;
  }

  /** 当前挂载的外部数据源。 */
  get source(): ExternalFrameSource | undefined {
    return this.sourceValue;
  }

  /** 时间轴长度：会话时长、数据源时长、当前时间三者取大。 */
  get duration(): number {
    return Math.max(this.sessionValue?.duration ?? 0, this.sourceValue?.duration ?? 0, this.world.time);
  }

  /**
   * 挂载或卸载外部数据源（CSV / MQTT / WebSocket 适配器）。
   *
   * 挂载后数据源从 0 开始喂；调用方需要自行把世界切到 `external` / `hybrid` 模式，
   * 因为"哪些实体听外部数据"是场景决策，不该由回放控制器猜。
   */
  attachSource(source: ExternalFrameSource | undefined): void {
    this.sourceValue = source;
    source?.rewind();
  }

  /** 读取会话元信息。不传 id 时取该场景最后一个会话。 */
  async load(sessionId?: string): Promise<ReplaySession | undefined> {
    const sessions = await this.storage.sessions.list(this.sceneId);
    this.sessionValue = sessionId ? sessions.find((item) => item.id === sessionId) : sessions[sessions.length - 1];
    return this.sessionValue;
  }

  play(speed?: number): void {
    if (speed !== undefined) this.setSpeed(speed);
    this.stateValue = 'playing';
  }

  pause(): void {
    if (this.stateValue === 'playing') this.stateValue = 'paused';
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) throw new Error('倍速必须是正数。');
    this.speedValue = speed;
    this.carry = 0;
  }

  /**
   * 渲染循环入口：吃真实帧间隔，按倍速换算成整数个固定步长。
   *
   * 这里自己管余量而不用 `world.advance`，是因为外部数据源要"每步喂一次帧"；
   * 两个时钟不会同时用，避免余量被吃掉两次。
   */
  advance(realDelta: number): FrameDelta {
    if (this.stateValue !== 'playing') return this.world.runSteps(0);
    if (!Number.isFinite(realDelta) || realDelta < 0) throw new Error('realDelta 必须是非负有限数字。');

    const step = this.world.stepSize;
    this.carry += realDelta * this.speedValue;
    let count = Math.floor((this.carry + STEP_EPSILON) / step);
    if (count > this.maxSteps) {
      count = this.maxSteps;
      this.carry = 0;
    } else {
      this.carry = Math.max(0, this.carry - count * step);
    }
    return this.runSteps(count);
  }

  /** 单步推进（忽略播放状态）。 */
  stepFrames(count = 1): FrameDelta {
    if (!Number.isInteger(count) || count < 0) throw new Error('步数必须是非负整数。');
    return this.runSteps(count);
  }

  /**
   * 定位到指定仿真时刻。
   *
   * 往回跳时：取不晚于目标的最近快照 → 恢复世界并把事件游标对齐 → 截断之后的事件
   * → 重新推演到目标。没有快照就从头重算（慢，但结果一样）。
   */
  async seek(time: number): Promise<FrameDelta> {
    if (!Number.isFinite(time)) throw new Error('目标时间必须是有限数字。');
    const target = Math.max(0, time);

    if (target < this.world.time - STEP_EPSILON) {
      const snapshot = await this.storage.snapshots.atOrBeforeTime(this.sceneId, target);
      this.sourceValue?.rewind();
      if (snapshot) {
        // `snapshot.sequence` 是"快照当时的下一条编号"，所以快照之前的事件是 1…N-1。
        this.world.restoreFrom(snapshot);
        await this.storage.events.truncateAfter(this.sceneId, snapshot.sequence - 1);
      } else {
        this.world.reset();
        await this.storage.events.truncateAfter(this.sceneId, 0);
      }
    }

    const remaining = Math.round((target - this.world.time) / this.world.stepSize);
    if (remaining > this.maxSeekSteps)
      throw new Error(`定位跨度过大：需要重算 ${remaining} 步，超过上限 ${this.maxSeekSteps}。`);
    return this.runSteps(Math.max(0, remaining));
  }

  /** 手动落一份快照（例如"从这一刻分叉"）。 */
  async snapshot(): Promise<void> {
    await this.storage.snapshots.put(this.sceneId, this.world.snapshot());
  }

  /** 事件流查询：按仿真时间区间过滤，供时间轴上的事件标记使用。 */
  async events(fromTime = 0, toTime = Number.POSITIVE_INFINITY, limit = 500): Promise<WorldEvent[]> {
    const events = await this.storage.events.query(this.sceneId, { limit });
    return events.filter((event) => event.occurredAt >= fromTime && event.occurredAt <= toTime);
  }

  private runSteps(count: number): FrameDelta {
    const frame = count <= 0 ? this.world.runSteps(0) : this.sourceValue ? this.runStepsWithSource(count) : this.world.runSteps(count);
    this.onFrame?.(frame);
    return frame;
  }

  /**
   * 有外部数据源时逐步推进：每步先把到该步为止的新帧喂进去，再让内核换算。
   *
   * 不能"一次性把所有帧喂完再跑"——那样同一实体只有最后一帧生效，
   * 位姿会直接跳到终点，中间过程全丢。
   */
  private runStepsWithSource(count: number): FrameDelta {
    const source = this.sourceValue;
    if (!source) return this.world.runSteps(count);
    let last = this.world.runSteps(0);
    for (let i = 0; i < count; i += 1) {
      source.feedTo(this.world, this.world.time + this.world.stepSize);
      last = this.world.step();
    }
    return last;
  }
}
