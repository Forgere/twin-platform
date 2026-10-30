import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
 * 文件仓储：把整套状态落成一个 JSON 文件。
 *
 * 存在的理由：**服务端要有持久化，但不该被数据库绑架。**
 * 一上来就要求装 PostgreSQL，会让"起个服务端看看"变成一件需要运维的事。
 * 这份实现零依赖、单文件、能直接 `cat` 和 `git diff`，足够撑到真实数据量上来；
 * 之后换 Postgres 只需换一个 `TwinStorage` 实现，调用方一行不改。
 *
 * 语义必须与 `storage-memory` **逐条一致**（排序、单调性、副本语义），
 * 否则同一份数据在不同后端会渲染出不同顺序——那是契约级 bug，不是实现细节。
 */

const DATA_VERSION = 1;

interface FileStorageData {
  version: number;
  scenes: Record<string, { scene: TwinScene; updatedAt: string }>;
  /** sceneId → 事件流（按 sequence 升序）。 */
  events: Record<string, WorldEvent[]>;
  /** sceneId → 快照流（按 sequence 升序）。 */
  snapshots: Record<string, WorldSnapshot[]>;
  /** sessionId → 会话（会话自带 sceneId）。 */
  sessions: Record<string, ReplaySession>;
  /** sceneId → entityId → 状态投影。 */
  state: Record<string, Record<string, EntityStateRecord>>;
  /** 全部指标桶（自带 sceneId）。 */
  metrics: MetricRollup[];
}

const clone = <T,>(value: T): T => structuredClone(value);

const emptyData = (): FileStorageData => ({
  version: DATA_VERSION,
  scenes: {},
  events: {},
  snapshots: {},
  sessions: {},
  state: {},
  metrics: [],
});

export interface FileStorageOptions {
  /** 数据文件路径，例如 `data/twin.json`。 */
  path: string;
  /**
   * 合并写入窗口（毫秒），默认 250ms。
   *
   * 事件是逐条追加的，若每次都整文件重写，几千条事件就能把磁盘打满；
   * 合成一个窗口后，一次 flush 写完最近所有改动。
   */
  flushMs?: number;
  /** 关闭这个窗口内的 flush（测试里要精确控制落盘时机）。 */
  autoFlush?: boolean;
}

/** 场景仓储多一个 `remove`：契约里没有，但服务端 DELETE 需要连带清理。 */
export interface FileSceneRepository extends SceneRepository {
  /** 删除场景及其全部派生数据（事件 / 快照 / 状态 / 指标 / 会话）。 */
  remove(id: string): Promise<boolean>;
}

export interface FileStorage extends TwinStorage {
  readonly scenes: FileSceneRepository;
  /** 立刻把改动写到磁盘。进程退出前必须调一次，否则窗口内的改动会丢。 */
  flush(): Promise<void>;
  /** 丢弃内存数据，从磁盘重新加载（外部改了文件时用）。 */
  reload(): Promise<void>;
  /** 清空全部数据并落盘。 */
  clear(): Promise<void>;
  /** 当前数据文件路径。 */
  readonly path: string;
}

class FileSceneRepositoryImpl implements FileSceneRepository {
  constructor(private readonly store: Store) {}

  async getScene(id: string): Promise<TwinScene | null> {
    const entry = this.store.data.scenes[id];
    return entry ? clone(entry.scene) : null;
  }

  async putScene(scene: TwinScene): Promise<SceneSummary> {
    const updatedAt = new Date().toISOString();
    this.store.data.scenes[scene.id] = { scene: clone(scene), updatedAt };
    this.store.touch();
    return { id: scene.id, name: scene.name, version: scene.version, updatedAt };
  }

  async listScenes(): Promise<SceneSummary[]> {
    return Object.entries(this.store.data.scenes).map(([id, entry]) => ({
      id,
      name: entry.scene.name,
      version: entry.scene.version,
      updatedAt: entry.updatedAt,
    }));
  }

  async remove(id: string): Promise<boolean> {
    if (!this.store.data.scenes[id]) return false;
    delete this.store.data.scenes[id];
    delete this.store.data.events[id];
    delete this.store.data.snapshots[id];
    delete this.store.data.state[id];
    this.store.data.metrics = this.store.data.metrics.filter((rollup) => rollup.sceneId !== id);
    for (const [sessionId, session] of Object.entries(this.store.data.sessions)) {
      if (session.sceneId === id) delete this.store.data.sessions[sessionId];
    }
    this.store.touch();
    return true;
  }
}

class FileEventRepository implements EventRepository {
  constructor(private readonly store: Store) {}

  private log(sceneId: string): WorldEvent[] {
    return (this.store.data.events[sceneId] ??= []);
  }

  async append(sceneId: string, events: readonly WorldEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const log = this.log(sceneId);
    const last = log[log.length - 1];
    for (const event of events) {
      if (last && event.sequence <= last.sequence)
        throw new Error(`事件 sequence 必须严格单调：${event.sequence} <= ${last.sequence}。`);
      log.push(clone(event));
    }
    this.store.touch();
    return events.length;
  }

  async query(sceneId: string, query: EventQuery = {}): Promise<WorldEvent[]> {
    const filtered = this.log(sceneId).filter((event) => {
      if (query.sinceSequence !== undefined && event.sequence <= query.sinceSequence) return false;
      if (query.untilSequence !== undefined && event.sequence > query.untilSequence) return false;
      if (query.entityId !== undefined && event.entityId !== query.entityId) return false;
      if (query.type !== undefined && event.type !== query.type) return false;
      return true;
    });
    return clone(query.limit !== undefined ? filtered.slice(0, query.limit) : filtered);
  }

  async latestSequence(sceneId: string): Promise<number> {
    const log = this.log(sceneId);
    return log.length === 0 ? 0 : (log[log.length - 1]?.sequence ?? 0);
  }

  async truncateAfter(sceneId: string, sequence: number): Promise<number> {
    const log = this.log(sceneId);
    const kept = log.filter((event) => event.sequence <= sequence);
    const removed = log.length - kept.length;
    this.store.data.events[sceneId] = kept;
    if (removed > 0) this.store.touch();
    return removed;
  }
}

class FileSnapshotRepository implements SnapshotRepository {
  constructor(private readonly store: Store) {}

  private list(sceneId: string): WorldSnapshot[] {
    return (this.store.data.snapshots[sceneId] ??= []);
  }

  async put(sceneId: string, snapshot: WorldSnapshot): Promise<void> {
    const list = this.list(sceneId);
    list.push(clone(snapshot));
    list.sort((a, b) => a.sequence - b.sequence);
    this.store.touch();
  }

  async latest(sceneId: string): Promise<WorldSnapshot | null> {
    const list = this.list(sceneId);
    const last = list[list.length - 1];
    return last ? clone(last) : null;
  }

  async atOrBefore(sceneId: string, sequence: number): Promise<WorldSnapshot | null> {
    let found: WorldSnapshot | undefined;
    for (const snapshot of this.list(sceneId)) if (snapshot.sequence <= sequence) found = snapshot;
    return found ? clone(found) : null;
  }

  async atOrBeforeTime(sceneId: string, time: number): Promise<WorldSnapshot | null> {
    let found: WorldSnapshot | undefined;
    for (const snapshot of this.list(sceneId)) if (snapshot.time <= time) found = snapshot;
    return found ? clone(found) : null;
  }
}

class FileSessionRepository implements SessionRepository {
  constructor(private readonly store: Store) {}

  async put(session: ReplaySession): Promise<void> {
    this.store.data.sessions[session.id] = clone(session);
    this.store.touch();
  }

  async get(id: string): Promise<ReplaySession | null> {
    const found = this.store.data.sessions[id];
    return found ? clone(found) : null;
  }

  async list(sceneId: string): Promise<ReplaySession[]> {
    return Object.values(this.store.data.sessions)
      .filter((session) => session.sceneId === sceneId)
      .map(clone);
  }

  async finish(id: string, duration: number): Promise<void> {
    const found = this.store.data.sessions[id];
    if (!found) throw new Error(`回放会话 ${id} 不存在，无法结束。`);
    this.store.data.sessions[id] = { ...found, duration };
    this.store.touch();
  }
}

class FileEntityStateRepository implements EntityStateRepository {
  constructor(private readonly store: Store) {}

  private bucket(sceneId: string): Record<string, EntityStateRecord> {
    return (this.store.data.state[sceneId] ??= {});
  }

  async upsert(sceneId: string, records: readonly EntityStateRecord[]): Promise<number> {
    const bucket = this.bucket(sceneId);
    for (const record of records) bucket[record.entityId] = clone(record);
    if (records.length > 0) this.store.touch();
    return records.length;
  }

  async get(sceneId: string, entityId: string): Promise<EntityStateRecord | null> {
    const found = this.bucket(sceneId)[entityId];
    return found ? clone(found) : null;
  }

  async list(sceneId: string): Promise<EntityStateRecord[]> {
    return Object.values(this.bucket(sceneId))
      .sort((a, b) => a.entityId.localeCompare(b.entityId))
      .map(clone);
  }
}

class FileMetricRepository implements MetricRepository {
  constructor(private readonly store: Store) {}

  private static keyOf(rollup: MetricRollup): string {
    return `${rollup.sceneId}|${rollup.metric}|${rollup.entityId ?? ''}|${rollup.bucketStart}|${rollup.bucketSize}`;
  }

  async put(rollups: readonly MetricRollup[]): Promise<number> {
    if (rollups.length === 0) return 0;
    const index = new Map(this.store.data.metrics.map((rollup) => [FileMetricRepository.keyOf(rollup), rollup]));
    for (const rollup of rollups) {
      const key = FileMetricRepository.keyOf(rollup);
      const existing = index.get(key);
      if (existing) {
        // 契约是"累加写入"：同名同桶必须叠加，不能覆盖。
        existing.value += rollup.value;
        existing.count += rollup.count;
      } else {
        const created = clone(rollup);
        index.set(key, created);
        this.store.data.metrics.push(created);
      }
    }
    this.store.touch();
    return rollups.length;
  }

  async query(sceneId: string, query: MetricQuery = {}): Promise<MetricRollup[]> {
    return this.store.data.metrics
      .filter((rollup) => {
        if (rollup.sceneId !== sceneId) return false;
        if (query.metric !== undefined && rollup.metric !== query.metric) return false;
        if (query.entityId !== undefined && rollup.entityId !== query.entityId) return false;
        if (query.fromBucket !== undefined && rollup.bucketStart < query.fromBucket) return false;
        if (query.toBucket !== undefined && rollup.bucketStart > query.toBucket) return false;
        return true;
      })
      .sort(
        (a, b) =>
          a.metric.localeCompare(b.metric) ||
          a.bucketStart - b.bucketStart ||
          (a.entityId ?? '').localeCompare(b.entityId ?? ''),
      )
      .map(clone);
  }
}

/**
 * 共享的可变状态与落盘调度。
 *
 * 六个仓储都持有同一个 Store：它们操作的是同一份 `data`，落盘也统一在这里排程。
 */
class Store {
  data: FileStorageData = emptyData();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly flushMs: number,
    private readonly autoFlush: boolean,
  ) {}

  touch(): void {
    if (!this.autoFlush) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.schedule(), this.flushMs);
    // 不阻止进程退出：窗口内的改动由调用方在退出前 flush()。
    this.timer.unref?.();
  }

  private schedule(): Promise<void> {
    this.writing = this.writing.then(() => this.write());
    return this.writing;
  }

  /** 立即落盘（取消待执行的窗口）。 */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.schedule();
  }

  private async write(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // 先写临时文件再 rename：中途崩溃不会留下半个 JSON 把整个库搞坏。
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data), 'utf8');
    await rename(tmp, this.path);
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as Partial<FileStorageData>;
      this.data = { ...emptyData(), ...parsed, version: DATA_VERSION };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // 文件不存在是正常首次启动，留一份空数据即可。
      this.data = emptyData();
    }
  }

  reset(): void {
    this.data = emptyData();
  }
}

/**
 * 创建文件仓储。
 *
 * 注意：`createFileStorage` 是同步返回的，但磁盘读取发生在 `ready()` 里——
 * 构造函数不能是异步的（否则所有调用方都得 await），所以这里把加载拆成显式的
 * `await storage.ready()`，让"没等加载就读写"这种错误在代码里看得见。
 */
export function createFileStorage(options: FileStorageOptions): FileStorage & { ready(): Promise<void> } {
  const store = new Store(options.path, options.flushMs ?? 250, options.autoFlush ?? true);
  const scenes = new FileSceneRepositoryImpl(store);

  return {
    path: options.path,
    scenes,
    events: new FileEventRepository(store),
    snapshots: new FileSnapshotRepository(store),
    sessions: new FileSessionRepository(store),
    state: new FileEntityStateRepository(store),
    metrics: new FileMetricRepository(store),
    async ready() {
      await store.load();
    },
    async flush() {
      await store.flush();
    },
    async reload() {
      await store.load();
    },
    async clear() {
      store.reset();
      await store.flush();
    },
  };
}
