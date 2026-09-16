import { describe, expect, test } from 'bun:test';
import { splitSqlStatements, applyMigrations, readMigrations, type Migration, type SqlExecutor, type SqlRow } from './migrate';

describe('splitSqlStatements / 词法切分', () => {
  test('基础分号切分，忽略空白语句', () => {
    expect(splitSqlStatements('select 1; select 2 ;')).toEqual(['select 1', 'select 2']);
    expect(splitSqlStatements('select 1;;;')).toEqual(['select 1']);
  });

  test('跳过行注释里的分号', () => {
    const stmts = splitSqlStatements('select 1; -- 注释里的分号; 不应断开\nselect 2;');
    expect(stmts).toEqual(['select 1', 'select 2']);
  });

  test('跳过单引号字符串里的分号与转义', () => {
    const stmts = splitSqlStatements("insert into t values ('a;b''c'); select 2;");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("'a;b''c'");
  });

  test('美元引用 $$ 整体成句，闭界 $$ 不被当语句结束', () => {
    const sql = `create or replace function f() returns void as $$
begin
  perform 1;
end;
$$ language plpgsql;
select 1;`;
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('perform 1;');
    expect(stmts[0]!.trimEnd()).toBe('create or replace function f() returns void as $$\nbegin\n  perform 1;\nend;\n$$ language plpgsql');
  });

  test('命名美元引用 $tag$ 与匿名 $$ 等价处理', () => {
    const sql = 'create function f() returns void as $body$\n select 1;\n$body$ language plpgsql;';
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain('$body$');
  });
});

describe('readMigrations / 读取迁移目录', () => {
  test('按文件名排序', () => {
    const migrations = readMigrations();
    expect(migrations.map((m) => m.name)).toEqual([...migrations.map((m) => m.name)].sort());
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]!.name).toMatch(/^001_/);
  });
});

/** 假 executor：记录所有收到的语句，返回可控结果。 */
class RecordingExecutor implements SqlExecutor {
  readonly statements: string[] = [];
  private readonly responder: (sql: string) => SqlRow[];

  constructor(responder: (sql: string) => SqlRow[] = () => []) {
    this.responder = responder;
  }

  async query<T extends SqlRow = SqlRow>(text: string, _params?: readonly unknown[]): Promise<T[]> {
    this.statements.push(text);
    return this.responder(text) as T[];
  }
}

describe('applyMigrations / 幂等执行', () => {
  const migrations: Migration[] = [
    { name: '001_a.sql', sql: 'create table a (id int);\ninsert into a values (1);' },
    { name: '002_b.sql', sql: 'create table b (id int);' },
  ];

  test('首次执行全部，并记录到 _twin_migrations 台账', async () => {
    const executor = new RecordingExecutor(() => [{ ok: 1 }]);
    const result = await applyMigrations(executor, { migrations });
    expect(result.applied).toEqual(['001_a.sql', '002_b.sql']);
    expect(result.skipped).toEqual([]);
    // 建表语句 + insert + 台账建表 + 台账插入
    expect(executor.statements.some((s) => s.includes('create table if not exists _twin_migrations'))).toBe(true);
    expect(executor.statements.some((s) => s.includes('create table a'))).toBe(true);
    expect(executor.statements.some((s) => s.includes('insert into a values'))).toBe(true);
    expect(executor.statements.some((s) => s.includes('insert into _twin_migrations'))).toBe(true);
  });

  test('重复执行只补未跑过的，已跑过的被跳过', async () => {
    // 模拟：台账查询返回 001 已存在
    const executor = new RecordingExecutor((sql) => {
      if (sql.includes('from _twin_migrations')) return [{ name: '001_a.sql' }];
      return [{ ok: 1 }];
    });
    const result = await applyMigrations(executor, { migrations });
    expect(result.applied).toEqual(['002_b.sql']);
    expect(result.skipped).toEqual(['001_a.sql']);
    expect(executor.statements.some((s) => s.includes('create table a'))).toBe(false);
    expect(executor.statements.some((s) => s.includes('create table b'))).toBe(true);
  });

  test('真实执行迁移能建出全部表（PGlite 兜底跳过 $$ 函数）', async () => {
    const pglite = await import('@electric-sql/pglite').then((m) => m).catch(() => null);
    if (!pglite) {
      console.warn('[migrate] 未安装 @electric-sql/pglite，跳过真实建表验证：bun add -d @electric-sql/pglite。');
      return;
    }
    const db = await (pglite as { PGlite: { create: (o?: unknown) => Promise<PGliteLike> } }).PGlite.create();
    const executor: SqlExecutor = {
      async query(text, params) {
        if (params && params.length > 0) {
          const res = await (db as PGliteLike).query(text, params as unknown[]);
          return (res.rows ?? []) as SqlRow[];
        }
        const res = await (db as PGliteLike).exec(text);
        return ((res[res.length - 1]?.rows ?? []) as SqlRow[]);
      },
    };
    const all = readMigrations().map((m) => ({
      name: m.name,
      sql: splitSqlStatements(m.sql)
        .filter((s) => !s.includes('twin_ensure_event_partitions'))
        .join(';\n'),
    }));
    const result = await applyMigrations(executor, { migrations: all });
    expect(result.applied.length + result.skipped.length).toBe(all.length);
    // 确认核心表已建
    const tables = (await (db as PGliteLike).query(
      "select table_name from information_schema.tables where table_schema='public' and table_name in ('scene_versions','twin_events','world_snapshots','entity_state_latest','metric_rollups','replay_sessions')",
    )) as { rows: { table_name: string }[] };
    expect(tables.rows.map((r) => r.table_name).sort()).toEqual([
      'entity_state_latest',
      'metric_rollups',
      'replay_sessions',
      'scene_versions',
      'twin_events',
      'world_snapshots',
    ]);
    await (db as PGliteLike).close();
  });
});

interface PGliteLike {
  query(text: string, params?: readonly unknown[]): Promise<{ rows?: unknown[] }>;
  exec(text: string): Promise<{ rows?: unknown[] }[]>;
  close(): Promise<void>;
}
