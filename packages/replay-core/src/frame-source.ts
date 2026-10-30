import type { TwinTransform, TwinValue, TwinVector3 } from '@twin-platform/scene-schema';
import type { ExternalEntityState, ExternalFrame, ExternalSignal, TwinWorld } from '@twin-platform/world-kernel';
import type { ExternalFrameSource } from './controller';

/**
 * 实时协议帧源的公共底座（`ExternalFrameSource` 的缓冲实现）。
 *
 * MQTT / OPC-UA 与 CSV 的本质差别只在"帧从哪来"：CSV 是预先落在文件里的，
 * MQTT/OPC-UA 是常驻进程运行时源源不断收到的。`BufferedFrameSource` 把"收到帧→
 * 入队→按仿真时间喂给世界→可 rewind 重放"这套逻辑收拢成一处，两个协议包各自
 * 只管"把协议消息翻译成 `ExternalFrame` 然后调 `append`"。
 *
 * 缓冲与重放语义（与 `CsvFrameSource` 完全一致，保证 `seek` 靠重算而非插值）：
 * - `feedTo(world, time)` 只喂 `sourceTime <= time` 且尚未喂过的帧，幂等；
 * - `rewind()` 把游标拨回 0，同一段缓冲可再喂一遍；
 * - 帧按 `sourceTime` 升序插入，因此"喂到哪了"用一个游标就够，无需每步全扫。
 *
 * 资源上限：`maxFrames` 让常驻进程不会因为跑了几天的遥测把内存撑爆——
 * 超出时丢弃最旧（必然已经喂过的）帧，游标同步前移。
 */

export interface BufferedFrameSourceOptions {
  /** 时间轴时长上限（秒）；默认取 buffer 最后一帧的 `sourceTime`。 */
  duration?: number;
  /**
   * buffer 最多保留多少帧。超出时丢弃最旧（已喂过）的帧，防止常驻进程内存膨胀。
   * 设为 0 或不传表示不限制（适合短会话 / 测试）。
   */
  maxFrames?: number;
}

export class BufferedFrameSource implements ExternalFrameSource {
  private frames: ExternalFrame[] = [];
  private cursor = 0;
  private readonly explicitDuration?: number;
  private readonly maxFrames?: number;

  constructor(options: BufferedFrameSourceOptions = {}) {
    this.explicitDuration = options.duration;
    this.maxFrames = options.maxFrames;
  }

  /** 已缓冲的帧（只读快照），调试 / 监控用。 */
  protected get buffered(): readonly ExternalFrame[] {
    return this.frames;
  }

  /** 已喂到第几帧。 */
  get fedCount(): number {
    return this.cursor;
  }

  /** 当前 buffer 里的总帧数。 */
  get size(): number {
    return this.frames.length;
  }

  /** 子类在收到协议消息、解析出 `ExternalFrame` 后调用：入队（按 `sourceTime` 升序）。 */
  protected append(frame: ExternalFrame): void {
    const t = frame.sourceTime ?? 0;
    let index = this.frames.length;
    while (index > 0 && (this.frames[index - 1]?.sourceTime ?? 0) > t) index -= 1;
    this.frames.splice(index, 0, frame);
    this.enforceRetention();
  }

  get duration(): number {
    if (this.explicitDuration !== undefined) return this.explicitDuration;
    const last = this.frames[this.frames.length - 1];
    return last?.sourceTime ?? 0;
  }

  feedTo(world: TwinWorld, time: number): void {
    while (this.cursor < this.frames.length) {
      const frame = this.frames[this.cursor];
      if (!frame) break;
      if ((frame.sourceTime ?? 0) > time) return;
      this.cursor += 1;
      world.ingestExternalFrame(frame);
    }
  }

  rewind(): void {
    this.cursor = 0;
  }

  private enforceRetention(): void {
    if (this.maxFrames === undefined || this.maxFrames <= 0 || this.frames.length <= this.maxFrames) return;
    const drop = this.frames.length - this.maxFrames;
    this.frames.splice(0, drop);
    this.cursor = Math.max(0, this.cursor - drop);
  }
}

// -----------------------------------------------------------------------------
// 协议无关的消息映射：twin JSON 信封 → `ExternalFrame`
// -----------------------------------------------------------------------------

const TIME_KEYS = ['t', 'time', 'timestamp'];
const ID_KEYS = ['id', 'entity', 'entityid'];
const SIGNAL_KEYS = ['signal', 'kind_signal'];
const RESERVED = new Set<string>([
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
  'transform',
]);

export interface EntityStateMappingOptions {
  /** `pose` 信号的默认坐标系，默认 `local`（与场景契约一致）。 */
  defaultFrame?: 'world' | 'local';
  /** 抽取实体 id 的键名（大小写不敏感），默认 `id` / `entity` / `entityId`。 */
  idKeys?: string[];
  /** 抽取数据源时间的键名（大小写不敏感），默认 `t` / `time` / `timestamp`。 */
  timeKeys?: string[];
}

/**
 * 把一条"twin JSON 信封"消息翻译成一帧 `ExternalFrame`。
 *
 * 信封形状（大小写不敏感，与 CSV 列名对齐，便于把同一套数据既落表又发 MQTT）：
 *
 * | 字段 | 含义 |
 * | --- | --- |
 * | `t` / `time` / `timestamp` | 数据源时间（秒）；缺省时 `sourceTime` 为 undefined，由帧源按到达时刻补 |
 * | `id` / `entity` / `entityId` | 实体 id（必填，否则整条丢弃） |
 * | `signal` | `pose` / `progress` / `entry` / `span`；省略时按出现的字段推断 |
 * | `x`,`y`,`z`,`heading` | `pose` 用；`heading` 也接受 `yaw` |
 * | `frame` | `world` / `local`，默认 `defaultFrame` |
 * | `progress` | `progress` 用，0…1 |
 * | `tEnter` / `tExit` | `entry` / `span` 用 |
 * | `kind` | 外部实体的类型 |
 * | `transform` | 可选，直接给 `{ position, rotation }` 覆盖位姿源 |
 * | 其余字段 | 原样进 `attrs`，能解析成数字就存数字 |
 *
 * 一条消息对应一个实体、一帧。OPC-UA 节点值若是 JSON 字符串，也同样走这里。
 */
export function toExternalFrame(payload: Record<string, unknown>, options: EntityStateMappingOptions = {}): ExternalFrame | undefined {
  const row = normalize(payload);
  const id = pick(row, options.idKeys ?? ID_KEYS);
  if (id === undefined || id === '') return undefined;

  const sourceTime = toNumber(pick(row, options.timeKeys ?? TIME_KEYS));
  const declared = pick(row, SIGNAL_KEYS);
  const signalKind: ExternalSignal['kind'] =
    declared === 'pose' || declared === 'progress' || declared === 'entry' || declared === 'span' ? declared : inferSignal(row);

  const signal = buildSignal(row, signalKind, options.defaultFrame ?? 'local');
  if (!signal) return undefined;

  const entityKind = pick(row, ['kind']);
  const attrs: Record<string, TwinValue> = {};
  for (const [key, value] of row) {
    if (RESERVED.has(key)) continue;
    const twin = toTwinValue(value);
    if (twin !== undefined) attrs[key] = twin;
  }

  const state: ExternalEntityState = {
    id,
    signal,
    ...(entityKind !== undefined && entityKind !== '' ? { kind: entityKind } : {}),
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
  };

  const transform = extractTransform(payload);
  if (transform) state.transform = transform;

  return { ...(sourceTime !== undefined ? { sourceTime } : {}), entities: [state] };
}

type NormalizedRow = Map<string, unknown>;

function normalize(payload: Record<string, unknown>): NormalizedRow {
  const row: NormalizedRow = new Map();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    row.set(key.toLowerCase(), value);
  }
  return row;
}

function pick(row: NormalizedRow, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row.get(key.toLowerCase());
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    if (value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toTwinValue(value: unknown): TwinValue | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return value;
  // 数字字符串也存成数字，保持与 CSV 解析一致
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (value.trim() !== '' && Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function inferSignal(row: NormalizedRow): ExternalSignal['kind'] {
  if (row.has('x') || row.has('y') || row.has('z')) return 'pose';
  if (row.has('progress')) return 'progress';
  if (row.has('texit')) return 'span';
  if (row.has('tenter')) return 'entry';
  return 'pose';
}

function buildSignal(row: NormalizedRow, kind: ExternalSignal['kind'], defaultFrame: 'world' | 'local'): ExternalSignal | undefined {
  switch (kind) {
    case 'pose': {
      const position: TwinVector3 = [
        toNumber(row.get('x')) ?? 0,
        toNumber(row.get('y')) ?? 0,
        toNumber(row.get('z')) ?? 0,
      ];
      const heading = row.has('heading') || row.has('yaw') ? toNumber(pick(row, ['heading', 'yaw'])) : undefined;
      const frameRaw = row.get('frame');
      const frame = frameRaw === 'world' || frameRaw === 'local' ? (frameRaw as 'world' | 'local') : defaultFrame;
      return { kind: 'pose', frame, position, ...(heading !== undefined ? { heading } : {}) };
    }
    case 'progress': {
      const progress = toNumber(row.get('progress'));
      if (progress === undefined) return undefined;
      return { kind: 'progress', progress };
    }
    case 'entry': {
      const tEnter = toNumber(row.get('tenter'));
      if (tEnter === undefined) return undefined;
      return { kind: 'entry', tEnter };
    }
    case 'span': {
      const tEnter = toNumber(row.get('tenter'));
      const tExit = toNumber(row.get('texit'));
      if (tEnter === undefined || tExit === undefined) return undefined;
      return { kind: 'span', tEnter, tExit };
    }
  }
}

function extractTransform(payload: Record<string, unknown>): TwinTransform | undefined {
  const transform = payload.transform;
  if (!transform || typeof transform !== 'object') return undefined;
  const record = transform as Record<string, unknown>;
  const position = record.position;
  if (!Array.isArray(position) || position.length !== 3 || position.some((part) => typeof part !== 'number')) return undefined;
  const result: TwinTransform = { position: [position[0] as number, position[1] as number, position[2] as number] };
  if (Array.isArray(record.rotation) && record.rotation.length === 3 && record.rotation.every((part) => typeof part === 'number')) {
    result.rotation = [record.rotation[0] as number, record.rotation[1] as number, record.rotation[2] as number];
  }
  return result;
}
