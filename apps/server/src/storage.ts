import { createFileStorage } from '@twin-platform/storage-file';
import type { TwinStorage } from '@twin-platform/storage-contracts';
import { connectPostgresStorage } from '@twin-platform/storage-postgres';

/**
 * 服务端存储工厂。
 *
 * 一个开关 (`TWIN_STORAGE` 或 `DATABASE_URL`) 在两种后端间切换，服务端其余代码
 * 完全无感——这正是当初把仓储抽象成 `TwinStorage` 的意义。
 *
 * - 默认 / `TWIN_STORAGE=file`：落单 JSON 文件，零依赖，开发即跑；
 * - `TWIN_STORAGE=postgres` 或设置了 `DATABASE_URL`：连 PostgreSQL，
 *   自动跑迁移、建表，走 `pg` 或 Bun 内置 `Bun.sql` 驱动。
 *
 * `remove` 是契约之外的扩展方法（服务端 DELETE 需要），file 实现一直有；
 * postgres 实现也已补齐。这里用一个可选方法做兼容。
 */

export type StorageBackendName = 'postgres' | 'file';

export interface ServerStorage {
  storage: TwinStorage & { scenes: { remove?(id: string): Promise<boolean> } };
  backend: StorageBackendName;
  /** 给 `/api/health` 用的元信息。 */
  detail: Record<string, unknown>;
  /** 文件后端退出前落盘；postgres 端点是空操作。 */
  flush(): Promise<void>;
  /** 释放连接（postgres 的 pool / Bun.sql）。 */
  close(): Promise<void>;
}

/** 删场景：file 与 postgres 都支持，但类型上它是可选扩展，做统一封装。 */
export async function removeScene(storage: ServerStorage['storage'], id: string): Promise<boolean> {
  return storage.scenes.remove ? storage.scenes.remove(id) : false;
}

export interface CreateServerStorageOptions {
  env?: NodeJS.ProcessEnv;
  /** 文件存储路径（file 后端用）。 */
  dataPath?: string;
}

export async function createServerStorage(options: CreateServerStorageOptions = {}): Promise<ServerStorage> {
  const env = options.env ?? process.env;
  const wanted = (env.TWIN_STORAGE ?? '').toLowerCase();
  const usePostgres = wanted === 'postgres' || (wanted !== 'file' && Boolean(env.DATABASE_URL));

  if (wanted && wanted !== 'postgres' && wanted !== 'file') {
    throw new Error(`TWIN_STORAGE 取值非法：${wanted}。只能是 postgres 或 file。`);
  }

  if (usePostgres) {
    const result = await connectPostgresStorage({ url: env.DATABASE_URL, schema: env.TWIN_PG_SCHEMA || undefined });
    const health = await result.health();
    return {
      backend: 'postgres',
      storage: result.storage,
      detail: {
        driver: result.driver.kind,
        databaseUrl: env.DATABASE_URL ? maskUrl(env.DATABASE_URL) : null,
        schema: env.TWIN_PG_SCHEMA || null,
        healthy: health.ok,
        serverVersion: health.version,
      },
      async flush() {},
      async close() {
        await result.driver.close();
      },
    };
  }

  const file = createFileStorage({ path: options.dataPath ?? env.TWIN_DATA ?? 'data/twin.json' });
  await file.ready();
  return {
    backend: 'file',
    storage: file as unknown as ServerStorage['storage'],
    detail: { dataPath: file.path },
    async flush() {
      await file.flush();
    },
    async close() {
      await file.flush();
    },
  };
}

/** 连接串脱敏：只保留 host:port/db，不暴露账号密码。 */
function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname || '/'}`;
  } catch {
    return '***';
  }
}
