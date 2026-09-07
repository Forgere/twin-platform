import type { EntityStateRecord, MetricRollup, ReplaySession, TwinStorage } from '@twin-platform/storage-contracts';
import type { FrameDelta, TwinWorld, WorldEvent } from '@twin-platform/world-kernel';

/**
 * 会话录制器：把内核吐出来的东西搬进仓储。
 *
 * 它不推演任何状态——只做三件搬运工作（事件、快照、投影）加一件聚合（指标）。
 * 因此"录制"不可能改变仿真结果：开着录制和关着录制跑出来的世界必须一模一样。
 */

export interface SessionRecorderOptions {
  /** 显式会话 id。省略时用 `场景#创建时间`，同一场景重复录制会新增会话而不是覆盖。 */
  sessionId?: string;
  label?: string;
  /** 每隔多少步落一份快照（默认 600，60Hz 下约 10 秒）。 */
  snapshotIntervalSteps?: number;
  /** 指标桶长度（秒），默认 60；传 0 关闭指标。 */
  metricBucketSize?: number;
  /** 挂钟时间注入。默认 `Date.now()`，但它在测试里必须被固定住，否则会话 id 不可复现。 */
  now?: () => string;
  pluginLocks?: Record<string, string>;
}

export class SessionRecorder {
  readonly session: ReplaySession;

  private readonly world: TwinWorld;
  private readonly storage: TwinStorage;
  private readonly sceneId: string;
  private readonly snapshotInterval: number;
  private readonly metricBucketSize: number;
  private lastSnapshotStep = 0;
  private closed = false;

  constructor(world: TwinWorld, storage: TwinStorage, options: SessionRecorderOptions = {}) {
    this.world = world;
    this.storage = storage;
    this.sceneId = world.scene.id;
    this.snapshotInterval = options.snapshotIntervalSteps ?? 600;
    this.metricBucketSize = options.metricBucketSize ?? 60;

    const createdAt = (options.now ?? (() => new Date().toISOString()))();
    this.session = {
      id: options.sessionId ?? `${this.sceneId}#${createdAt}`,
      sceneId: this.sceneId,
      sceneVersion: world.scene.version,
      seed: world.seed,
      step: world.stepSize,
      mode: world.dataModeValue,
      createdAt,
      ...(options.label !== undefined ? { label: options.label } : {}),
      ...(options.pluginLocks !== undefined ? { pluginLocks: { ...options.pluginLocks } } : {}),
    };
  }

  /** 登记会话并落下 t=0 的初始快照——没有它，seek 回 0 就只能从头重算。 */
  async start(): Promise<ReplaySession> {
    await this.storage.scenes.putScene(this.world.scene);
    await this.storage.sessions.put(this.session);
    await this.storage.snapshots.put(this.sceneId, this.world.snapshot());
    this.lastSnapshotStep = this.world.stepCount;
    return this.session;
  }

  /**
   * 每个渲染帧调用一次。
   *
   * @param frame 本帧的差量；给了就顺带刷新最新状态投影，不给只落事件与指标。
   * @returns 本次落库的事件条数。
   */
  async tick(frame?: FrameDelta): Promise<number> {
    if (this.closed) throw new Error('会话已结束，不能再写入。');

    const pending = this.world.drainEvents();
    if (pending.length > 0) {
      await this.storage.events.append(this.sceneId, pending);
      if (this.metricBucketSize > 0) await this.storage.metrics.put(this.toRollups(pending));
    }

    if (frame) {
      const records = this.toStateRecords(frame);
      if (records.length > 0) await this.storage.state.upsert(this.sceneId, records);
    }

    if (this.world.stepCount - this.lastSnapshotStep >= this.snapshotInterval) {
      await this.storage.snapshots.put(this.sceneId, this.world.snapshot());
      this.lastSnapshotStep = this.world.stepCount;
    }

    return pending.length;
  }

  /** 落一份快照并结束会话，写入仿真时长。 */
  async close(): Promise<ReplaySession> {
    if (this.closed) return this.session;
    await this.tick();
    await this.storage.snapshots.put(this.sceneId, this.world.snapshot());
    await this.storage.sessions.finish(this.session.id, this.world.time);
    this.closed = true;
    return { ...this.session, duration: this.world.time };
  }

  private toStateRecords(frame: FrameDelta): EntityStateRecord[] {
    const records: EntityStateRecord[] = [];
    for (const delta of frame.changed) {
      const state = this.world.getEntity(delta.id);
      if (!state || !delta.transform) continue;
      records.push({
        entityId: state.id,
        kind: state.kind,
        status: state.status,
        attrs: { ...state.attrs },
        transform: { ...delta.transform, position: [...delta.transform.position] },
        dataSource: state.dataSource,
        updatedSequence: frame.sequence,
        updatedAt: frame.time,
      });
    }
    return records;
  }

  /**
   * 每个事件产两条聚合：场景级总计数，以及带实体的分类计数。
   *
   * 一期的指标就这一层（计数 + 累加），更复杂的窗口统计留给阶段 D 的
   * `analytics-core`，但落库的桶形状从现在就固定。
   */
  private toRollups(events: readonly WorldEvent[]): MetricRollup[] {
    const rollups: MetricRollup[] = [];
    for (const event of events) {
      const bucketStart = Math.floor(event.occurredAt / this.metricBucketSize) * this.metricBucketSize;
      rollups.push({ sceneId: this.sceneId, metric: 'event.count', bucketStart, bucketSize: this.metricBucketSize, value: 1, count: 1 });
      rollups.push({
        sceneId: this.sceneId,
        metric: `event:${event.type}`,
        bucketStart,
        bucketSize: this.metricBucketSize,
        value: 1,
        count: 1,
        ...(event.entityId !== undefined ? { entityId: event.entityId } : {}),
      });
    }
    return rollups;
  }
}
