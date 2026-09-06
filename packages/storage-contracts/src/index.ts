import type { TwinScene } from '@twin-platform/scene-schema';
import type { WorldEvent, WorldSnapshot } from '@twin-platform/world-kernel';

/**
 * 仓储接口——内核与数据库之间唯一的缝。
 *
 * 内核只认这几个方法，不认 SQL、不认驱动。`storage-memory` 给浏览器演示和测试用，
 * `storage-postgres` 给服务端用，两者行为必须完全一致（同一套契约测试跑两遍）。
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
}

export interface SnapshotRepository {
  put(sceneId: string, snapshot: WorldSnapshot): Promise<void>;
  latest(sceneId: string): Promise<WorldSnapshot | null>;
  /** 取不晚于 `sequence` 的最近一份快照——回放从它开始重放事件。 */
  atOrBefore(sceneId: string, sequence: number): Promise<WorldSnapshot | null>;
}

export interface TwinStorage {
  readonly scenes: SceneRepository;
  readonly events: EventRepository;
  readonly snapshots: SnapshotRepository;
}
