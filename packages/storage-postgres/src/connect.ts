import { createPostgresStorage, type PostgresStorage, type SqlExecutor } from './index';
import { applyMigrations, type MigrationResult } from './migrate';

/**
 * 驱动解析与连接装配。
 *
 * 设计原则：`storage-postgres` 不直接依赖任何数据库驱动，只认 `SqlExecutor`。
 * 但这里要替调用方把"一个连接串"变成可用的 `SqlExecutor`，于是集中处理驱动选择：
 *
 * 1. 显式注入 `executor` —— 测试 / 特殊场景（如 PGlite、现有的 `pg.Pool` 包装）。
 * 2. `pg` 驱动（若已安装）——Node 环境下最通用，生产推荐之一。
 * 3. Bun 内置 `Bun.sql` —— 用 `bun run` 起服务端时零依赖即可连 PostgreSQL。
 *
 * 三者都是 `SqlExecutor` 的实例，上层代码无感知。选不到任何驱动时给出明确的
 * 安装指引，而不是抛一个看不懂的 `Cannot find module`。
 */

export type PostgresDriverKind = 'pg' | 'bun-sql' | 'injected';

export interface PostgresDriver {
  kind: PostgresDriverKind;
  executor: SqlExecutor;
  close(): Promise<void>;
}

export interface ConnectPostgresOptions {
  /** 连接串，例如 `postgres://user:pass@host:5432/db`。缺省读 `process.env.DATABASE_URL`。 */
  url?: string;
  /** 表前缀 schema，例如 `twin`。 */
  schema?: string;
  /** 直接注入的执行器（测试用）。提供后不再解析驱动。 */
  executor?: SqlExecutor;
  /** 是否在建连后自动跑迁移，默认 `true`。 */
  applyMigrationsOnConnect?: boolean;
  /** 迁移目录，默认读包内 `migrations/`。 */
  migrationsDir?: string;
}

export interface ConnectPostgresResult {
  storage: PostgresStorage;
  driver: PostgresDriver;
  migration: MigrationResult;
  /** 轻量探活：跑 `select 1`，并取服务端版本号（失败则 unknown）。 */
  health(): Promise<{ ok: boolean; version: string }>;
}

/** 把 `pg` 的 `Pool` 适配成 `SqlExecutor`。 */
function pgExecutor(pool: { query: (text: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }> }): SqlExecutor {
  return {
    async query(text, params) {
      const res = await pool.query(text, params);
      return res.rows as never;
    },
  };
}

/** 把 Bun 内置 `Bun.sql` 适配成 `SqlExecutor`。返回 null 表示当前运行时没有 `Bun.sql`。 */
function tryBunSql(url: string): PostgresDriver | null {
  const bun = globalThis as { Bun?: { SQL?: new (connectionString: string) => BunSqlLike } };
  const Sql = bun.Bun?.SQL;
  if (!Sql) return null;
  const sql = new Sql(url);
  const executor: SqlExecutor = {
    async query(text, params) {
      const res = await sql.unsafe(text, params as unknown[]);
      // Bun.sql 的返回可能是行数组，也可能是 `{ rows }` 形态，两种都兼容。
      return (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as never;
    },
  };
  return {
    kind: 'bun-sql',
    executor,
    async close() {
      await sql.close();
    },
  };
}

interface BunSqlLike {
  unsafe(text: string, params?: readonly unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

/** 把 `pg` 驱动解析出来（动态 import，未安装时返回 null）。 */
async function tryPg(url: string): Promise<PostgresDriver | null> {
  const spec = 'pg';
  let mod: { Pool: new (opts: { connectionString: string }) => { query: (t: string, p?: readonly unknown[]) => Promise<{ rows: unknown[] }>; end: () => Promise<void> } };
  try {
    mod = (await import(spec)) as typeof mod;
  } catch {
    return null;
  }
  const pool = new mod.Pool({ connectionString: url });
  return {
    kind: 'pg',
    executor: pgExecutor(pool),
    async close() {
      await pool.end();
    },
  };
}

/**
 * 连接 PostgreSQL 并装配好仓储。
 *
 * 不抛驱动缺失之外的错误：迁移失败、连接失败都会原样抛出，让调用方决定怎么处理
 * （例如开发模式下回退到文件存储）。
 */
export async function connectPostgresStorage(options: ConnectPostgresOptions = {}): Promise<ConnectPostgresResult> {
  const url = options.url ?? process.env.DATABASE_URL;
  if (!options.executor && !url) {
    throw new Error('连接 PostgreSQL 需要 connectionString：传入 options.url 或设置环境变量 DATABASE_URL。');
  }

  let driver: PostgresDriver;
  if (options.executor) {
    driver = { kind: 'injected', executor: options.executor, close: async () => {} };
  } else {
    const resolved = (await tryPg(url!)) ?? tryBunSql(url!);
    if (!resolved) {
      throw new Error(
        '找不到可用的 PostgreSQL 驱动。请二选一：① `bun add pg`（Node / 通用）；② 用 `bun run` 起服务端以使用内置 Bun.sql。',
      );
    }
    driver = resolved;
  }

  const migration: MigrationResult =
    options.applyMigrationsOnConnect !== false
      ? await applyMigrations(driver.executor, { schema: options.schema, migrationsDir: options.migrationsDir })
      : { applied: [], skipped: [] };

  const storage = createPostgresStorage(driver.executor, { schema: options.schema });

  return {
    storage,
    driver,
    migration,
    async health() {
      try {
        await driver.executor.query('select 1');
        const rows = await driver.executor.query('show server_version');
        return { ok: true, version: String(rows[0]?.server_version ?? 'unknown') };
      } catch {
        return { ok: false, version: 'unknown' };
      }
    },
  };
}
