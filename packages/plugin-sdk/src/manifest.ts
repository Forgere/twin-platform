import type { TwinEntity, TwinValue } from '@twin-platform/scene-schema';
import type { WorldBehavior } from '@twin-platform/world-kernel';
import type { ConfigValue, ValueSchema } from './schema';

/**
 * 插件契约。
 *
 * 一期只加载随项目构建的本地插件，不执行任意远程 JavaScript——所以这里
 * 没有"从 URL 下载代码"的入口，manifest 只描述能力，不描述代码位置。
 *
 * 三条边界：
 * 1. 插件**只贡献**东西（行为、指标、面板、场景模板），不直接改内核内部状态；
 * 2. 插件行为必须确定性：随机只能从 `ctx.rng` 取，时间只能用 `ctx.time`；
 * 3. 插件崩溃只停用它自己，宿主必须继续跑（见 `registry.ts` 的 `SafeBehavior`）。
 */

/** 当前 SDK 版本。宿主与插件的 `sdkVersion` 不匹配时拒绝安装。 */
export const PLUGIN_SDK_VERSION = '0.1.0';

/** 插件能贡献的能力类型。manifest 声明什么，宿主才允许它注册什么。 */
export type PluginCapability = 'behavior' | 'analytics' | 'data-source' | 'panel' | 'scene-template';

export interface TwinPluginManifest {
  /** 反向域名式 id，例如 `logistics`、`inspection.vision`。全仓库唯一。 */
  id: string;
  /** 插件版本（semver）。进 `plugin_installations` 时被锁定。 */
  version: string;
  /** 兼容的 SDK 版本范围，例如 `^0.1.0`。 */
  sdkVersion: string;
  name?: string;
  description?: string;
  capabilities: readonly PluginCapability[];
  configSchema?: ValueSchema;
  defaultConfig?: ConfigValue;
}

/** 指标描述符：插件只声明"有这个指标、它吃哪些事件"，计算在 `analytics-core`。 */
export interface MetricDescriptor {
  id: string;
  label: string;
  unit?: string;
  /** 该指标订阅的事件类型；没出现的事件不参与计算。 */
  eventTypes: readonly string[];
  aggregation: 'count' | 'sum' | 'duration' | 'last';
  /** `sum` / `last` 读取的 payload 字段名。 */
  valueKey?: string;
  /** 是否按实体分组统计（设备级利用率需要）。 */
  groupByEntity?: boolean;
}

/** 面板描述符：`component` 是宿主路由表里的键，一期由 Studio 自己映射。 */
export interface PanelDescriptor {
  id: string;
  title: string;
  component: string;
  /** 只有场景具备这些能力时才显示该面板。 */
  requiresCapabilities?: readonly string[];
}

/** 场景模板：把"一段输送线"这类可复用片段参数化成实体列表。 */
export interface SceneTemplateDescriptor<P = ConfigValue> {
  id: string;
  label: string;
  build(params: P): TwinEntity[];
}

export interface PluginInstance {
  behaviors?: readonly WorldBehavior[];
  metrics?: readonly MetricDescriptor[];
  panels?: readonly PanelDescriptor[];
  templates?: readonly SceneTemplateDescriptor[];
  dispose?(): void;
}

export interface PluginContext<C = ConfigValue> {
  readonly manifest: TwinPluginManifest;
  /** 已合并缺省值并校验过的配置副本，插件可安全改写。 */
  readonly config: C;
  readonly sdkVersion: string;
  log(message: string, level?: 'info' | 'warn' | 'error'): void;
}

export interface TwinPlugin<C = ConfigValue> {
  readonly manifest: TwinPluginManifest;
  /**
   * 激活插件。必须是同步的：异步激活会让"场景 + 插件锁 + seed"这一组
   * 回放输入变得不可复现，回放就废了。
   */
  activate(ctx: PluginContext<C>): PluginInstance;
}

// ---------------------------------------------------------------------------
// 版本
// ---------------------------------------------------------------------------

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function parseVersion(version: string): ParsedVersion | undefined {
  const match = VERSION_RE.exec(version.trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * SDK 版本范围匹配。一期只支持三种写法：`*`（任意）、`^x.y.z`（主版本相同且不低于）、
 * `x.y.z`（完全相等）。够用了，多的语义只会带来"到底装不装"的分歧。
 */
export function satisfiesSdkVersion(range: string, version: string): boolean {
  const trimmed = range.trim();
  if (trimmed === '*') return true;
  const target = parseVersion(version);
  if (!target) return false;

  if (trimmed.startsWith('^')) {
    const base = parseVersion(trimmed.slice(1));
    if (!base) return false;
    return base.major === target.major && compareVersions(target, base) >= 0;
  }
  if (trimmed.startsWith('~')) {
    const base = parseVersion(trimmed.slice(1));
    if (!base) return false;
    return base.major === target.major && base.minor === target.minor && compareVersions(target, base) >= 0;
  }
  const exact = parseVersion(trimmed);
  return exact !== undefined && compareVersions(exact, target) === 0;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const VALID_CAPABILITIES: readonly PluginCapability[] = ['behavior', 'analytics', 'data-source', 'panel', 'scene-template'];

export interface ManifestIssue {
  path: string;
  message: string;
}

export class PluginManifestError extends Error {
  readonly issues: ManifestIssue[];

  constructor(issues: ManifestIssue[]) {
    super(`插件 manifest 不合法：${issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}`);
    this.name = 'PluginManifestError';
    this.issues = issues;
  }
}

export function validateManifest(input: unknown): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return [{ path: 'manifest', message: '必须是对象。' }];
  }
  const manifest = input as Partial<TwinPluginManifest>;

  if (typeof manifest.id !== 'string' || !PLUGIN_ID_RE.test(manifest.id)) {
    issues.push({ path: 'id', message: '必须是小写字母开头的点分 id，例如 `logistics`。' });
  }
  if (typeof manifest.version !== 'string' || !parseVersion(manifest.version)) {
    issues.push({ path: 'version', message: '必须是 semver，例如 `0.1.0`。' });
  }
  if (typeof manifest.sdkVersion !== 'string' || manifest.sdkVersion.trim() === '') {
    issues.push({ path: 'sdkVersion', message: '必须声明兼容的 SDK 版本范围。' });
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    issues.push({ path: 'capabilities', message: '至少要声明一项能力。' });
  } else {
    for (const capability of manifest.capabilities) {
      if (!VALID_CAPABILITIES.includes(capability as PluginCapability)) {
        issues.push({ path: 'capabilities', message: `未知能力 "${String(capability)}"。` });
      }
    }
  }
  return issues;
}

export function assertManifest(input: unknown): TwinPluginManifest {
  const issues = validateManifest(input);
  if (issues.length > 0) throw new PluginManifestError(issues);
  return input as TwinPluginManifest;
}

/** TwinValue 是插件配置里"标量"的公共子集，配置校验前先缩小范围。 */
export type PluginScalar = TwinValue;
