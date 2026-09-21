import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqlExecutor } from './index';

/**
 * 迁移执行器。
 *
 * SQL 是一段文本，但"切分语句"这件事远比 `split(';')` 危险：函数体里的
 * `$$ ... $$` 美元引用、字符串常量里的分号、行注释里的分号都会误伤。这里给一个
 * 真正的词法切分器，能正确跳过这些区域，只在没有"语法上下文"的分号处断开。
 *
 * 执行是幂等的：每个迁移名记进 `_twin_migrations` 台账表，重跑只补没跑过的。
 * 再加上建表语句本身全是 `if not exists`，哪怕台账表丢了也不会重复建表出错。
 */

export interface Migration {
  name: string;
  sql: string;
}

/**
 * 把一段迁移 SQL 切成一个个可独立执行的语句。
 *
 * 会正确跳过：
 * - 行注释 `-- ...`（不跨行）；
 * - 单引号字符串（支持 `''` 转义，符合 PG 默认 `standard_conforming_strings`）；
 * - 美元引用 `$tag$ ... $tag$`（tag 可为空，即 `$$`）；
 * 其余位置的 `;` 才算语句结束。
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let buffer = '';
  let i = 0;
  const n = sql.length;
  let quote: string | null = null; // 当前处于哪种定界符内
  let dollarTag: string | null = null; // 美元引用的 tag（含 $ 符号），如 `$$` / `$body$`

  while (i < n) {
    const char = sql[i]!;
    const next = i + 1 < n ? sql[i + 1]! : '';

    if (quote === "'") {
      // 行注释只在引号外有效；这里在字符串里，直接吞。
      buffer += char;
      if (char === "'") {
        // 连续两个单引号是转义，不是结束
        if (next === "'") {
          buffer += next;
          i += 2;
          continue;
        }
        quote = null;
      }
      i += 1;
      continue;
    }

    if (dollarTag !== null) {
      buffer += char;
      // 检查是否遇到闭合 tag。注意：闭界的 `$` 后面必须还有字符（tag 的结束 `$`
      // 或更长 tag 的后续字母）——`$$` 紧接 `;` / 结尾时，第一个 `$` 不是闭合起点，
      // 否则会把 `$$;` 误拆成两个 `$`，导致"unterminated dollar-quoted string"。
      const after = sql.slice(i, i + dollarTag.length);
      if (char === '$' && after === dollarTag && i + dollarTag.length < n) {
        // 已经 append 了 char（tag 首字符），这里补上剩余字符，整段 tag 才算完整。
        buffer += dollarTag.slice(1);
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      i += 1;
      continue;
    }

    if (char === "'") {
      quote = "'";
      buffer += char;
      i += 1;
      continue;
    }

    if (char === '$') {
      // 可能是美元引用：$tag$ 形式，tag 为字母/数字/下划线组合
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        dollarTag = tagMatch[0];
        buffer += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }

    if (char === '-' && next === '-') {
      // 行注释：吞到行尾
      while (i < n && sql[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    if (char === ';') {
      const trimmed = buffer.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      buffer = '';
      i += 1;
      continue;
    }

    buffer += char;
    i += 1;
  }

  const tail = buffer.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

/**
 * 读取迁移目录，按文件名排序（`001_*.sql` < `002_*.sql`）。
 *
 * 默认目录是打包后的 `migrations/`（与本源文件同级的 `../migrations`）。
 */
export function readMigrations(dir: string = fileURLToPath(new URL('../migrations', import.meta.url))): Migration[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

export interface MigrationResult {
  /** 本次新执行的迁移名。 */
  applied: string[];
  /** 已存在、被跳过的迁移名。 */
  skipped: string[];
}

/** 表名加上可选 schema 前缀，给内部台账表用。 */
const qualified = (schema: string | undefined) => (name: string): string => (schema ? `${schema}.${name}` : name);

/**
 * 幂等执行全部迁移。
 *
 * @param executor 任意 `SqlExecutor`（含 Bun.sql / pg / PGlite 包装）。
 * @param options.schema 表前缀，例如 `twin`。
 * @param options.migrations 显式传入；不传则读默认目录。
 */
export async function applyMigrations(
  executor: SqlExecutor,
  options: {
    schema?: string;
    migrations?: Migration[];
    migrationsDir?: string;
    /**
     * 跳过某些语句（整条 `;` 切分后的语句）。用于 PGlite 等真 PG 子集：
     * 它们对 `$$` 美元引用里的动态 DDL（如 `twin_ensure_event_partitions`）解析有局限，
     * 而 `twin_events` 已有 DEFAULT 分区兜底，跳过不影响入库与契约。
     */
    skipStatement?: (sql: string) => boolean;
  } = {},
): Promise<MigrationResult> {
  const name = qualified(options.schema);
  const migrations = options.migrations ?? readMigrations(options.migrationsDir);

  await executor.query(
    `create table if not exists ${name('_twin_migrations')} (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const appliedRows = await executor.query(`select name from ${name('_twin_migrations')}`);
  const appliedSet = new Set(appliedRows.map((row) => String(row.name)));

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const migration of migrations) {
    if (appliedSet.has(migration.name)) {
      result.skipped.push(migration.name);
      continue;
    }
    for (const statement of splitSqlStatements(migration.sql)) {
      if (options.skipStatement?.(statement)) continue;
      await executor.query(statement);
    }
    await executor.query(`insert into ${name('_twin_migrations')} (name) values ($1) on conflict (name) do nothing`, [migration.name]);
    appliedSet.add(migration.name);
    result.applied.push(migration.name);
  }

  return result;
}
