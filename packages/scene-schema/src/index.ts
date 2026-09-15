/**
 * 版本化场景契约。
 *
 * 这里的类型就是数据库里 `scene_versions` 存的 JSON 形状，也是插件与内核之间
 * 唯一被允许互相传递的场景数据结构。纯 TypeScript，不依赖任何 UI、Three 或数据库。
 *
 * 三条硬规则：
 * 1. 场景必须能 `JSON.stringify` 往返，不出现函数、类实例或 `undefined` 语义；
 * 2. 每次结构变更都必须抬高 `TWIN_SCENE_VERSION` 并补一条 `SceneMigration`；
 * 3. 内核只读取字段，不猜测字段——缺字段就走迁移或校验失败。
 */

export const TWIN_SCENE_VERSION = 1 as const;

export type TwinSceneVersion = typeof TWIN_SCENE_VERSION;

/** 事件与属性允许携带的值，限制为基元以保证可结构化克隆、可入 jsonb、可跨 Worker 传输。 */
export type TwinValue = string | number | boolean;

export type TwinVector3 = [number, number, number];

export interface TwinTransform {
  position: TwinVector3;
  rotation?: TwinVector3;
  scale?: TwinVector3;
}

/** 渲染外观声明。内核完全不解释它，只有 renderer 插件读取。 */
export interface TwinVisualBinding {
  /** 渲染插件约定的外观类型，例如 `box` / `gltf` / `instanced`。 */
  kind?: string;
  /** 资产库中的资源 id。 */
  asset?: string;
  color?: string;
  size?: TwinVector3;
}

/**
 * 运动路径声明：实体沿折线以 `speed` m/s 前进。
 *
 * 这是"设备提供运动路径"这一概念在通用层的表达——输送线、AGV、堆垛机都只是
 * 不同的渲染与行为插件，路径推进本身由内核按弧长完成。
 */
export interface TwinMotionBinding {
  points: TwinVector3[];
  /** 米/秒。 */
  speed: number;
  /** 折角圆角半径，0 表示保持尖角。 */
  cornerRadius?: number;
  /** 每个圆角的密化段数。 */
  arcSegments?: number;
  /** 到达终点后的行为：`clamp` 停在终点，`repeat` 回到起点（默认 clamp）。 */
  loop?: 'clamp' | 'repeat';
}

/**
 * 外部数据绑定。对应 r3f-tools 的 `ExternalContract`：真实工厂几乎不可能每台设备
 * 都有数据，所以每个实体单独声明"外部能给我什么"。
 *
 * - `pose`     上位机直接给位姿（world 或设备本地坐标）；
 * - `progress` 给 0…1 的进度，内核乘路径长度换算弧长；
 * - `entry`    只给进入时刻，内核用自己的速度×dt 推进；
 * - `span`     给进入/离开时刻，内核在区间内线性插值。
 *
 * `progress` / `entry` / `span` 要求实体同时声明 `motion`，否则无法换算位姿。
 */
export interface TwinDataBinding {
  /** 数据源 id（CSV 列组、MQTT 主题、MES 接口）。 */
  source: string;
  /** 外部标识：PLC tag、CSV 主键、MQTT key。 */
  key?: string;
  signal?: 'pose' | 'progress' | 'entry' | 'span';
  /** 仅 `pose` 使用；默认 `local`（设备本地坐标 + 实体 transform 换算到世界）。 */
  frame?: 'world' | 'local';
}

export interface TwinEntity {
  id: string;
  kind: string;
  transform: TwinTransform;
  capabilities: string[];
  visual?: TwinVisualBinding;
  motion?: TwinMotionBinding;
  dataBindings?: TwinDataBinding[];
  /** 随实体携带的过程属性（质检结论、批次…），路由与分析都读它。 */
  attrs?: Record<string, TwinValue>;
  config?: Record<string, unknown>;
}

export interface TwinScene {
  version: TwinSceneVersion;
  id: string;
  name: string;
  metadata?: Record<string, TwinValue>;
  entities: TwinEntity[];
}

export interface SceneValidationIssue {
  path: string;
  message: string;
}

// -----------------------------------------------------------------------------
// 校验
// -----------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isVector3 = (value: unknown): value is TwinVector3 =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((part) => typeof part === 'number' && Number.isFinite(part));

const isTwinValue = (value: unknown): value is TwinValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const isValueRecord = (value: unknown): value is Record<string, TwinValue> =>
  isRecord(value) && Object.values(value).every(isTwinValue);

const isVector3List = (value: unknown): value is TwinVector3[] =>
  Array.isArray(value) && value.length >= 2 && value.every(isVector3);

const isSignal = (value: unknown): value is NonNullable<TwinDataBinding['signal']> =>
  value === 'pose' || value === 'progress' || value === 'entry' || value === 'span';

export function validateTwinScene(input: unknown): SceneValidationIssue[] {
  if (!isRecord(input)) return [{ path: '$', message: '场景必须是对象。' }];
  const issues: SceneValidationIssue[] = [];
  if (input.version !== TWIN_SCENE_VERSION) issues.push({ path: '$.version', message: `必须是版本 ${TWIN_SCENE_VERSION}。` });
  if (typeof input.id !== 'string' || input.id.length === 0) issues.push({ path: '$.id', message: '必须是非空字符串。' });
  if (typeof input.name !== 'string' || input.name.length === 0) issues.push({ path: '$.name', message: '必须是非空字符串。' });
  if (input.metadata !== undefined && !isValueRecord(input.metadata)) issues.push({ path: '$.metadata', message: '必须是基元值对象。' });
  if (!Array.isArray(input.entities)) return [...issues, { path: '$.entities', message: '必须是实体数组。' }];

  const ids = new Set<string>();
  input.entities.forEach((entity, index) => {
    const path = `$.entities[${index}]`;
    if (!isRecord(entity)) {
      issues.push({ path, message: '必须是对象。' });
      return;
    }
    if (typeof entity.id !== 'string' || entity.id.length === 0) issues.push({ path: `${path}.id`, message: '必须是非空字符串。' });
    else if (ids.has(entity.id)) issues.push({ path: `${path}.id`, message: '实体 id 必须唯一。' });
    else ids.add(entity.id);

    if (typeof entity.kind !== 'string' || entity.kind.length === 0) issues.push({ path: `${path}.kind`, message: '必须是非空字符串。' });

    if (!isRecord(entity.transform) || !isVector3(entity.transform.position))
      issues.push({ path: `${path}.transform.position`, message: '必须是三个有限数字。' });
    else {
      if (entity.transform.rotation !== undefined && !isVector3(entity.transform.rotation))
        issues.push({ path: `${path}.transform.rotation`, message: '必须是三个有限数字。' });
      if (entity.transform.scale !== undefined && !isVector3(entity.transform.scale))
        issues.push({ path: `${path}.transform.scale`, message: '必须是三个有限数字。' });
    }

    if (!Array.isArray(entity.capabilities) || entity.capabilities.some((item) => typeof item !== 'string'))
      issues.push({ path: `${path}.capabilities`, message: '必须是字符串数组。' });
    if (entity.attrs !== undefined && !isValueRecord(entity.attrs))
      issues.push({ path: `${path}.attrs`, message: '必须是基元值对象。' });

    if (entity.motion !== undefined) {
      if (!isRecord(entity.motion)) issues.push({ path: `${path}.motion`, message: '必须是对象。' });
      else {
        if (!isVector3List(entity.motion.points)) issues.push({ path: `${path}.motion.points`, message: '至少两个 [x,y,z] 点。' });
        if (typeof entity.motion.speed !== 'number' || !Number.isFinite(entity.motion.speed) || entity.motion.speed < 0)
          issues.push({ path: `${path}.motion.speed`, message: '必须是非负有限数字。' });
        if (entity.motion.loop !== undefined && entity.motion.loop !== 'clamp' && entity.motion.loop !== 'repeat')
          issues.push({ path: `${path}.motion.loop`, message: '必须是 "clamp" 或 "repeat"。' });
      }
    }

    if (entity.dataBindings !== undefined) {
      if (!Array.isArray(entity.dataBindings)) issues.push({ path: `${path}.dataBindings`, message: '必须是数组。' });
      else
        entity.dataBindings.forEach((binding, bindingIndex) => {
          const bindingPath = `${path}.dataBindings[${bindingIndex}]`;
          if (!isRecord(binding)) {
            issues.push({ path: bindingPath, message: '必须是对象。' });
            return;
          }
          if (typeof binding.source !== 'string' || binding.source.length === 0)
            issues.push({ path: `${bindingPath}.source`, message: '必须是非空字符串。' });
          if (binding.signal !== undefined && !isSignal(binding.signal))
            issues.push({ path: `${bindingPath}.signal`, message: '必须是 pose / progress / entry / span。' });
          if (binding.frame !== undefined && binding.frame !== 'world' && binding.frame !== 'local')
            issues.push({ path: `${bindingPath}.frame`, message: '必须是 "world" 或 "local"。' });
        });
    }
  });
  return issues;
}

export function isTwinScene(input: unknown): input is TwinScene {
  return validateTwinScene(input).length === 0;
}

export class SceneValidationError extends Error {
  readonly issues: SceneValidationIssue[];

  constructor(issues: SceneValidationIssue[]) {
    super(`场景校验失败：${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
    this.name = 'SceneValidationError';
    this.issues = issues;
  }
}

/** 校验通过则返回场景，否则抛出带全部问题的错误。 */
export function assertTwinScene(input: unknown): TwinScene {
  const issues = validateTwinScene(input);
  if (issues.length > 0) throw new SceneValidationError(issues);
  return input as TwinScene;
}

// -----------------------------------------------------------------------------
// 版本迁移
// -----------------------------------------------------------------------------

/**
 * 一条迁移只负责把 `from` 抬到 `to`。迁移函数拿到的是"任意 JSON"，
 * 因此必须自己容错：旧场景来自文件、数据库或第三方工具，不能假设字段齐全。
 */
export interface SceneMigration {
  from: number;
  to: number;
  description: string;
  migrate(scene: Record<string, unknown>): Record<string, unknown>;
}

interface LegacyPoint {
  x?: unknown;
  y?: unknown;
  z?: unknown;
}

const toTuple = (point: unknown): TwinVector3 => {
  if (isVector3(point)) return [point[0], point[1], point[2]];
  const legacy = isRecord(point) ? (point as LegacyPoint) : undefined;
  return [
    typeof legacy?.x === 'number' ? legacy.x : 0,
    typeof legacy?.y === 'number' ? legacy.y : 0,
    typeof legacy?.z === 'number' ? legacy.z : 0,
  ];
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * v0 → v1：早期原型场景（含从 r3f-tools 设备图导出的布局）没有 `version`
 * 字段，实体用 `type` 表示类型、位置写成 `{x,y,z}`，并且缺少 `capabilities`。
 */
const migrateV0ToV1: SceneMigration = {
  from: 0,
  to: 1,
  description: '补齐 version/capabilities，type→kind，{x,y,z} 位置改为元组',
  migrate(scene) {
    const entities = asArray(scene.entities).map((raw) => {
      const entity = isRecord(raw) ? raw : {};
      const rawId: unknown = entity.id;
      const legacyType = typeof entity.type === 'string' ? entity.type : undefined;
      const transform = isRecord(entity.transform) ? entity.transform : {};
      return {
        ...entity,
        id: typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : '',
        kind: typeof entity.kind === 'string' ? entity.kind : (legacyType ?? 'unknown'),
        transform: {
          ...transform,
          position: toTuple(transform.position ?? entity.position),
        },
        capabilities: Array.isArray(entity.capabilities) ? entity.capabilities : [],
      };
    });
    return {
      ...scene,
      version: 1,
      id: typeof scene.id === 'string' ? scene.id : (typeof scene.name === 'string' ? scene.name : 'migrated-scene'),
      name: typeof scene.name === 'string' ? scene.name : '迁移场景',
      entities,
    };
  },
};

export const SCENE_MIGRATIONS: readonly SceneMigration[] = [migrateV0ToV1];

export interface SceneMigrationResult {
  scene: TwinScene;
  fromVersion: number;
  /** 按执行顺序记录的迁移说明，可写入 `scene_versions` 的迁移备注。 */
  applied: string[];
}

/**
 * 把任意历史版本场景抬到当前版本。
 *
 * 顺序执行迁移链，每步之后再校验一次，保证"迁移 + 校验"是一个原子动作：
 * 迁移出来的东西如果校验不过，就是迁移写错了，必须在这里暴露而不是在内核里崩。
 */
export function migrateTwinScene(input: unknown): SceneMigrationResult {
  if (!isRecord(input)) throw new SceneValidationError([{ path: '$', message: '场景必须是对象。' }]);
  const fromVersion = typeof input.version === 'number' ? input.version : 0;
  if (fromVersion > TWIN_SCENE_VERSION)
    throw new SceneValidationError([
      { path: '$.version', message: `场景版本 ${fromVersion} 高于当前内核支持的最高版本 ${TWIN_SCENE_VERSION}。` },
    ]);

  let current: Record<string, unknown> = { ...input };
  let version = fromVersion;
  const applied: string[] = [];

  while (version < TWIN_SCENE_VERSION) {
    const migration = SCENE_MIGRATIONS.find((item) => item.from === version);
    if (!migration) throw new SceneValidationError([{ path: '$.version', message: `没有从版本 ${version} 出发的迁移。` }]);
    const next = migration.migrate(current);
    const issues = validateTwinScene({ ...next, version: migration.to });
    if (issues.length > 0) throw new SceneValidationError(issues);
    current = next;
    version = migration.to;
    applied.push(`${migration.from}→${migration.to}: ${migration.description}`);
  }

  return { scene: assertTwinScene(current), fromVersion, applied };
}

// -----------------------------------------------------------------------------
// 文档进出（解析 / 序列化）
// -----------------------------------------------------------------------------

/**
 * 场景文件的读写出口，见 `./io`。
 *
 * 从主入口一并导出，而不是走 `@twin-platform/scene-schema/io` 子路径——
 * 仓库各包在本机（含 WSL/9P 挂载）下的软链接解析对子路径导出支持不稳，
 * 统一走主入口最省心。这里只是 re-export，没有循环依赖风险：
 * `io.ts` 顶层不引用本模块的任何绑定，只在函数体内调用。
 */
export type { SceneDocumentIssue, SceneExportOptions, SceneImportResult, SceneSummary } from './io';
export {
  SCENE_FILE_EXTENSION,
  inspectSceneDocument,
  parseSceneDocument,
  roundTripIssues,
  sceneFileName,
  sceneSummary,
  serializeSceneDocument,
} from './io';
