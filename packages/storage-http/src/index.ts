import type { SceneOp, TwinScene } from '@twin-platform/scene-schema';
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
  /**
   * Bearer token，每个请求都带上。
   *
   * **生产不要设**：线上由 Cloudflare Worker 反代时注入，浏览器不知道 token。
   * 只有本地跨源联调（vite:3000 直连 server:8799）才用 `VITE_TWIN_API_TOKEN` 填它。
   */
  token?: string;
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
  /** 各场景是否被服务端**拒收**过（key 是 sceneId，value 是拒收原因）；空 Map = 一切正常。 */
  writeErrors(): ReadonlyMap<string, string>;
  /** 放开某个场景的写入熔断——调用方已经排除原因（通常是重新对齐了 sequence）之后用。 */
  clearConflict(sceneId: string): void;
  /** 因服务端拒收而丢掉的事件数（丢弃是刻意的：见 HttpEventRepository.flush）。 */
  readonly dropped: number;
}

/**
 * 服务端健康检查的返回结构。
 *
 * 只有 ok 与 backend：dataPath / 连接串 / 场景数都是访客不该看见的后端元信息，
 * 服务端那边也相应收敛了字段（见 apps/server 的 /api/health）。
 */
export interface ServerHealth {
  ok: boolean;
  backend: string;
}

const encode = (value: string): string => encodeURIComponent(value);

/**
 * 带状态码的错误。
 *
 * 状态码是**重试策略的唯一依据**：4xx 是服务端明确拒收（例如 sequence 不单调），
 * 重试只是把同一批作废的事件再撞一次；5xx 与网络错误才是抖动，值得重试。
 * 所以每个 HTTP 失败都必须带上 status，让调用方能分开这两类。
 */
export type HttpTransportError = Error & { status: number };

function httpError(message: string, status: number): HttpTransportError {
  const error = new Error(message) as HttpTransportError;
  error.status = status;
  return error;
}

/** 取错误上的状态码；非 HTTP 错误（网络断开、abort）返回 undefined。 */
export function httpStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number') {
    return (error as { status: number }).status;
  }
  return undefined;
}

class Transport {
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly baseUrl: string,
    fetchImpl?: typeof fetch,
    private readonly token?: string,
  ) {
    // 必须绑定到 globalThis：浏览器里 fetch 依赖 Window 作为 this，
    // 当作裸引用存进 this.fetchImpl 后再 this.fetchImpl(...) 调用会抛
    // "Illegal invocation"（fetch 的 this 丢失）。
    this.fetchImpl = (fetchImpl ?? globalThis.fetch).bind(globalThis);
  }

  /** 带上鉴权头：没 token 就原样不动（服务端未启用鉴权时本来也不需要）。 */
  private authHeaders(json: boolean): HeadersInit | undefined {
    const headers: Record<string, string> = {};
    if (json) headers['content-type'] = 'application/json';
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    const query = search.toString();
    return `${this.baseUrl}${path}${query ? `?${query}` : ''}`;
  }

  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T | null> {
    const response = await this.fetchImpl(this.url(path, params), { headers: this.authHeaders(false) });
    if (response.status === 404) return null;
    if (!response.ok) throw httpError(await responseMessage(response), response.status);
    return (await response.json()) as T;
  }

  async send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const response = await this.fetchImpl(this.url(path, params), {
      method,
      headers: this.authHeaders(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw httpError(await responseMessage(response), response.status);
    return (await response.json()) as T;
  }
}

/** 把服务端的 `{ error, issues? }` 摊平成人能读的一句话。 */
async function responseMessage(response: Response): Promise<string> {
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

class HttpSceneRepository implements SceneRepository {
  constructor(private readonly transport: Transport) {}

  async getScene(id: string): Promise<TwinScene | null> {
    return this.transport.get<TwinScene>(`/api/scenes/${encode(id)}`);
  }

  async putScene(scene: TwinScene): Promise<SceneSummary> {
    return this.transport.send<SceneSummary>('POST', '/api/scenes', scene);
  }

  async appendOps(sceneId: string, baseVersion: number, ops: readonly SceneOp[]): Promise<SceneSummary> {
    try {
      return await this.transport.send<SceneSummary>('POST', `/api/scenes/${encode(sceneId)}/ops`, { baseVersion, ops });
    } catch (error) {
      // 服务端 409 只给消息文本，当前版本从列表取——冲突是罕见路径，多一次 GET 不亏。
      if (httpStatus(error) !== 409) throw error;
      const current = (await this.listScenes()).find((scene) => scene.id === sceneId)?.version ?? 0;
      throw new SceneVersionConflictError(sceneId, baseVersion, current);
    }
  }

  async listVersions(sceneId: string): Promise<SceneVersionSummary[]> {
    return (await this.transport.get<SceneVersionSummary[]>(`/api/scenes/${encode(sceneId)}/versions`)) ?? [];
  }

  async getVersion(sceneId: string, version: number): Promise<TwinScene | null> {
    return this.transport.get<TwinScene>(`/api/scenes/${encode(sceneId)}/versions/${version}`);
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
  /**
   * 被服务端**拒收**过的场景（sceneId → 拒收原因）。
   *
   * 一旦进这张表，该场景的写入就熔断了：后续事件直接丢弃，不再重试。
   * 理由见 flush——4xx 的失败重试是纯浪费，还会每 120ms 刷一条报错。
   */
  private readonly rejected = new Map<string, string>();
  private discarded = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly transport: Transport,
    private readonly batchSize: number,
    private readonly flushMs: number,
  ) {}

  async append(sceneId: string, events: readonly WorldEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    // 熔断中：这批事件的 sequence 已经是被拒收过的号段，留着只会再撞一次。
    // 返回 0（没写进去）而不是条数——录制器不能以为自己写成功了。
    if (this.rejected.has(sceneId)) {
      this.discarded += events.length;
      return 0;
    }
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

  /**
   * 把攒下的事件全部发出去。页面卸载前也应该调一次。
   *
   * 失败分两类，**处理方式完全相反**：
   *
   * - **4xx（尤其是 409 sequence 冲突）**：服务端在说"这批事件我不收"。
   *   事件里的 sequence 已经被判死，塞回 pending 只会让下一次 flush 原样再撞一次——
   *   面板每 120ms 采样一次，于是控制台就是每 120ms 一条 409。所以这里**丢弃并熔断**，
   *   第一次仍然抛出（让调用方看得见原因），之后不再骚扰。
   * - **5xx / 网络错误**：抖动。塞回队首，下次 flush 重试（顺序不能乱）。
   *
   * 另外：错误在最后一次迭代才抛出，**中途不中断**——否则排在同一批里的其它场景
   * 的事件会被 `pending.clear()` 后无声丢弃。
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batches = [...this.pending.entries()];
    this.pending.clear();
    let failure: unknown;
    for (const [sceneId, events] of batches) {
      if (events.length === 0) continue;
      try {
        await this.transport.send<{ written: number }>('POST', '/api/events', events, { sceneId });
      } catch (error) {
        const status = httpStatus(error);
        const message = error instanceof Error ? error.message : String(error);
        if (status !== undefined && status >= 400 && status < 500) {
          // 这批事件作废：宁可丢掉，也不能让它堵住后面所有写入。
          this.rejected.set(sceneId, message);
          this.discarded += events.length;
        } else {
          // 发送失败要把事件放回去，否则这批事件就凭空消失了；
          // 下一次 flush 会重试（可能是网络抖动）。
          const back = this.pending.get(sceneId) ?? [];
          this.pending.set(sceneId, [...events, ...back]);
        }
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  /** 有哪些场景被服务端拒收了（以及原因）。UI 用它明示"录制已经停了"。 */
  writeErrors(): ReadonlyMap<string, string> {
    return new Map(this.rejected);
  }

  /** 放开某个场景的写入熔断（确认原因排除后再调，否则会立刻再撞一次）。 */
  clearConflict(sceneId: string): void {
    this.rejected.delete(sceneId);
  }

  /** 被拒收而丢弃的事件数——出了问题时，用来回答"丢了多少"。 */
  get dropped(): number {
    return this.discarded;
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
  const transport = new Transport(options.baseUrl, options.fetchImpl, options.token);
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
    writeErrors: () => events.writeErrors(),
    clearConflict: (sceneId: string) => events.clearConflict(sceneId),
    get dropped() {
      return events.dropped;
    },
  };
}

/**
 * 探一次服务端：**同时回答两个问题**——它在不在，以及认不认这个 token。
 *
 * Studio 启动时调它：
 * - `ok` → 换 HTTP 仓储，场景与事件落服务端；
 * - `offline` → 纯静态兜底，**不报错**（服务端没起是正常状态）；
 * - `unauthorized` → 服务端在但拒绝了我们。这**不是**正常状态，也**不能**
 *   静默降级成内存仓储——否则用户会以为存下来了，刷新才发现全丢。
 */
export type PingResult =
  | { status: 'ok'; health: ServerHealth }
  | { status: 'unauthorized'; message: string }
  | { status: 'offline' };

export interface PingOptions {
  /** 探测超时（毫秒），默认 1200。 */
  timeoutMs?: number;
  /** Bearer token：本地跨源联调才需要，生产由 Cloudflare Worker 注入。 */
  token?: string;
}

export async function pingServer(baseUrl: string, options: PingOptions = {}): Promise<PingResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1200);
  try {
    const headers: Record<string, string> = {};
    if (options.token) headers['authorization'] = `Bearer ${options.token}`;
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: controller.signal,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });
    if (response.status === 401 || response.status === 403) {
      return { status: 'unauthorized', message: await responseMessage(response) };
    }
    if (!response.ok) return { status: 'offline' };
    return { status: 'ok', health: (await response.json()) as ServerHealth };
  } catch {
    return { status: 'offline' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 服务端地址的默认推断：同源优先，否则回落到 8787。
 *
 * 必须认 `port === ''`：域名走 80/443 时浏览器给的 port 就是空串，
 * 那正是 Cloudflare 上的常态。只认 `'8787'` 会拼出 `https://域名:8788`——
 * 一个没人监听的端口，探测必然失败，于是静默退回内存仓储（刷新即丢）。
 *
 * 显式地址用 `VITE_TWIN_SERVER` 覆盖（在调用方，不在这里：本包不认识 vite）。
 */
export function defaultServerUrl(): string {
  if (typeof location === 'undefined') return 'http://localhost:8787';
  // 端口为空（80/443 默认）或显式 8787（本地 wrangler dev 把 Worker 跑在 8787）
  // 都是同源，直接用 origin。
  if (location.port === '' || location.port === '8787') return location.origin;
  return `${location.protocol}//${location.hostname}:8787`;
}
