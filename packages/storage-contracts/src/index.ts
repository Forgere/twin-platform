import type { TwinScene, TwinTransform, TwinValue } from '@twin-platform/scene-schema';
import type { DataMode, EntityDataSource, WorldEvent, WorldSnapshot } from '@twin-platform/world-kernel';

/**
 * 仓储接口——内核与数据库之间唯一的缝。
 *
 * 内核只认这几个方法，不认 SQL、不认驱动。`storage-memory` 给浏览器演示和测试用，
 * `storage-postgres` 给服务端用，两者行为必须完全一致（同一套契约测试跑两遍，
 * 见 `@twin-platform/storage-contracts/testing`）。
 *
 * 全部异步：现在内存实现是瞬时的，但契约必须按"会慢"来设计，否则换成
 * PostgreSQL 时调用方全得改。
 */

export interface SceneSummary {
  id: string;
  name: string;
  version: number;
  updatedAt: string;
}

export interface SceneRepository {
  getScene(id: string): Promise<TwinScene | null>;
  putScene(scene: TwinScene): Promise<SceneSummary>;
  listScenes(): Promise<SceneSummary[]>;
}

export interface EventQuery {
  /** 严格大于该 sequence。 */
  sinceSequence?: number;
  untilSequence?: number;
  entityId?: string;
  type?: string;
  limit?: number;
}

export interface EventRepository {
  /** 追加事件。返回写入条数；sequence 必须严格单调，否则抛错（说明调用方重复回放）。 */
  append(sceneId: string, events: readonly WorldEvent[]): Promise<number>;
  query(sceneId: string, query?: EventQuery): Promise<WorldEvent[]>;
  /** 已落库的最大 sequence，回放起始游标。 */
  latestSequence(sceneId: string): Promise<number>;
  /**
   * 删除 sequence 严格大于给定值的事件，返回删除条数——回放分叉用。
   *
   * 从历史时刻重新推演时，那条时间线之后已记录的事件就作废了；不截断的话
   * 新时间线的事件会接在旧事件后面，回放出来的"历史"是两条时间线拼接的假历史。
   */
  truncateAfter(sceneId: string, sequence: number): Promise<number>;
}

export interface SnapshotRepository {
  put(sceneId: string, snapshot: WorldSnapshot): Promise<void>;
  latest(sceneId: string): Promise<WorldSnapshot | null>;
  /** 取不晚于 `sequence` 的最近一份快照——回放从它开始重放事件。 */
  atOrBefore(sceneId: string, sequence: number): Promise<WorldSnapshot | null>;
  /** 取不晚于 `time`（仿真秒）的最近一份快照——时间轴拖拽定位用。 */
  atOrBeforeTime(sceneId: string, time: number): Promise<WorldSnapshot | null>;
}

/**
 * 回放会话——一次录制或一次确定性重放的"锁定信息"。
 *
 * 场景版本、seed、步长、模式锁住之后，同一个会话无论重放多少次、
 * 多少倍速，都必须得到同一串事件和同一个末态；这是回放可信的前提。
 */
export interface ReplaySession {
  id: string;
  sceneId: string;
  /** 会话锁定的场景版本，场景变更后旧会话依旧按老版本重放。 */
  sceneVersion: number;
  seed: number;
  step: number;
  mode: DataMode;
  label?: string;
  /** 会话创建（挂钟）时间，仅审计用，不参与仿真。 */
  createdAt: string;
  /** 结束时写入的仿真时长（秒）；未结束为空。 */
  duration?: number;
  /** 插件 id → 锁定版本，供阶段 D 的插件锁使用。 */
  pluginLocks?: Record<string, string>;
}

export interface SessionRepository {
  put(session: ReplaySession): Promise<void>;
  get(id: string): Promise<ReplaySession | null>;
  list(sceneId: string): Promise<ReplaySession[]>;
  /** 结束会话并写入仿真时长。 */
  finish(id: string, duration: number): Promise<void>;
}

/**
 * 最新状态投影（`entity_state_latest`）。
 *
 * 事件流是真相，但工作台打开时要立刻看到"现在长什么样"，不能每次重放几万条事件。
 * 所以这里是事件流的物化投影：可重建、可丢弃，永远不作为真相来源。
 */
export interface EntityStateRecord {
  entityId: string;
  kind: string;
  status?: string;
  attrs: Record<string, TwinValue>;
  transform: TwinTransform;
  dataSource: EntityDataSource;
  /** 产生该状态的最后一条事件 sequence，用于判断投影是否落后于事件流。 */
  updatedSequence: number;
  /** 该状态对应的仿真时间（秒）。 */
  updatedAt: number;
}

export interface EntityStateRepository {
  upsert(sceneId: string, records: readonly EntityStateRecord[]): Promise<number>;
  get(sceneId: string, entityId: string): Promise<EntityStateRecord | null>;
  list(sceneId: string): Promise<EntityStateRecord[]>;
}

/**
 * 基础指标聚合（`metric_rollups`）。
 *
 * 一期只做"按桶累加"：`value` 累加、`count` 计数，桶由 `bucketStart + bucketSize`
 * 唯一确定。更复杂的窗口统计（P95、滑窗）留给阶段 D 的 `analytics-core`，
 * 但落库形状从现在就固定，避免以后改表。
 */
export interface MetricRollup {
  sceneId: string;
  /** 指标名，例如 `event.count`、`device.downtime`。 */
  metric: string;
  entityId?: string;
  /** 桶起点（仿真秒），必须是 `bucketSize` 的整数倍。 */
  bucketStart: number;
  /** 桶长度（秒）。 */
  bucketSize: number;
  value: number;
  count: number;
}

export interface MetricQuery {
  metric?: string;
  entityId?: string;
  fromBucket?: number;
  toBucket?: number;
}

export interface MetricRepository {
  /** 按 (sceneId, metric, entityId, bucketStart, bucketSize) 累加写入。 */
  put(rollups: readonly MetricRollup[]): Promise<number>;
  query(sceneId: string, query?: MetricQuery): Promise<MetricRollup[]>;
}

export interface TwinStorage {
  readonly scenes: SceneRepository;
  readonly events: EventRepository;
  readonly snapshots: SnapshotRepository;
  readonly sessions: SessionRepository;
  readonly state: EntityStateRepository;
  readonly metrics: MetricRepository;
}
