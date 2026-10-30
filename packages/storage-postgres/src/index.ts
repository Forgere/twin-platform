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
 * PostgreSQL 仓储实现。
 *
 * 驱动是注入的（`SqlExecutor`），这个包不直接依赖 `pg`：
 * - 内核不认驱动，仓储也不该替调用方决定连接池配置；
 * - 单元测试可以喂一个假的 executor，断言生成的 SQL 与参数，不需要起数据库。
 *
 * 用法：
 * ```ts
 * import pg from 'pg';
 * const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 * const storage = createPostgresStorage(pool);   // Pool 的 query 就是 SqlExecutor
 * ```
 *
 * 建表语句见 `migrations/001_init.sql`。
 *
 * 已知限制：`twin_events` 是分区表，PostgreSQL 不允许跨分区的唯一约束，
 * 因此 `(scene_id, sequence)` 的唯一性由 `append()` 显式检查（先读 max，再查批内），
 * 一期假定同一场景只有一个写入者。
 */

/**
 * 单条 INSERT 的安全分块上限。PostgreSQL 扩展协议用 16 位长度字段承载参数个数，
 * 硬上限 65535；再算上语句本身长度，这里取保守值：upsert 每行 8 参数 → 1000 行
 * 仅 8001 个参数，远低于上限，且单条语句不至于撑爆网络包。
 *
 * 此前一次性把所有记录拼成一条巨型 INSERT，1000+ 实体时参数总数突破协议上限，
 * PGlite / PostgreSQL 直接报 `bind message has N parameter formats but 0 parameters`。
 */
const BULK_CHUNK = 1000;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

export interface SqlRow {
  [column: string]: unknown;
}

export interface SqlExecutor {
  query<T extends SqlRow = SqlRow>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface PostgresStorageOptions {
  /** schema 前缀，例如 `twin`（需要已存在）。 */
  schema?: string;
}

/**
 * 场景仓储多一个 `remove`：契约里没有，但服务端 DELETE 需要连带清理派生数据。
 * 与 `storage-file` 的 `FileSceneRepository` 保持一致。
 * 直接让 `PostgresSceneRepository` 类实现 `SceneRepository` 并额外提供 `remove`，
 * 不再单独声明同名 interface（否则与 class 合并声明时的导出一致性会报错 TS2395）。
 */

/** 完整的 PostgreSQL 仓储，`scenes` 带 `remove`。 */
export interface PostgresStorage extends TwinStorage {
  readonly scenes: PostgresSceneRepository;
}

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

const optionalString = (value: unknown): string | undefined => (value === null || value === undefined ? undefined : String(value));

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : str(value));

/** jsonb 在部分驱动里回来是字符串，在另一些里是对象，两种都接受。 */
const json = <T,>(value: unknown): T => (typeof value === 'string' ? (JSON.parse(value) as T) : (value as T));

const table = (schema: string | undefined) => (name: string): string => (schema ? `${schema}.${name}` : name);

function toEvent(row: SqlRow): WorldEvent {
  return {
    sequence: num(row.sequence),
    occurredAt: num(row.occurred_at),
    type: str(row.type),
    entityId: optionalString(row.entity_id),
    detail: optionalString(row.detail),
    payload: json<Record<string, string | number | boolean>>(row.payload ?? {}),
  };
}

function toSnapshot(row: SqlRow): WorldSnapshot {
  return {
    sceneId: str(row.scene_id),
    sequence: num(row.sequence),
    time: num(row.time),
    step: num(row.step),
    seed: num(row.seed),
    rngState: num(row.rng_state),
    mode: str(row.mode) as WorldSnapshot['mode'],
    entities: json<WorldSnapshot['entities']>(row.entities),
  };
}

function toSession(row: SqlRow): ReplaySession {
  return {
    id: str(row.id),
    sceneId: str(row.scene_id),
    sceneVersion: num(row.scene_version),
    seed: num(row.seed),
    step: num(row.step),
    mode: str(row.mode) as ReplaySession['mode'],
    createdAt: iso(row.created_at),
    label: optionalString(row.label),
    duration: row.duration === null || row.duration === undefined ? undefined : num(row.duration),
    pluginLocks: json<Record<string, string>>(row.plugin_locks ?? {}),
  };
}

function toState(row: SqlRow): EntityStateRecord {
  return {
    entityId: str(row.entity_id),
    kind: str(row.kind),
    status: optionalString(row.status),
    attrs: json<Record<string, string | number | boolean>>(row.attrs ?? {}),
    transform: json<EntityStateRecord['transform']>(row.transform),
    dataSource: str(row.data_source) as EntityStateRecord['dataSource'],
    updatedSequence: num(row.updated_sequence),
    updatedAt: row.updated_at === undefined || row.updated_at === null ? num(row.updated_wall_at) : num(row.updated_at),
  };
}

function toRollup(row: SqlRow): MetricRollup {
  return {
    sceneId: str(row.scene_id),
    metric: str(row.metric),
    entityId: str(row.entity_id) === '' ? undefined : str(row.entity_id),
    bucketStart: num(row.bucket_start),
    bucketSize: num(row.bucket_size),
    value: num(row.value),
    count: num(row.count),
  };
}

export class PostgresSceneRepository implements SceneRepository {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly name: (table: string) => string,
  ) {}

  async getScene(id: string): Promise<TwinScene | null> {
    const rows = await this.sql.query(
      `select payload from ${this.name('scene_versions')} where scene_id = $1 order by version desc limit 1`,
      [id],
    );
    const row = rows[0];
    return row ? json<TwinScene>(row.payload) : null;
  }

  async putScene(scene: TwinScene): Promise<SceneSummary> {
    const rows = await this.sql.query(
      `insert into ${this.name('scene_versions')} (scene_id, version, name, schema_version, payload)
       values (
         $1,
         coalesce((select max(version) + 1 from ${this.name('scene_versions')} where scene_id = $1), 1),
         $2, $3, $4::jsonb
       )
       returning version, created_at`,
      [scene.id, scene.name, scene.version, JSON.stringify(scene)],
    );
    const row = rows[0];
    return {
      id: scene.id,
      name: scene.name,
      version: num(row?.version ?? scene.version),
      updatedAt: iso(row?.created_at ?? new Date()),
    };
  }

  async listScenes(): Promise<SceneSummary[]> {
    const rows = await this.sql.query(
      `select distinct on (scene_id) scene_id, name, version, created_at
       from ${this.name('scene_versions')}
       order by scene_id, version desc`,
    );
    return rows.map((row) => ({
      id: str(row.scene_id),
      name: str(row.name),
      version: num(row.version),
      updatedAt: iso(row.created_at),
    }));
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this.sql.query(`delete from ${this.name('scene_versions')} where scene_id = $1 returning scene_id`, [id]);
    if (rows.length === 0) return false;
    // 级联清理：场景版本是父行，其余都是它的派生数据。
    await this.sql.query(`delete from ${this.name('twin_events')} where scene_id = $1`, [id]);
    await this.sql.query(`delete from ${this.name('world_snapshots')} where scene_id = $1`, [id]);
    await this.sql.query(`delete from ${this.name('entity_state_latest')} where scene_id = $1`, [id]);
    await this.sql.query(`delete from ${this.name('metric_rollups')} where scene_id = $1`, [id]);
    await this.sql.query(`delete from ${this.name('replay_sessions')} where scene_id = $1`, [id]);
    return true;
  }
}

class PostgresEventRepository implements EventRepository {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly name: (table: string) => string,
  ) {}

  async append(sceneId: string, events: readonly WorldEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    let cursor = await this.latestSequence(sceneId);
    for (const batch of chunk(events, BULK_CHUNK)) {
      const params: unknown[] = [sceneId];
      const tuples = batch.map((event, index) => {
        // 严格单调检查必须跨分块保持：cursor 在批次之间持续累加。
        if (event.sequence <= cursor) throw new Error(`事件 sequence 必须严格单调：${event.sequence} <= ${cursor}。`);
        cursor = event.sequence;
        const base = index * 6 + 2;
        params.push(
          event.sequence,
          event.occurredAt,
          event.type,
          event.entityId ?? null,
          event.detail ?? null,
          JSON.stringify(event.payload ?? {}),
        );
        return `( $1, $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb )`;
      });

      await this.sql.query(
        `insert into ${this.name('twin_events')} (scene_id, sequence, occurred_at, type, entity_id, detail, payload)
         values ${tuples.join(', ')}`,
        params,
      );
    }
    return events.length;
  }

  async query(sceneId: string, query: EventQuery = {}): Promise<WorldEvent[]> {
    const params: unknown[] = [sceneId];
    const where = ['scene_id = $1'];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (query.sinceSequence !== undefined) where.push(`sequence > ${bind(query.sinceSequence)}`);
    if (query.untilSequence !== undefined) where.push(`sequence <= ${bind(query.untilSequence)}`);
    if (query.entityId !== undefined) where.push(`entity_id = ${bind(query.entityId)}`);
    if (query.type !== undefined) where.push(`type = ${bind(query.type)}`);

    let text = `select scene_id, sequence, occurred_at, type, entity_id, detail, payload
       from ${this.name('twin_events')}
       where ${where.join(' and ')}
       order by sequence`;
    if (query.limit !== undefined) text += ` limit ${bind(query.limit)}`;

    return (await this.sql.query(text, params)).map(toEvent);
  }

  async latestSequence(sceneId: string): Promise<number> {
    const rows = await this.sql.query(
      `select max(sequence) as max_sequence from ${this.name('twin_events')} where scene_id = $1`,
      [sceneId],
    );
    const value = rows[0]?.max_sequence;
    return value === null || value === undefined ? 0 : num(value);
  }

  async truncateAfter(sceneId: string, sequence: number): Promise<number> {
    const rows = await this.sql.query(
      `delete from ${this.name('twin_events')} where scene_id = $1 and sequence > $2 returning sequence`,
      [sceneId, sequence],
    );
    return rows.length;
  }
}

class PostgresSnapshotRepository implements SnapshotRepository {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly name: (table: string) => string,
  ) {}

  async put(sceneId: string, snapshot: WorldSnapshot): Promise<void> {
    await this.sql.query(
      `insert into ${this.name('world_snapshots')} (scene_id, sequence, time, step, seed, rng_state, mode, entities)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       on conflict (scene_id, sequence) do update
         set time = excluded.time, step = excluded.step, seed = excluded.seed,
             rng_state = excluded.rng_state, mode = excluded.mode, entities = excluded.entities`,
      [
        sceneId,
        snapshot.sequence,
        snapshot.time,
        snapshot.step,
        snapshot.seed,
        snapshot.rngState,
        snapshot.mode,
        JSON.stringify(snapshot.entities),
      ],
    );
  }

  async latest(sceneId: string): Promise<WorldSnapshot | null> {
    const rows = await this.sql.query(
      `select * from ${this.name('world_snapshots')} where scene_id = $1 order by sequence desc limit 1`,
      [sceneId],
    );
    const row = rows[0];
    return row ? toSnapshot(row) : null;
  }

  async atOrBefore(sceneId: string, sequence: number): Promise<WorldSnapshot | null> {
    const rows = await this.sql.query(
      `select * from ${this.name('world_snapshots')} where scene_id = $1 and sequence <= $2 order by sequence desc limit 1`,
      [sceneId, sequence],
    );
    const row = rows[0];
    return row ? toSnapshot(row) : null;
  }

  async atOrBeforeTime(sceneId: string, time: number): Promise<WorldSnapshot | null> {
    const rows = await this.sql.query(
      `select * from ${this.name('world_snapshots')} where scene_id = $1 and time <= $2 order by time desc, sequence desc limit 1`,
      [sceneId, time],
    );
    const row = rows[0];
    return row ? toSnapshot(row) : null;
  }
}

class PostgresSessionRepository implements SessionRepository {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly name: (table: string) => string,
  ) {}

  async put(session: ReplaySession): Promise<void> {
    await this.sql.query(
      `insert into ${this.name('replay_sessions')}
         (id, scene_id, scene_version, seed, step, mode, label, created_at, duration, plugin_locks)
       values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::jsonb)
       on conflict (id) do update
         set scene_version = excluded.scene_version, seed = excluded.seed, step = excluded.step,
             mode = excluded.mode, label = excluded.label, duration = excluded.duration,
             plugin_locks = excluded.plugin_locks`,
      [
        session.id,
        session.sceneId,
        session.sceneVersion,
        session.seed,
        session.step,
        session.mode,
        session.label ?? null,
        session.createdAt,
        session.duration ?? null,
        JSON.stringify(session.pluginLocks ?? {}),
      ],
    );
  }

  async get(id: string): Promise<ReplaySession | null> {
    const rows = await this.sql.query(`select * from ${this.name('replay_sessions')} where id = $1`, [id]);
    const row = rows[0];
    return row ? toSession(row) : null;
  }

  async list(sceneId: string): Promise<ReplaySession[]> {
    const rows = await this.sql.query(
      `select * from ${this.name('replay_sessions')} where scene_id = $1 order by created_at`,
      [sceneId],
    );
    return rows.map(toSession);
  }

  async finish(id: string, duration: number): Promise<void> {
    const rows = await this.sql.query(
      `update ${this.name('replay_sessions')} set duration = $2 where id = $1 returning id`,
      [id, duration],
    );
    if (rows.length === 0) throw new Error(`回放会话 ${id} 不存在，无法结束。`);
  }
}

class PostgresEntityStateRepository implements EntityStateRepository {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly name: (table: string) => string,
  ) {}

  async upsert(sceneId: string, records: readonly EntityStateRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    let written = 0;
    for (const batch of chunk(records, BULK_CHUNK)) {
      const params: unknown[] = [sceneId];
      const tuples = batch.map((record, index) => {
        const base = index * 8 + 2;
        params.push(
          record.entityId,
          record.kind,
          record.status ?? null,
          JSON.stringify(record.attrs),
          JSON.stringify(record.transform),
          record.dataSource,
          record.updatedSequence,
          record.updatedAt,
        );
        return `( $1, $${base}, $${base + 1}, $${base + 2}, $${base + 3}::jsonb, $${base + 4}::jsonb, $${base + 5}, $${base + 6}, $${base + 7}, now() )`;
      });

      await this.sql.query(
        `insert into ${this.name('entity_state_latest')}
           (scene_id, entity_id, kind, status, attrs, transform, data_source, updated_sequence, updated_at, updated_wall_at)
         values ${tuples.join(', ')}
         on conflict (scene_id, entity_id) do update
           set kind = excluded.kind, status = excluded.status, attrs = excluded.attrs,
               transform = excluded.transform, data_source = excluded.data_source,
               updated_sequence = excluded.updated_sequence, updated_at = excluded.updated_at,
               updated_wall_at = now()`,
        params,
      );
      written += batch.length;
    }
    return written;
  }

  async get(sceneId: string, entityId: string): Promise<EntityStateRecord | null> {
    const rows = await this.sql.query(
      `select * from ${this.name('entity_state_latest')} where scene_id = $1 and entity_id = $2`,
      [sceneId, entityId],
    );
    const row = rows[0];
    return row ? toState(row) : null;
  }

  async list(sceneId: string): Promise<EntityStateRecord[]> {
    const rows = await this.sql.query(
      `select * from ${this.name('entity_state_latest')} where scene_id = $1 order by entity_id`,
      [sceneId],
    );
    return rows.map(toState);
  }
}

class PostgresMetricRepository implements MetricRepository {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly name: (table: string) => string,
  ) {}

  async put(rollups: readonly MetricRollup[]): Promise<number> {
    if (rollups.length === 0) return 0;
    const table = this.name('metric_rollups');
    let written = 0;
    for (const batch of chunk(rollups, BULK_CHUNK)) {
      const params: unknown[] = [];
      const tuples = batch.map((rollup, index) => {
        const base = index * 8 + 1;
        params.push(
          rollup.sceneId,
          rollup.metric,
          rollup.entityId ?? '',
          rollup.bucketStart,
          rollup.bucketSize,
          rollup.value,
          rollup.count,
          new Date(),
        );
        return `( $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7} )`;
      });

      await this.sql.query(
        `insert into ${table}
           (scene_id, metric, entity_id, bucket_start, bucket_size, value, count, updated_at)
         values ${tuples.join(', ')}
         on conflict (scene_id, metric, entity_id, bucket_start, bucket_size) do update
           set value = ${table}.value + excluded.value,
               count = ${table}.count + excluded.count,
               updated_at = excluded.updated_at`,
        params,
      );
      written += batch.length;
    }
    return written;
  }

  async query(sceneId: string, query: MetricQuery = {}): Promise<MetricRollup[]> {
    const params: unknown[] = [sceneId];
    const where = ['scene_id = $1'];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (query.metric !== undefined) where.push(`metric = ${bind(query.metric)}`);
    if (query.entityId !== undefined) where.push(`entity_id = ${bind(query.entityId)}`);
    if (query.fromBucket !== undefined) where.push(`bucket_start >= ${bind(query.fromBucket)}`);
    if (query.toBucket !== undefined) where.push(`bucket_start <= ${bind(query.toBucket)}`);

    const rows = await this.sql.query(
      `select * from ${this.name('metric_rollups')} where ${where.join(' and ')} order by metric, bucket_start, entity_id`,
      params,
    );
    return rows.map(toRollup);
  }
}

/**
 * 建一个 PostgreSQL 仓储。
 *
 * @param executor 任意能执行 `query(sql, params)` 的对象（`pg.Pool` / `pg.Client` 都行）。
 */
export function createPostgresStorage(executor: SqlExecutor, options: PostgresStorageOptions = {}): PostgresStorage {
  const name = table(options.schema);
  return {
    scenes: new PostgresSceneRepository(executor, name),
    events: new PostgresEventRepository(executor, name),
    snapshots: new PostgresSnapshotRepository(executor, name),
    sessions: new PostgresSessionRepository(executor, name),
    state: new PostgresEntityStateRepository(executor, name),
    metrics: new PostgresMetricRepository(executor, name),
  };
}

// 驱动解析与连接装配（依赖 `connect.ts`）统一从包根导出，避免调用方走受限的子路径导入。
export { connectPostgresStorage } from './connect';
export type { ConnectPostgresOptions, ConnectPostgresResult, PostgresDriver, PostgresDriverKind } from './connect';
