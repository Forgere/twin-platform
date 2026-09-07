import type { TwinValue, TwinVector3 } from '@twin-platform/scene-schema';
import type { ExternalEntityState, ExternalFrame, ExternalSignal } from '@twin-platform/world-kernel';

/**
 * CSV → `ExternalFrame[]`。
 *
 * 列名约定（大小写不敏感，别名也算）：
 *
 * | 列 | 含义 |
 * | --- | --- |
 * | `t` / `time` / `timestamp` | 数据源时间（秒，必填） |
 * | `id` / `entity` / `entityId` | 实体 id（必填） |
 * | `signal` | `pose` / `progress` / `entry` / `span`；省略时按出现的列推断 |
 * | `x`,`y`,`z`,`heading` | `pose` 用；`heading` 也接受 `yaw` |
 * | `frame` | `world` / `local`，默认按 `defaultFrame` |
 * | `progress` | `progress` 用，0…1 |
 * | `tEnter` | `entry` / `span` 用 |
 * | `tExit` | `span` 用 |
 * | `kind` | 外部实体的类型 |
 * | 其余列 | 原样进 `attrs`，能解析成数字就存数字 |
 *
 * 同一时刻的多行会合并成一帧；同一实体同一时刻重复出现时后出现的胜出。
 */

export interface CsvParseOptions {
  delimiter?: string;
  /** `pose` 信号的默认坐标系，默认 `local`（与场景契约一致）。 */
  defaultFrame?: 'world' | 'local';
  /** 是否忽略首行表头（默认 true）。 */
  header?: boolean;
}

export interface CsvParseIssue {
  /** 从 1 开始的行号（含表头）。 */
  line: number;
  message: string;
}

export interface CsvParseResult {
  frames: ExternalFrame[];
  issues: CsvParseIssue[];
  /** 成功解析的行数。 */
  rows: number;
}

const TIME_KEYS = ['t', 'time', 'timestamp'];
const ID_KEYS = ['id', 'entity', 'entityid'];
const SIGNAL_KEYS = ['signal', 'kind_signal'];
const RESERVED = new Set([
  ...TIME_KEYS,
  ...ID_KEYS,
  ...SIGNAL_KEYS,
  'x',
  'y',
  'z',
  'heading',
  'yaw',
  'frame',
  'progress',
  'tenter',
  'texit',
  'kind',
]);

/**
 * 最小可用的 CSV 行切分：支持引号包裹、引号内逗号和 `""` 转义。
 *
 * 不引第三方解析器，是因为这是唯一一处格式假设，写在这里比引依赖更好排查；
 * 真遇到 RFC 4180 的边角（字段内换行）再换实现也不影响调用方。
 */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      fields.push(field);
      field = '';
      continue;
    }
    field += char;
  }
  fields.push(field);
  return fields.map((value) => value.trim());
}

const pick = (row: Map<string, string>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = row.get(key);
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
};

const toNumber = (value: string | undefined): number | undefined => {
  // 空串必须当"没给"：`Number('')` 是 0，会让缺列的 progress 悄悄变成 0，
  // 回放时表现为设备瞬间跳到起点，而不是报错。
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

function inferSignal(row: Map<string, string>): ExternalSignal['kind'] {
  if (row.has('x') || row.has('y') || row.has('z')) return 'pose';
  if (row.has('progress')) return 'progress';
  if (row.has('texit')) return 'span';
  if (row.has('tenter')) return 'entry';
  return 'pose';
}

function buildSignal(row: Map<string, string>, kind: ExternalSignal['kind'], defaultFrame: 'world' | 'local'): ExternalSignal | undefined {
  switch (kind) {
    case 'pose': {
      const position: TwinVector3 = [toNumber(row.get('x')) ?? 0, toNumber(row.get('y')) ?? 0, toNumber(row.get('z')) ?? 0];
      const heading = toNumber(pick(row, ['heading', 'yaw']));
      const frame = row.get('frame') === 'world' || row.get('frame') === 'local' ? (row.get('frame') as 'world' | 'local') : defaultFrame;
      return { kind: 'pose', frame, position, ...(heading !== undefined ? { heading } : {}) };
    }
    case 'progress': {
      const progress = toNumber(row.get('progress'));
      if (progress === undefined) return undefined;
      return { kind: 'progress', progress };
    }
    case 'entry': {
      const tEnter = toNumber(pick(row, ['tenter']));
      if (tEnter === undefined) return undefined;
      return { kind: 'entry', tEnter };
    }
    case 'span': {
      const tEnter = toNumber(pick(row, ['tenter']));
      const tExit = toNumber(pick(row, ['texit']));
      if (tEnter === undefined || tExit === undefined) return undefined;
      return { kind: 'span', tEnter, tExit };
    }
  }
}

export function parseCsv(text: string, options: CsvParseOptions = {}): CsvParseResult {
  const delimiter = options.delimiter ?? ',';
  const defaultFrame = options.defaultFrame ?? 'local';
  const hasHeader = options.header ?? true;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const issues: CsvParseIssue[] = [];
  if (lines.length === 0) return { frames: [], issues, rows: 0 };

  const headerLine = hasHeader ? lines[0] : undefined;
  const header = hasHeader ? splitCsvLine(headerLine ?? '', delimiter).map((key) => key.toLowerCase()) : [];
  if (hasHeader && header.length === 0) issues.push({ line: 1, message: '表头为空，无法解析。' });

  const body = hasHeader ? lines.slice(1) : lines;
  /** 按 (时间, 行号) 有序：同一时刻保持文件里的先后顺序。 */
  const rows: { time: number; order: number; state: ExternalEntityState }[] = [];
  let parsed = 0;

  body.forEach((line, index) => {
    const lineNumber = index + (hasHeader ? 2 : 1);
    const cells = splitCsvLine(line, delimiter);
    const row = new Map<string, string>();
    if (hasHeader) {
      header.forEach((key, column) => {
        const value = cells[column];
        if (value !== undefined) row.set(key, value);
      });
    } else {
      // 无表头时按约定顺序：t,id,signal,x,y,z,heading,progress,tEnter,tExit,kind
      const positional = ['t', 'id', 'signal', 'x', 'y', 'z', 'heading', 'progress', 'tenter', 'texit', 'kind'];
      positional.forEach((key, column) => {
        const value = cells[column];
        if (value !== undefined) row.set(key, value);
      });
    }

    const rawTime = toNumber(pick(row, TIME_KEYS));
    if (rawTime === undefined) {
      issues.push({ line: lineNumber, message: '缺少可解析的时间列（t/time/timestamp）。' });
      return;
    }
    const id = pick(row, ID_KEYS);
    if (id === undefined || id === '') {
      issues.push({ line: lineNumber, message: '缺少实体 id 列（id/entity/entityId）。' });
      return;
    }

    const declared = pick(row, SIGNAL_KEYS);
    const kind: ExternalSignal['kind'] =
      declared === 'pose' || declared === 'progress' || declared === 'entry' || declared === 'span' ? declared : inferSignal(row);
    const signal = buildSignal(row, kind, defaultFrame);
    if (!signal) {
      issues.push({ line: lineNumber, message: `信号 ${kind} 缺少必需列。` });
      return;
    }

    const attrs: Record<string, TwinValue> = {};
    for (const [key, value] of row) {
      if (RESERVED.has(key)) continue;
      attrs[key] = toNumber(value) ?? value;
    }

    const entityKind = pick(row, ['kind']);
    const state: ExternalEntityState = {
      id,
      signal,
      ...(entityKind !== undefined ? { kind: entityKind } : {}),
      ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    };
    rows.push({ time: rawTime, order: index, state });
    parsed += 1;
  });

  rows.sort((a, b) => a.time - b.time || a.order - b.order);

  const frames: ExternalFrame[] = [];
  for (const row of rows) {
    const last = frames[frames.length - 1];
    if (last && last.sourceTime === row.time) {
      // 同帧内同一实体后写覆盖先写，保持"后出现的胜出"
      const entities = last.entities.filter((entity) => entity.id !== row.state.id);
      entities.push(row.state);
      frames[frames.length - 1] = { ...last, entities };
      continue;
    }
    frames.push({ sourceTime: row.time, entities: [row.state] });
  }

  return { frames, issues, rows: parsed };
}
