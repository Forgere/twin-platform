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
 * HTTP 仓储：浏览器里的 `TwinStorage`，全部走 fetch 调服务端。
 *
 * 存在的理由：浏览器**不可能**直连 PostgreSQL，也没有文件系统。
 * 之前 `storage-postgres` 就这么尴尬地存在着——实现完整、测试齐全，
 * 但没有任何运行时代码 import 它，因为没有服务端就没有它能跑的地方。
 *
 * 有了它，Studio 换后端只是换一个 `TwinStorage` 实例：
 * 服务端不在就退回 `storage-memory`（纯静态可跑），在就走 HTTP（能存下来）。
 */

export interface HttpStorageOptions {
  /** 服务端地址，例如 `http://localhost:8787`。末尾不要带斜杠。 */
  baseUrl: string;
  /** 自定义 fetch（测试注入用），默认全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 事件攒够多少条立即发送，默认 64。 */
  batchSize?: number;
  /** 事件最长攒多久（毫秒）必须发送，默认 400。 */
  flushMs?: number;
}

export interface HttpStorage extends TwinStorage {
  readonly baseUrl: string;
  /** 把攒下的事件立刻发出去（页面卸载、切场景前调用）。 */
  flush(): Promise<void>;
}

/** 服务端健康检查的返回结构。 */
export interface ServerHealth {
  ok: boolean;
  backend: string;
  dataPath: string;
  scenes: number;
}

const encode = (value: string): string => encodeURIComponent(value);

class Transport {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    const query = search.toString();
    return `${this.baseUrl}${path}${query ? `?${query}` : ''}`;
  }

  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T | null> {
    const response = await this.fetchImpl(this.url(path, params));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(await Transport.message(response));
    return (await response.json()) as T;
  }

  async send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const response = await this.fetchImpl(this.url(path, params), {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await Transport.message(response));
    return (await response.json()) as T;
  }

  /** 把服务端的 `{ error, issues? }` 摊平成人能读的一句话。 */
  private static async message(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { error?: string; issues?: { path: string; message: string }[] };
      if (body.issues?.length) {
        return `${body.error ?? '请求失败'} ${body.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`;
      }
      return body.error ?? `HTTP ${response.status}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }
}

class HttpSceneRepository implements SceneRepository {
  constructor(private readonly transport: Transport) {}

  async getScene(id: string): Promise<TwinScene | null> {
    return this.transport.get<TwinScene>(`/api/scenes/${encode(id)}`);
  }

  async putScene(scene: TwinScene): Promise<SceneSummary> {
    return this.transport.send<SceneSummary>('POST', '/api/scenes', scene);
  }

  async listScenes(): Promise<SceneSummary[]> {
    return (await this.transport.get<SceneSummary[]>('/api/scenes')) ?? [];
  }

  /** 非契约方法：对应 `storage-file` 的 remove / 服务端 DELETE。 */
  async remove(id: string): Promise<boolean> {
    await this.transport.send<{ removed: boolean }>('DELETE', `/api/scenes/${encode(id)}`);
    return true;
  }
}

/**
 * 事件仓储：**必须攒批**。
 *
 * 录制器是每帧调 `append` 的（一帧产生几条就写几条）。若条条都发 HTTP，
 * 一个 60Hz 的仿真就是每秒 60 个请求——浏览器和网络都撑不住，服务端也写不动
 * 磁盘。所以这里按"攒够 N 条或等够 T 毫秒"合并发送。
 *
 * 代价是写入有延迟，因此任何**读**操作（query / latestSequence / truncateAfter）
 * 前都必须先把缓冲区冲掉，否则会读到自己刚写却还没发出去的旧状态。
 */
class HttpEventRepository implements EventRepository {
  private readonly pending = new Map<string, WorldEvent[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly transport: Transport,
    private readonly batchSize: number,
    private readonly flushMs: number,
  ) {}

  async append(sceneId: string, events: readonly WorldEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const bucket = this.pending.get(sceneId) ?? [];
    bucket.push(...events.map((event) => ({ ...event })));
    this.pending.set(sceneId, bucket);

    if (bucket.length >= this.batchSize) await this.flush();
    else this.schedule();
    return events.length;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }

  /** 把攒下的事件全部发出去。页面卸载前也应该调一次。 */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batches = [...this.pending.entries()];
    this.pending.clear();
    for (const [sceneId, events] of batches) {
      if (events.length === 0) continue;
      try {
        await this.transport.send<{ written: number }>('POST', '/api/events', events, { sceneId });
      } catch (error) {
        // 发送失败要把事件放回去，否则这批事件就凭空消失了；
        // 下一次 flush 会重试（可能是网络抖动）。
        const back = this.pending.get(sceneId) ?? [];
        this.pending.set(sceneId, [...events, ...back]);
        throw error;
      }
    }
  }

  async query(sceneId: string, query: EventQuery = {}): Promise<WorldEvent[]> {
    await this.flush();
    return (
      (await this.transport.get<WorldEvent[]>('/api/events', {
        sceneId,
        since: query.sinceSequence,
        until: query.untilSequence,
        entityId: query.entityId,
        type: query.type,
        limit: query.limit,
      })) ?? []
    );
  }

  async latestSequence(sceneId: string): Promise<number> {
    await this.flush();
    const result = await this.transport.get<{ sequence: number }>('/api/events/latest', { sceneId });
    return result?.sequence ?? 0;
  }

  async truncateAfter(sceneId: string, sequence: number): Promise<number> {
    await this.flush();
    const result = await this.transport.send<{ removed: number }>('POST', '/api/events/truncate', undefined, {
      sceneId,
      sequence,
    });
    return result.removed;
  }
}

class HttpSnapshotRepository implements SnapshotRepository {
  constructor(private readonly transport: Transport) {}

  async put(sceneId: string, snapshot: WorldSnapshot): Promise<void> {
    await this.transport.send('POST', '/api/snapshots', snapshot, { sceneId });
  }

  async latest(sceneId: string): Promise<WorldSnapshot | null> {
    return this.transport.get<WorldSnapshot>('/api/snapshots/query', { sceneId });
  }

  async atOrBefore(sceneId: string, sequence: number): Promise<WorldSnapshot | null> {
    return this.transport.get<WorldSnapshot>('/api/snapshots/query', { sceneId, sequence });
  }

  async atOrBeforeTime(sceneId: string, time: number): Promise<WorldSnapshot | null> {
    return this.transport.get<WorldSnapshot>('/api/snapshots/query', { sceneId, time });
  }
}

class HttpSessionRepository implements SessionRepository {
  constructor(private readonly transport: Transport) {}

  async put(session: ReplaySession): Promise<void> {
    await this.transport.send('POST', '/api/sessions', session);
  }

  async get(id: string): Promise<ReplaySession | null> {
    return this.transport.get<ReplaySession>(`/api/sessions/${encode(id)}`);
  }

  async list(sceneId: string): Promise<ReplaySession[]> {
    return (await this.transport.get<ReplaySession[]>('/api/sessions', { sceneId })) ?? [];
  }

  async finish(id: string, duration: number): Promise<void> {
    await this.transport.send('POST', `/api/sessions/${encode(id)}/finish`, { duration });
  }
}

class HttpEntityStateRepository implements EntityStateRepository {
  constructor(private readonly transport: Transport) {}

  async upsert(sceneId: string, records: readonly EntityStateRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    const result = await this.transport.send<{ written: number }>('POST', '/api/state', records, { sceneId });
    return result.written;
  }

  async get(sceneId: string, entityId: string): Promise<EntityStateRecord | null> {
    const all = await this.list(sceneId);
    return all.find((record) => record.entityId === entityId) ?? null;
  }

  async list(sceneId: string): Promise<EntityStateRecord[]> {
    return (await this.transport.get<EntityStateRecord[]>('/api/state', { sceneId })) ?? [];
  }
}

class HttpMetricRepository implements MetricRepository {
  constructor(private readonly transport: Transport) {}

  async put(rollups: readonly MetricRollup[]): Promise<number> {
    if (rollups.length === 0) return 0;
    const result = await this.transport.send<{ written: number }>('POST', '/api/metrics', rollups);
    return result.written;
  }

  async query(sceneId: string, query: MetricQuery = {}): Promise<MetricRollup[]> {
    return (
      (await this.transport.get<MetricRollup[]>('/api/metrics', {
        sceneId,
        metric: query.metric,
        entityId: query.entityId,
        from: query.fromBucket,
        to: query.toBucket,
      })) ?? []
    );
  }
}

/** 建一个走 HTTP 的仓储。 */
export function createHttpStorage(options: HttpStorageOptions): HttpStorage {
  const transport = new Transport(options.baseUrl, options.fetchImpl ?? fetch);
  const events = new HttpEventRepository(transport, options.batchSize ?? 64, options.flushMs ?? 400);
  return {
    baseUrl: options.baseUrl,
    scenes: new HttpSceneRepository(transport) as SceneRepository & { remove(id: string): Promise<boolean> },
    events,
    snapshots: new HttpSnapshotRepository(transport),
    sessions: new HttpSessionRepository(transport),
    state: new HttpEntityStateRepository(transport),
    metrics: new HttpMetricRepository(transport),
    flush: () => events.flush(),
  };
}

/**
 * 探一下服务端在不在。
 *
 * Studio 启动时调它：在就用 HTTP 仓储（能存下来），不在就退回内存仓储
 * （纯静态也能跑）。**不抛异常**——服务端没起是正常状态，不是错误。
 */
export async function pingServer(baseUrl: string, timeoutMs = 1200): Promise<ServerHealth | null> {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const response = await fetch(`${baseUrl}/api/health`, controller ? { signal: controller.signal } : undefined);
    if (!response.ok) return null;
    return (await response.json()) as ServerHealth;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 服务端地址的默认推断：同源优先，否则回落到 8787。 */
export function defaultServerUrl(): string {
  if (typeof location === 'undefined') return 'http://localhost:8787';
  // 同源部署时（服务端托管 studio/dist）不需要另配地址。
  return location.port === '8787' ? location.origin : `${location.protocol}//${location.hostname}:8787`;
}
