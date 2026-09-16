import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import type { WorldEvent } from '@twin-platform/world-kernel';
import { runStorageContractTests } from '@twin-platform/storage-testkit';
import { createPostgresStorage, type SqlExecutor, type SqlRow } from './index';

/**
 * 适配器测试分两层：
 *
 * 1. **不需要数据库**：用假 executor 断言生成的 SQL、参数占位符和行映射——
 *    这部分覆盖"我们写的 SQL 对不对"，任何机器上都能跑；
 * 2. **需要数据库**：`DATABASE_URL` 存在且装了 `pg` 时，跑和内存实现完全相同的
 *    契约套件。本机没装 PostgreSQL 时跳过，并明确提示，避免假装通过。
 */

class FakeExecutor implements SqlExecutor {
  readonly calls: { text: string; params: readonly unknown[] | undefined }[] = [];

  constructor(private readonly respond: (text: string) => SqlRow[] = () => []) {}

  async query<T extends SqlRow>(text: string, params?: readonly unknown[]): Promise<T[]> {
    this.calls.push({ text, params });
    return this.respond(text) as T[];
  }

  get last(): { text: string; params: readonly unknown[] | undefined } {
    return this.calls[this.calls.length - 1] as { text: string; params: readonly unknown[] | undefined };
  }

  get sql(): string {
    return this.last.text.replace(/\s+/g, ' ').trim();
  }
}

const event = (sequence: number, patch: Partial<WorldEvent> = {}): WorldEvent => ({
  sequence,
  occurredAt: sequence * 0.5,
  type: 'cargo:passed',
  entityId: 'cargo-01',
  ...patch,
});

describe('createPostgresStorage / SQL 生成', () => {
  test('追加事件前先读 max(sequence)，批内也做单调检查', async () => {
    const executor = new FakeExecutor((text) => (text.includes('max(sequence)') ? [{ max_sequence: 5 }] : []));
    const storage = createPostgresStorage(executor);

    await expect(storage.events.append('line-a', [event(6), event(5)])).rejects.toThrow(/严格单调/);
    await storage.events.append('line-a', [event(6), event(7)]);

    const insert = executor.calls[executor.calls.length - 1] as { text: string; params: readonly unknown[] };
    expect(insert.text).toContain('insert into twin_events');
    // scene_id 复用 $1，每行 6 个参数
    expect(insert.params?.[0]).toBe('line-a');
    expect(insert.params).toHaveLength(1 + 2 * 6);
    expect(insert.text).toContain('( $1, $2, $3, $4, $5, $6, $7::jsonb )');
    expect(insert.text).toContain('( $1, $8, $9, $10, $11, $12, $13::jsonb )');
  });

  test('查询条件与 limit 全部走参数绑定', async () => {
    const executor = new FakeExecutor();
    const storage = createPostgresStorage(executor);
    await storage.events.query('line-a', { sinceSequence: 3, untilSequence: 9, entityId: 'cargo-01', type: 'cargo:passed', limit: 10 });

    expect(executor.sql).toContain('sequence > $2');
    expect(executor.sql).toContain('sequence <= $3');
    expect(executor.sql).toContain('entity_id = $4');
    expect(executor.sql).toContain('type = $5');
    expect(executor.sql).toContain('limit $6');
    expect(executor.sql).toContain('order by sequence');
    expect(executor.last.params).toEqual(['line-a', 3, 9, 'cargo-01', 'cargo:passed', 10]);
  });

  test('truncateAfter 用 returning 计数', async () => {
    const executor = new FakeExecutor(() => [{ sequence: 1 }, { sequence: 2 }]);
    const storage = createPostgresStorage(executor);
    expect(await storage.events.truncateAfter('line-a', 4)).toBe(2);
    expect(executor.sql).toContain('delete from twin_events');
    expect(executor.sql).toContain('returning sequence');
  });

  test('事件行映射：jsonb 字符串与对象两种形态都能还原', async () => {
    const executor = new FakeExecutor(() => [
      { sequence: '3', occurred_at: 1.5, type: 'cargo:passed', entity_id: 'cargo-01', detail: null, payload: '{"jitter":0.5}' },
    ]);
    const storage = createPostgresStorage(executor);
    const [first] = await storage.events.query('line-a');
    expect(first).toMatchObject({ sequence: 3, occurredAt: 1.5, type: 'cargo:passed', entityId: 'cargo-01' });
    expect(first?.detail).toBeUndefined();
    expect(first?.payload).toEqual({ jitter: 0.5 });
  });

  test('快照写入是 upsert，按时间与按 sequence 都能回溯', async () => {
    const executor = new FakeExecutor();
    const storage = createPostgresStorage(executor);
    await storage.snapshots.put('line-a', {
      sceneId: 'line-a',
      sequence: 4,
      time: 2,
      step: 1 / 60,
      seed: 7,
      rngState: 99,
      mode: 'sim',
      entities: [],
    });
    expect(executor.sql).toContain('on conflict (scene_id, sequence) do update');

    await storage.snapshots.atOrBeforeTime('line-a', 2);
    expect(executor.sql).toContain('order by time desc, sequence desc limit 1');
    await storage.snapshots.atOrBefore('line-a', 4);
    expect(executor.sql).toContain('order by sequence desc limit 1');
  });

  test('指标写入按桶累加，空实体 id 用空串占位', async () => {
    const executor = new FakeExecutor();
    const storage = createPostgresStorage(executor);
    await storage.metrics.put([
      { sceneId: 'line-a', metric: 'event.count', bucketStart: 0, bucketSize: 60, value: 1, count: 1 },
      { sceneId: 'line-a', metric: 'event.count', entityId: 'cargo-01', bucketStart: 60, bucketSize: 60, value: 2, count: 3 },
    ]);

    expect(executor.sql).toContain('value = metric_rollups.value + excluded.value');
    expect(executor.sql).toContain('count = metric_rollups.count + excluded.count');
    expect(executor.last.params).toEqual(['line-a', 'event.count', '', 0, 60, 1, 1, expect.anything(), 'line-a', 'event.count', 'cargo-01', 60, 60, 2, 3, expect.anything()]);
    expect(await storage.metrics.put([])).toBe(0);
  });

  test('结束会话没有命中行时抛错，不静默成功', async () => {
    const executor = new FakeExecutor(() => []);
    const storage = createPostgresStorage(executor);
    await expect(storage.sessions.finish('missing', 1)).rejects.toThrow(/不存在/);
    expect(executor.sql).toContain('update replay_sessions set duration = $2 where id = $1 returning id');
  });

  test('schema 前缀会加到每个表名上', async () => {
    const executor = new FakeExecutor();
    const storage = createPostgresStorage(executor, { schema: 'twin' });
    await storage.scenes.listScenes();
    expect(executor.sql).toContain('twin.scene_versions');
  });

  test('场景写入取最新版本号 +1，而不是覆盖', async () => {
    const executor = new FakeExecutor(() => [{ version: 3, created_at: '2026-09-07T00:00:00.000Z' }]);
    const storage = createPostgresStorage(executor);
    const summary = await storage.scenes.putScene({ version: 1, id: 'line-a', name: '产线 A', entities: [] });

    expect(executor.sql).toContain('coalesce((select max(version) + 1');
    expect(summary).toEqual({ id: 'line-a', name: '产线 A', version: 3, updatedAt: '2026-09-07T00:00:00.000Z' });
  });
});

describe('迁移脚本', () => {
  const sql = readFileSync(join(import.meta.dir, '..', 'migrations', '001_init.sql'), 'utf8');

  test('覆盖行动计划里约定的全部表', () => {
    for (const table of [
      'projects',
      'scene_versions',
      'plugin_installations',
      'replay_sessions',
      'world_snapshots',
      'twin_events',
      'entity_state_latest',
      'metric_rollups',
      'assets',
    ]) {
      expect(sql).toContain(`create table if not exists ${table}`);
    }
  });

  test('事件表按 received_at 分区，并有默认分区兜底', () => {
    expect(sql).toContain('partition by range (received_at)');
    expect(sql).toContain('twin_events_default partition of twin_events default');
    expect(sql).toContain('twin_ensure_event_partitions');
  });
});

// ---------------------------------------------------------------------------
// 需要真实数据库的一层
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
const driver = await import('pg')
  .then((module) => module)
  .catch(() => undefined);

if (url && driver) {
  const pool = new driver.Pool({ connectionString: url });
  const resetSql = `truncate table twin_events, world_snapshots, replay_sessions, entity_state_latest, metric_rollups, scene_versions`;

  await pool.query(readFileSync(join(import.meta.dir, '..', 'migrations', '001_init.sql'), 'utf8'));

  runStorageContractTests('postgres', async () => {
    await pool.query(resetSql);
    return {
      storage: createPostgresStorage(pool),
      async reset() {
        await pool.query(resetSql);
      },
    };
  });

  afterAll(async () => {
    await pool.end();
  });
} else if (url && !driver) {
  console.warn('[storage-postgres] 未安装 pg 驱动，跳过契约测试：先执行 bun add -d pg。');
} else {
  console.warn('[storage-postgres] 未设置 DATABASE_URL，跳过 pg 契约测试（可装 @electric-sql/pglite 跑零依赖真 PG 验证）。');
}

// ---------------------------------------------------------------------------
// 零依赖真 PostgreSQL 验证（PGlite / WASM）
// ---------------------------------------------------------------------------
// PGlite 是编译进 WASM 的真实 PostgreSQL，给没有装 PostgreSQL 的机器一个零依赖的
// 真引擎来验证我们的 SQL。注意：PGlite 0.5 对含动态 DDL 的 `$$` plpgsql 函数体有
// 解析局限（真实 PostgreSQL 18 完全合法），迁移里那条分区维护函数在此跳过——
// `twin_events` 已有 DEFAULT 分区兜底，不影响入库与契约。

const pgliteMod = await import('@electric-sql/pglite')
  .then((module) => module)
  .catch(() => undefined);

if (pgliteMod) {
  const { PGlite } = pgliteMod as { PGlite: { create: (o?: { dataDir?: string }) => Promise<PGliteLike> } };
  const db = await PGlite.create({ dataDir: 'memory://' });
  const executor: SqlExecutor = {
    async query(text, params) {
      if (params && params.length > 0) {
        const res = await db.query(text, params as unknown[]);
        return (res.rows ?? []) as SqlRow[];
      }
      const res = await db.exec(text);
      return (res[res.length - 1]?.rows ?? []) as SqlRow[];
    },
  };

  // 迁移：跳过 `$$` 分区维护函数（PGlite 解析局限），其余建表照常。
  const { readMigrations, splitSqlStatements, applyMigrations } = await import('./migrate');
  const migrations = readMigrations().map((m) => ({
    name: m.name,
    sql: splitSqlStatements(m.sql)
      .filter((s) => !s.includes('twin_ensure_event_partitions'))
      .join(';\n'),
  }));
  await applyMigrations(executor, { migrations });

  runStorageContractTests('postgres/pglite', async () => {
    // 清空全部派生数据（逐表 delete，PGlite 不支持 truncate 分区父表，也非标准多表 delete）。
    for (const table of ['twin_events', 'world_snapshots', 'replay_sessions', 'entity_state_latest', 'metric_rollups', 'scene_versions']) {
      await executor.query(`delete from ${table}`);
    }
    return {
      storage: createPostgresStorage(executor),
      async reset() {
        for (const table of ['twin_events', 'world_snapshots', 'replay_sessions', 'entity_state_latest', 'metric_rollups', 'scene_versions']) {
          await executor.query(`delete from ${table}`);
        }
      },
    };
  });

  test('remove 级联清理事件/快照/状态/指标/会话', async () => {
    const storage = createPostgresStorage(executor);
    await storage.scenes.putScene({ version: 1, id: 'rm', name: '待删', entities: [] });
    await storage.events.append('rm', [{ sequence: 1, occurredAt: 0.5, type: 'e', entityId: 'x' }]);
    await storage.snapshots.put('rm', { sceneId: 'rm', sequence: 1, time: 0.5, step: 1 / 60, seed: 1, rngState: 1, mode: 'sim', entities: [] });
    await storage.state.upsert('rm', [{ entityId: 'x', kind: 'k', attrs: {}, transform: { position: [0, 0, 0] }, dataSource: 'sim', updatedSequence: 1, updatedAt: 0.5 }]);
    await storage.metrics.put([{ sceneId: 'rm', metric: 'c', bucketStart: 0, bucketSize: 60, value: 1, count: 1 }]);
    expect(await storage.scenes.remove('rm')).toBe(true);
    expect(await storage.scenes.getScene('rm')).toBeNull();
    expect(await storage.events.query('rm')).toEqual([]);
    expect(await storage.snapshots.latest('rm')).toBeNull();
    expect(await storage.state.list('rm')).toEqual([]);
    expect(await storage.metrics.query('rm')).toEqual([]);
    expect(await storage.scenes.remove('missing')).toBe(false);
  });

  afterAll(async () => {
    await db.close();
  });
}

interface PGliteLike {
  query(text: string, params?: readonly unknown[]): Promise<{ rows?: unknown[] }>;
  exec(text: string): Promise<{ rows?: unknown[] }[]>;
  close(): Promise<void>;
}

