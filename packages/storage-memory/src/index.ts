import { applySceneOps, type SceneOp, type TwinScene } from '@twin-platform/scene-schema';
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
  SceneVersionSummary,
  SessionRepository,
  SnapshotRepository,
  TwinStorage,
} from '@twin-platform/storage-contracts';
import { SceneVersionConflictError } from '@twin-platform/storage-contracts';

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

type MemoryVersion =
  | { version: number; kind: 'snapshot'; scene: TwinScene; createdAt: string }
  | { version: number; kind: 'ops'; ops: SceneOp[]; createdAt: string };

interface MemorySceneEntry {
  scene: TwinScene;
  updatedAt: string;
  /** 按 version 升序。快照存整文档，ops 只存动作。 */
  versions: MemoryVersion[];
}

class MemorySceneRepository implements SceneRepository {
  private readonly scenes = new Map<string, MemorySceneEntry>();

  clear(): void {
    this.scenes.clear();
  }

  private static nextVersion(entry: MemorySceneEntry): number {
    return (entry.versions[entry.versions.length - 1]?.version ?? 0) + 1;
  }

  private static currentVersion(entry: MemorySceneEntry): number {
    return entry.versions[entry.versions.length - 1]?.version ?? 0;
  }

  /** 取最近一份不晚于 target 的快照，再重放它之后的 ops。 */
  private static reconstruct(entry: MemorySceneEntry, target: number): TwinScene | null {
    let scene: TwinScene | undefined;
    let snapshotVersion = 0;
    for (const row of entry.versions) {
      if (row.version > target) break;
      if (row.kind === 'snapshot') {
        scene = row.scene;
        snapshotVersion = row.version;
      }
    }
    if (!scene) return null;
    let rebuilt = clone(scene);
    for (const row of entry.versions) {
      if (row.kind !== 'ops' || row.version <= snapshotVersion || row.version > target) continue;
      rebuilt = applySceneOps(rebuilt, row.ops);
    }
    return rebuilt;
  }

  private static summary(entry: MemorySceneEntry): SceneSummary {
    return {
      id: entry.scene.id,
      name: entry.scene.name,
      version: MemorySceneRepository.currentVersion(entry),
      updatedAt: entry.updatedAt,
    };
  }

  async getScene(id: string): Promise<TwinScene | null> {
    const entry = this.scenes.get(id);
    if (!entry) return null;
    return MemorySceneRepository.reconstruct(entry, MemorySceneRepository.currentVersion(entry));
  }

  async putScene(scene: TwinScene): Promise<SceneSummary> {
    const updatedAt = new Date().toISOString();
    const existing = this.scenes.get(scene.id);
    const entry: MemorySceneEntry = existing ?? { scene: clone(scene), updatedAt, versions: [] };
    entry.scene = clone(scene);
    entry.updatedAt = updatedAt;
    entry.versions.push({
      version: MemorySceneRepository.nextVersion(entry),
      kind: 'snapshot',
      scene: clone(scene),
      createdAt: updatedAt,
    });
    this.scenes.set(scene.id, entry);
    return MemorySceneRepository.summary(entry);
  }

  async appendOps(sceneId: string, baseVersion: number, ops: readonly SceneOp[]): Promise<SceneSummary> {
    const entry = this.scenes.get(sceneId);
    const current = entry ? MemorySceneRepository.currentVersion(entry) : 0;
    if (!entry || baseVersion !== current) throw new SceneVersionConflictError(sceneId, baseVersion, current);
    if (ops.length === 0) return MemorySceneRepository.summary(entry);

    const next = applySceneOps(entry.scene, ops);
    const updatedAt = new Date().toISOString();
    entry.scene = next;
    entry.updatedAt = updatedAt;
    entry.versions.push({
      version: MemorySceneRepository.nextVersion(entry),
      kind: 'ops',
      ops: ops.map((op) => clone(op)),
      createdAt: updatedAt,
    });
    return MemorySceneRepository.summary(entry);
  }

  async listVersions(sceneId: string): Promise<SceneVersionSummary[]> {
    const entry = this.scenes.get(sceneId);
    if (!entry) return [];
    return entry.versions.map((row) => ({
      sceneId,
      version: row.version,
      kind: row.kind,
      opCount: row.kind === 'ops' ? row.ops.length : 0,
      name: entry.scene.name,
      createdAt: row.createdAt,
    }));
  }

  async getVersion(sceneId: string, version: number): Promise<TwinScene | null> {
    const entry = this.scenes.get(sceneId);
    if (!entry || !Number.isInteger(version) || version < 1) return null;
    if (version > MemorySceneRepository.currentVersion(entry)) return null;
    return MemorySceneRepository.reconstruct(entry, version);
  }

  async listScenes(): Promise<SceneSummary[]> {
    return [...this.scenes.values()].map(MemorySceneRepository.summary);
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
