/**
 * 场景文档的进出：解析（校验 + 迁移）与序列化。
 *
 * 这一层存在的理由：**布局真相必须能离开代码**。
 * 只要场景只能由 `buildCenterScene()` 这类 TypeScript 函数算出来，改一根皮带就
 * 要改代码、跑测试、重新构建，"一天内建一条线"就不成立。有了这一层，场景就是
 * 一个可交换的文件：CAD / MES 台账 / 手绘草图重建出来的布局，只要能落成这份
 * JSON，就能直接进内核跑。
 *
 * 设计约束（与 `index.ts` 的三条硬规则一致）：
 * 1. 纯 TypeScript，不碰 `File` / `fetch` / DOM——浏览器侧的读文件、下载放在 UI 层；
 * 2. `parse` **永不抛异常**：坏输入一律转成 `issues` 返回，调用方决定怎么提示；
 * 3. 导出结果必须能被自己重新导入（往返幂等），否则导出的文件就是废纸。
 */

import {
  TWIN_SCENE_VERSION,
  migrateTwinScene,
  validateTwinScene,
  type SceneValidationIssue,
  type TwinScene,
  type TwinVector3,
} from './index';

/** 一条导入问题。`path` 沿用 JSON 路径写法（`$.entities[3].transform.position`）。 */
export interface SceneDocumentIssue {
  path: string;
  message: string;
}

/** 场景摘要：导入前给用户看一眼"我到底装了什么"，也是导出文件的自检依据。 */
export interface SceneSummary {
  /** 声明实体总数。 */
  entities: number;
  /** 按类型计数，多的排前面。 */
  kinds: { kind: string; count: number }[];
  /** 有运动路径的实体数（输送线、AGV、堆垛机…）。 */
  moving: number;
  /** 声明了外部数据绑定的实体数（真实工厂里通常只占一部分）。 */
  bound: number;
  /** 场景包围盒（米）。空场景为 undefined。 */
  bounds?: { min: TwinVector3; max: TwinVector3 };
}

export interface SceneImportResult {
  ok: boolean;
  /** 校验并（必要时）迁移后的场景。失败时为 undefined。 */
  scene?: TwinScene;
  /** 文件里写的版本号；老场景没有 `version` 字段时为 0。 */
  fromVersion: number;
  /** 按执行顺序记录的迁移说明，可直接展示给用户。 */
  applied: string[];
  /** 解析或校验问题。 */
  issues: SceneDocumentIssue[];
  /** 成功时的摘要。 */
  summary?: SceneSummary;
}

export interface SceneExportOptions {
  /** 缩进空格数，0 表示压缩成一行（默认 2，便于人工 diff）。 */
  indent?: number;
  /** 是否在末尾补换行（默认 true）。 */
  trailingNewline?: boolean;
}

/** 场景文件的建议扩展名。 */
export const SCENE_FILE_EXTENSION = '.twin.json';

/**
 * 场景文件的建议名：`{id}-v{version}.twin.json`。
 *
 * 只剔除文件系统不友好的字符，**保留中文**——车间名、产线名在国内项目里
 * 几乎都是中文，用 `\w` 过滤会把整个 id 吃光，导出成一个没有意义的名字。
 */
export function sceneFileName(scene: TwinScene): string {
  const slug = scene.id
    .replace(/[^\p{L}\p{N}_.-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || 'scene'}-v${scene.version}${SCENE_FILE_EXTENSION}`;
}

// -----------------------------------------------------------------------------
// 摘要
// -----------------------------------------------------------------------------

/**
 * 统计场景规模与构成。
 *
 * 包围盒只按**声明位置**算，不含运行时生成的实体（小货物、托盘）——
 * 那些不进场景文件，属于仿真产物。
 */
export function sceneSummary(scene: TwinScene): SceneSummary {
  const counts = new Map<string, number>();
  let moving = 0;
  let bound = 0;
  let hasBounds = false;
  const min: TwinVector3 = [Infinity, Infinity, Infinity];
  const max: TwinVector3 = [-Infinity, -Infinity, -Infinity];

  for (const entity of scene.entities) {
    counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
    if (entity.motion) moving += 1;
    if (entity.dataBindings && entity.dataBindings.length > 0) bound += 1;

    const position = entity.transform.position;
    if (position.every((part) => Number.isFinite(part))) {
      hasBounds = true;
      for (let axis = 0; axis < 3; axis += 1) {
        const value = position[axis]!;
        if (value < min[axis]!) min[axis] = value;
        if (value > max[axis]!) max[axis] = value;
      }
    }
  }

  const kinds = [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  return {
    entities: scene.entities.length,
    kinds,
    moving,
    bound,
    bounds: hasBounds ? { min, max } : undefined,
  };
}

// -----------------------------------------------------------------------------
// 导入
// -----------------------------------------------------------------------------

/**
 * 把一段文本解析成场景：JSON 解析 → 版本迁移 → 结构校验。
 *
 * 任何一步失败都不抛异常，而是把问题收进 `issues`——调用方（UI 或服务端接口）
 * 拿到的是可展示的列表，而不是一个需要 try/catch 的异常。
 */
export function parseSceneDocument(text: string): SceneImportResult {
  const empty: SceneImportResult = { ok: false, fromVersion: 0, applied: [], issues: [] };
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ...empty, issues: [{ path: '$', message: '内容为空。' }] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...empty, issues: [{ path: '$', message: `不是合法 JSON：${message}` }] };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...empty, issues: [{ path: '$', message: '场景必须是一个 JSON 对象。' }] };
  }

  const declared = (raw as { version?: unknown }).version;
  const fromVersion = typeof declared === 'number' && Number.isFinite(declared) ? declared : 0;

  // 版本高于内核支持的：直接拒绝，不猜。
  if (fromVersion > TWIN_SCENE_VERSION) {
    return {
      ...empty,
      fromVersion,
      issues: [
        {
          path: '$.version',
          message: `场景版本 ${fromVersion} 高于当前支持的 ${TWIN_SCENE_VERSION}，请升级内核或索取旧版导出。`,
        },
      ],
    };
  }

  // 先按"已声明版本"校验一遍，把结构问题一次性报全；
  // 老场景（无 version）跳过这一步，交给迁移补齐字段后再校验。
  if (fromVersion === TWIN_SCENE_VERSION) {
    const issues = validateTwinScene(raw).map(toDocumentIssue);
    if (issues.length > 0) return { ...empty, fromVersion, issues };
    const scene = raw as TwinScene;
    return { ok: true, scene, fromVersion, applied: [], issues: [], summary: sceneSummary(scene) };
  }

  try {
    const migrated = migrateTwinScene(raw);
    // 迁移内部已逐段校验；这里再兜一次，保证"迁移 + 校验"是原子动作。
    const issues = validateTwinScene(migrated.scene).map(toDocumentIssue);
    if (issues.length > 0) return { ...empty, fromVersion: migrated.fromVersion, applied: migrated.applied, issues };
    return {
      ok: true,
      scene: migrated.scene,
      fromVersion: migrated.fromVersion,
      applied: migrated.applied,
      issues: [],
      summary: sceneSummary(migrated.scene),
    };
  } catch (error) {
    if (isValidationError(error)) {
      return { ...empty, fromVersion, issues: error.issues.map(toDocumentIssue) };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ...empty, fromVersion, issues: [{ path: '$', message: `迁移失败：${message}` }] };
  }
}

/**
 * 只做校验，不做迁移：给"就要当前版本"的服务端接口用。
 * 与 `parseSceneDocument` 的区别是它不会悄悄改写文件。
 */
export function inspectSceneDocument(text: string): SceneImportResult {
  const parsed = parseSceneDocument(text);
  if (!parsed.ok || parsed.fromVersion === TWIN_SCENE_VERSION) return parsed;
  return {
    ...parsed,
    ok: false,
    scene: undefined,
    summary: undefined,
    issues: [{ path: '$.version', message: `需要版本 ${TWIN_SCENE_VERSION}，文件是版本 ${parsed.fromVersion}。` }],
  };
}

// -----------------------------------------------------------------------------
// 导出
// -----------------------------------------------------------------------------

/**
 * 序列化场景为 JSON 文本。
 *
 * `JSON.stringify` 会丢掉 `undefined` 字段，正好满足"不出现 undefined 语义"的
 * 硬规则；这里额外把 `version` 顶到前面，让导出的文件人眼可读、diff 友好。
 */
export function serializeSceneDocument(scene: TwinScene, options: SceneExportOptions = {}): string {
  const indent = options.indent ?? 2;
  const ordered: TwinScene = {
    version: TWIN_SCENE_VERSION,
    id: scene.id,
    name: scene.name,
    ...(scene.metadata ? { metadata: scene.metadata } : {}),
    entities: scene.entities,
  };
  const text = JSON.stringify(ordered, null, indent);
  return options.trailingNewline === false ? text : `${text}\n`;
}

/**
 * 导出前的自检：能不能被自己重新导入。
 *
 * 往返失败通常意味着场景里混进了函数、类实例或 `undefined`——这类脏数据
 * 在内存里跑得好好的，一落地就废，所以必须在导出时就拦下来。
 */
export function roundTripIssues(scene: TwinScene): SceneDocumentIssue[] {
  const text = serializeSceneDocument(scene);
  const parsed = parseSceneDocument(text);
  if (parsed.ok) return [];
  return parsed.issues.length > 0
    ? parsed.issues
    : [{ path: '$', message: '导出后无法被重新解析。' }];
}

// -----------------------------------------------------------------------------
// 内部
// -----------------------------------------------------------------------------

const toDocumentIssue = (issue: SceneValidationIssue): SceneDocumentIssue => ({
  path: issue.path,
  message: issue.message,
});

interface ValidationErrorLike {
  issues?: SceneValidationIssue[];
}

const isValidationError = (error: unknown): error is ValidationErrorLike =>
  typeof error === 'object' && error !== null && Array.isArray((error as ValidationErrorLike).issues);
