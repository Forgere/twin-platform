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
 * 4. PGlite（WASM 版真实 PostgreSQL）—— 连接串形如 `pglite://memory`，
 *    **必须显式声明**，给没有装数据库的机器一条零依赖跑通 Postgres 后端的路。
 *
 * 四者都是 `SqlExecutor` 的实例，上层代码无感知。选不到任何驱动时给出明确的
 * 安装指引，而不是抛一个看不懂的 `Cannot find module`。
 *
 * ⚠️ PGlite **只认显式 `pglite://` 前缀**，绝不作为真实 `postgres://` 的兜底：
 * 它是进程内 WASM 库（多为内存态），悄悄兜底会把真实连接串的数据"写进虚空"。
 */

export type PostgresDriverKind = 'pg' | 'bun-sql' | 'pglite' | 'injected';

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

/** 用到的 PGlite 表面接口，避免把 WASM 包的类型拖进编译。 */
interface PGliteLike {
  query(text: string, params?: readonly unknown[]): Promise<{ rows?: unknown[] }>;
  exec(text: string): Promise<{ rows?: unknown[] }[]>;
  close(): Promise<void>;
}

const PGLITE_PREFIX = 'pglite://';

/** 只有显式 `pglite://` 才走 PGlite。 */
const isPgliteUrl = (url: string): boolean => url.toLowerCase().startsWith(PGLITE_PREFIX);

/**
 * 解析 PGlite 的 dataDir。
 * - `pglite://` / `pglite://memory` / `pglite://memory://` → `memory://`（进程内内存库）；
 * - 其余按路径原样使用（如 `pglite://./data/pg`、`pglite:///var/lib/twin-pg`）。
 */
function pgliteDataDir(url: string): string | undefined {
  const rest = url.slice(PGLITE_PREFIX.length).replace(/\/+$/, '');
  if (!rest || rest === 'memory' || rest === 'memory:') return 'memory://';
  return rest;
}

/** 把 PGlite 实例适配成 `SqlExecutor`。 */
function pgliteExecutor(db: PGliteLike): SqlExecutor {
  return {
    async query(text, params) {
      // PGlite 的 `query` 走扩展协议（支持 $1 占位），`exec` 走简单协议（可多语句）。
      // 带参数必须走 query；无参数用 exec，最后一次结果即返回值。
      if (params && params.length > 0) {
        const res = await db.query(text, params as unknown[]);
        return (res.rows ?? []) as never;
      }
      const res = await db.exec(text);
      return (res[res.length - 1]?.rows ?? []) as never;
    },
  };
}

/**
 * 解析 PGlite 驱动。
 *
 * 非 `pglite://` 连接串直接返回 null；是 `pglite://` 但包没装则**抛错**——
 * 用户明确点了这个后端，静默退化到别的驱动会掩盖真实意图。
 */
async function tryPglite(url: string): Promise<PostgresDriver | null> {
  if (!isPgliteUrl(url)) return null;
  const mod = (await import('@electric-sql/pglite').catch(() => null)) as
    | { PGlite: { create(options?: { dataDir?: string }): Promise<PGliteLike> } }
    | null;
  if (!mod?.PGlite) {
    throw new Error(
      '连接串是 pglite:// 但没装 @electric-sql/pglite。执行 `bun add -d @electric-sql/pglite`（零依赖 WASM 版真实 PostgreSQL）。',
    );
  }
  const dataDir = pgliteDataDir(url);
  const db = await mod.PGlite.create(dataDir ? { dataDir } : undefined);
  return {
    kind: 'pglite',
    executor: pgliteExecutor(db),
    async close() {
      await db.close();
    },
  };
}

/**
 * PGlite 下需要跳过的迁移语句。
 *
 * PGlite 0.5 对含动态 DDL 的 `$$` plpgsql 函数体（`twin_ensure_event_partitions`）
 * 解析有局限，而该 SQL 在真实 PostgreSQL 18 完全合法。跳过它不影响功能：
 * `twin_events` 已建 DEFAULT 分区兜底，入库与契约都不依赖预建分区。
 */
export const skipForPglite = (sql: string): boolean => sql.includes('twin_ensure_event_partitions');

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
    const resolved = (await tryPglite(url!)) ?? (await tryPg(url!)) ?? tryBunSql(url!);
    if (!resolved) {
      throw new Error(
        '找不到可用的 PostgreSQL 驱动。三选一：① `bun add pg`（Node / 通用）；② 用 `bun run` 起服务端以使用内置 Bun.sql；③ `DATABASE_URL=pglite://memory`（零依赖 WASM 真实 PostgreSQL，需 `bun add -d @electric-sql/pglite`）。',
      );
    }
    driver = resolved;
  }

  const migration: MigrationResult =
    options.applyMigrationsOnConnect !== false
      ? await applyMigrations(driver.executor, {
          schema: options.schema,
          migrationsDir: options.migrationsDir,
          skipStatement: driver.kind === 'pglite' ? skipForPglite : undefined,
        })
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
