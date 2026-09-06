import type { TwinScene } from '@twin-platform/scene-schema';
import type { WorldEvent, WorldSnapshot } from '@twin-platform/world-kernel';
import type {
  EventQuery,
  EventRepository,
  SceneRepository,
  SceneSummary,
  SnapshotRepository,
  TwinStorage,
} from '@twin-platform/storage-contracts';

/**
 * 内存仓储：浏览器演示、单元测试、以及"不装数据库也能跑"的默认实现。
 *
 * 刻意做成异步并强制深拷贝——和真数据库一样"取出来的是副本"，
 * 这样调用方不会在内存实现下能跑、换 Postgres 后因为共享引用而炸。
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
}

export interface MemoryStorage extends TwinStorage {
  /** 仅用于测试：清空全部数据。 */
  clear(): void;
}

export function createMemoryStorage(): MemoryStorage {
  const scenes = new MemorySceneRepository();
  const events = new MemoryEventRepository();
  const snapshots = new MemorySnapshotRepository();

  return {
    scenes,
    events,
    snapshots,
    clear() {
      scenes.clear();
      events.clear();
      snapshots.clear();
    },
  };
}
