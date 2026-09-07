import type { TwinScene } from '@twin-platform/scene-schema';
import type { WorldEvent, WorldSnapshot } from '@twin-platform/world-kernel';
import type {
  EntityStateRecord,
  EntityStateRepository,
  EventQuery,
  EventRepository,
  MetricQuery,
  MetricRepository,
  MetricRollup,
  ReplaySession,
  SceneRepository,
  SceneSummary,
  SessionRepository,
  SnapshotRepository,
  TwinStorage,
} from '@twin-platform/storage-contracts';

/**
 * 内存仓储：浏览器演示、单元测试、以及"不装数据库也能跑"的默认实现。
 *
 * 刻意做成异步并强制深拷贝——和真数据库一样"取出来的是副本"，
 * 这样调用方不会在内存实现下能跑、换 Postgres 后因为共享引用而炸。
 *
 * 排序规则也是契约的一部分：`list` 一律按确定顺序返回（会话按创建顺序、
 * 状态按 entityId、指标按 metric+bucketStart），Postgres 实现必须用 ORDER BY
 * 给出同样顺序，否则同一份数据在不同 Adapter 上会渲染出不同的顺序。
 */

const clone = <T,>(value: T): T => structuredClone(value);

class MemorySceneRepository implements SceneRepository {
  private readonly scenes = new Map<string, { scene: TwinScene; updatedAt: string }>();

  clear(): void {
    this.scenes.clear();
  }

  async getScene(id: string): Promise<TwinScene | null> {
    const entry = this.scenes.get(id);
    return entry ? clone(entry.scene) : null;
  }

  async putScene(scene: TwinScene): Promise<SceneSummary> {
    const updatedAt = new Date().toISOString();
    this.scenes.set(scene.id, { scene: clone(scene), updatedAt });
    return { id: scene.id, name: scene.name, version: scene.version, updatedAt };
  }

  async listScenes(): Promise<SceneSummary[]> {
    return [...this.scenes.entries()].map(([id, entry]) => ({
      id,
      name: entry.scene.name,
      version: entry.scene.version,
      updatedAt: entry.updatedAt,
    }));
  }
}

class MemoryEventRepository implements EventRepository {
  private readonly events = new Map<string, WorldEvent[]>();

  clear(): void {
    this.events.clear();
  }

  async append(sceneId: string, events: readonly WorldEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const log = this.events.get(sceneId) ?? [];
    const last = log[log.length - 1];
    for (const event of events) {
      if (last && event.sequence <= last.sequence)
        throw new Error(`事件 sequence 必须严格单调：${event.sequence} <= ${last.sequence}。`);
      log.push(clone(event));
    }
    this.events.set(sceneId, log);
    return events.length;
  }

  async query(sceneId: string, query: EventQuery = {}): Promise<WorldEvent[]> {
    const log = this.events.get(sceneId) ?? [];
    const filtered = log.filter((event) => {
      if (query.sinceSequence !== undefined && event.sequence <= query.sinceSequence) return false;
      if (query.untilSequence !== undefined && event.sequence > query.untilSequence) return false;
      if (query.entityId !== undefined && event.entityId !== query.entityId) return false;
      if (query.type !== undefined && event.type !== query.type) return false;
      return true;
    });
    return clone(query.limit !== undefined ? filtered.slice(0, query.limit) : filtered);
  }

  async latestSequence(sceneId: string): Promise<number> {
    const log = this.events.get(sceneId) ?? [];
    return log.length === 0 ? 0 : (log[log.length - 1]?.sequence ?? 0);
  }

  async truncateAfter(sceneId: string, sequence: number): Promise<number> {
    const log = this.events.get(sceneId) ?? [];
    const kept = log.filter((event) => event.sequence <= sequence);
    const removed = log.length - kept.length;
    this.events.set(sceneId, kept);
    return removed;
  }
}

class MemorySnapshotRepository implements SnapshotRepository {
  private readonly snapshots = new Map<string, WorldSnapshot[]>();

  clear(): void {
    this.snapshots.clear();
  }

  async put(sceneId: string, snapshot: WorldSnapshot): Promise<void> {
    const list = this.snapshots.get(sceneId) ?? [];
    list.push(clone(snapshot));
    // 按 sequence 升序；同一时刻只保留最新一份。
    list.sort((a, b) => a.sequence - b.sequence);
    this.snapshots.set(sceneId, list);
  }

  async latest(sceneId: string): Promise<WorldSnapshot | null> {
    const list = this.snapshots.get(sceneId) ?? [];
    const last = list[list.length - 1];
    return last ? clone(last) : null;
  }

  async atOrBefore(sceneId: string, sequence: number): Promise<WorldSnapshot | null> {
    const list = this.snapshots.get(sceneId) ?? [];
    let found: WorldSnapshot | undefined;
    for (const snapshot of list) if (snapshot.sequence <= sequence) found = snapshot;
    return found ? clone(found) : null;
  }

  async atOrBeforeTime(sceneId: string, time: number): Promise<WorldSnapshot | null> {
    const list = this.snapshots.get(sceneId) ?? [];
    let found: WorldSnapshot | undefined;
    for (const snapshot of list) if (snapshot.time <= time) found = snapshot;
    return found ? clone(found) : null;
  }
}

class MemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, Map<string, ReplaySession>>();

  clear(): void {
    this.sessions.clear();
  }

  private bucket(sceneId: string): Map<string, ReplaySession> {
    const found = this.sessions.get(sceneId);
    if (found) return found;
    const created = new Map<string, ReplaySession>();
    this.sessions.set(sceneId, created);
    return created;
  }

  async put(session: ReplaySession): Promise<void> {
    this.bucket(session.sceneId).set(session.id, clone(session));
  }

  async get(id: string): Promise<ReplaySession | null> {
    for (const bucket of this.sessions.values()) {
      const found = bucket.get(id);
      if (found) return clone(found);
    }
    return null;
  }

  async list(sceneId: string): Promise<ReplaySession[]> {
    return [...this.bucket(sceneId).values()].map(clone);
  }

  async finish(id: string, duration: number): Promise<void> {
    for (const bucket of this.sessions.values()) {
      const found = bucket.get(id);
      if (!found) continue;
      bucket.set(id, { ...found, duration });
      return;
    }
    throw new Error(`回放会话 ${id} 不存在，无法结束。`);
  }
}

class MemoryEntityStateRepository implements EntityStateRepository {
  private readonly states = new Map<string, Map<string, EntityStateRecord>>();

  clear(): void {
    this.states.clear();
  }

  private bucket(sceneId: string): Map<string, EntityStateRecord> {
    const found = this.states.get(sceneId);
    if (found) return found;
    const created = new Map<string, EntityStateRecord>();
    this.states.set(sceneId, created);
    return created;
  }

  async upsert(sceneId: string, records: readonly EntityStateRecord[]): Promise<number> {
    const bucket = this.bucket(sceneId);
    for (const record of records) bucket.set(record.entityId, clone(record));
    return records.length;
  }

  async get(sceneId: string, entityId: string): Promise<EntityStateRecord | null> {
    const found = this.bucket(sceneId).get(entityId);
    return found ? clone(found) : null;
  }

  async list(sceneId: string): Promise<EntityStateRecord[]> {
    return [...this.bucket(sceneId).values()].sort((a, b) => a.entityId.localeCompare(b.entityId)).map(clone);
  }
}

class MemoryMetricRepository implements MetricRepository {
  /** 键：`metric|entityId|bucketStart|bucketSize`。 */
  private readonly rollups = new Map<string, Map<string, MetricRollup>>();

  clear(): void {
    this.rollups.clear();
  }

  private bucket(sceneId: string): Map<string, MetricRollup> {
    const found = this.rollups.get(sceneId);
    if (found) return found;
    const created = new Map<string, MetricRollup>();
    this.rollups.set(sceneId, created);
    return created;
  }

  private static keyOf(rollup: MetricRollup): string {
    return `${rollup.metric}|${rollup.entityId ?? ''}|${rollup.bucketStart}|${rollup.bucketSize}`;
  }

  async put(rollups: readonly MetricRollup[]): Promise<number> {
    for (const rollup of rollups) {
      const bucket = this.bucket(rollup.sceneId);
      const key = MemoryMetricRepository.keyOf(rollup);
      const existing = bucket.get(key);
      bucket.set(key, {
        ...rollup,
        value: (existing?.value ?? 0) + rollup.value,
        count: (existing?.count ?? 0) + rollup.count,
      });
    }
    return rollups.length;
  }

  async query(sceneId: string, query: MetricQuery = {}): Promise<MetricRollup[]> {
    const bucket = this.rollups.get(sceneId);
    if (!bucket) return [];
    return [...bucket.values()]
      .filter((rollup) => {
        if (query.metric !== undefined && rollup.metric !== query.metric) return false;
        if (query.entityId !== undefined && rollup.entityId !== query.entityId) return false;
        if (query.fromBucket !== undefined && rollup.bucketStart < query.fromBucket) return false;
        if (query.toBucket !== undefined && rollup.bucketStart > query.toBucket) return false;
        return true;
      })
      .sort((a, b) => a.metric.localeCompare(b.metric) || a.bucketStart - b.bucketStart || (a.entityId ?? '').localeCompare(b.entityId ?? ''))
      .map(clone);
  }
}

export interface MemoryStorage extends TwinStorage {
  /** 仅用于测试：清空全部数据。 */
  clear(): void;
}

export function createMemoryStorage(): MemoryStorage {
  const scenes = new MemorySceneRepository();
  const events = new MemoryEventRepository();
  const snapshots = new MemorySnapshotRepository();
  const sessions = new MemorySessionRepository();
  const state = new MemoryEntityStateRepository();
  const metrics = new MemoryMetricRepository();

  return {
    scenes,
    events,
    snapshots,
    sessions,
    state,
    metrics,
    clear() {
      scenes.clear();
      events.clear();
      snapshots.clear();
      sessions.clear();
      state.clear();
      metrics.clear();
    },
  };
}
