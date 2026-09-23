import type { WorldBehavior } from '@twin-platform/world-kernel';
import {
  PLUGIN_SDK_VERSION,
  assertManifest,
  satisfiesSdkVersion,
  type DecisionDomainDescriptor,
  type MetricDescriptor,
  type PanelDescriptor,
  type PluginInstance,
  type SceneTemplateDescriptor,
  type TwinPlugin,
  type TwinPluginManifest,
} from './manifest';
import { validateConfig, withDefaults, type ConfigValue } from './schema';

/**
 * 插件宿主（注册表 + 故障隔离）。
 *
 * 故障隔离是这个包存在的理由之一：一个插件在 `step` 里抛异常，
 * 后果只能是"这个插件被停用"，绝不能让整条产线的仿真停下来——
 * 真实工厂里设备掉线是常态，仿真比设备还脆就没法用了。
 */

export type PluginState = 'active' | 'failed' | 'disposed';
export type PluginErrorPhase = 'activate' | 'step' | 'dispose' | 'contribution';

export interface PluginError {
  pluginId: string;
  phase: PluginErrorPhase;
  message: string;
}

export interface PluginLogEntry {
  pluginId: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface PluginRecord {
  readonly manifest: TwinPluginManifest;
  readonly config: ConfigValue;
  readonly instance: PluginInstance | undefined;
  readonly state: PluginState;
  readonly error: PluginError | undefined;
}

export interface PluginHostOptions {
  /** 宿主实现的 SDK 版本；插件声明的范围不匹配时拒绝安装。 */
  sdkVersion?: string;
  onError?: (error: PluginError) => void;
  onLog?: (entry: PluginLogEntry) => void;
}

export class PluginConfigError extends Error {
  constructor(readonly pluginId: string, readonly issues: { path: string; message: string }[]) {
    super(`插件 ${pluginId} 的配置不合法：${issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}`);
    this.name = 'PluginConfigError';
  }
}

export class PluginIncompatibleError extends Error {
  constructor(readonly pluginId: string, readonly manifestSdk: string, readonly hostSdk: string) {
    super(`插件 ${pluginId} 需要 SDK ${manifestSdk}，宿主是 ${hostSdk}。`);
    this.name = 'PluginIncompatibleError';
  }
}

interface MutableRecord extends PluginRecord {
  instance: PluginInstance | undefined;
  state: PluginState;
  error: PluginError | undefined;
}

/** 把一个行为包成"抛错即自我停用"，宿主拿到的是这个包装体。 */
class SafeBehavior implements WorldBehavior {
  private disabled = false;

  constructor(
    readonly id: string,
    readonly pluginId: string,
    private readonly inner: WorldBehavior,
    private readonly onFailure: (error: PluginError) => void,
  ) {}

  get failed(): boolean {
    return this.disabled;
  }

  step(ctx: Parameters<WorldBehavior['step']>[0]): void {
    if (this.disabled) return;
    try {
      this.inner.step(ctx);
    } catch (error) {
      // 只停这一个行为，其余行为和内核继续跑。
      this.disabled = true;
      this.onFailure({ pluginId: this.pluginId, phase: 'step', message: `行为 ${this.id} 出错已停用：${messageOf(error)}` });
    }
  }
}

export class PluginHost {
  private readonly sdkVersion: string;
  private readonly onError: ((error: PluginError) => void) | undefined;
  private readonly onLog: ((entry: PluginLogEntry) => void) | undefined;
  private readonly records = new Map<string, MutableRecord>();
  private readonly order: string[] = [];
  private readonly behaviorList: SafeBehavior[] = [];
  readonly errors: PluginError[] = [];
  readonly logs: PluginLogEntry[] = [];

  constructor(options: PluginHostOptions = {}) {
    this.sdkVersion = options.sdkVersion ?? PLUGIN_SDK_VERSION;
    this.onError = options.onError;
    this.onLog = options.onLog;
  }

  /**
   * 安装插件。
   *
   * 安装顺序即行为执行顺序（内核里"顺序即契约"），所以 `behaviors` 的
   * 返回顺序必须稳定：先装的先跑。
   */
  install(plugin: TwinPlugin, config?: ConfigValue): PluginRecord {
    const manifest = assertManifest(plugin.manifest);
    if (this.records.has(manifest.id)) throw new Error(`插件 ${manifest.id} 已安装。`);
    if (!satisfiesSdkVersion(manifest.sdkVersion, this.sdkVersion)) {
      throw new PluginIncompatibleError(manifest.id, manifest.sdkVersion, this.sdkVersion);
    }

    const merged = withDefaults(manifest.configSchema ?? { type: 'object', properties: {} }, manifest.defaultConfig, config);
    if (manifest.configSchema) {
      const issues = validateConfig(manifest.configSchema, merged);
      if (issues.length > 0) throw new PluginConfigError(manifest.id, issues);
    }

    const record: MutableRecord = { manifest, config: merged, instance: undefined, state: 'active', error: undefined };
    this.records.set(manifest.id, record);
    this.order.push(manifest.id);

    const ctx = {
      manifest,
      config: merged,
      sdkVersion: this.sdkVersion,
      log: (message: string, level: 'info' | 'warn' | 'error' = 'info') => this.writeLog(manifest.id, level, message),
    };

    try {
      const instance = plugin.activate(ctx);
      record.instance = filterContributions(manifest, instance, (message) => this.writeLog(manifest.id, 'warn', message));
      this.registerBehaviors(manifest.id, record.instance);
    } catch (error) {
      record.state = 'failed';
      record.error = { pluginId: manifest.id, phase: 'activate', message: messageOf(error) };
      this.recordError(record.error);
    }

    return record;
  }

  /** 卸载并按注册逆序 dispose——后装的往往依赖先装的。 */
  uninstall(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.instance?.dispose) {
      try {
        record.instance.dispose();
      } catch (error) {
        const failure: PluginError = { pluginId: id, phase: 'dispose', message: messageOf(error) };
        record.error = failure;
        this.recordError(failure);
      }
    }
    this.records.delete(id);
    this.order.splice(this.order.indexOf(id), 1);
    for (let i = this.behaviorList.length - 1; i >= 0; i -= 1) {
      if (this.behaviorList[i]?.pluginId === id) this.behaviorList.splice(i, 1);
    }
    record.state = 'disposed';
    return true;
  }

  get(id: string): PluginRecord | undefined {
    return this.records.get(id);
  }

  list(): PluginRecord[] {
    return this.order.map((id) => this.records.get(id)).filter((record): record is MutableRecord => record !== undefined);
  }

  listByCapability(capability: string): PluginRecord[] {
    return this.list().filter((record) => record.manifest.capabilities.includes(capability as never));
  }

  /** 交给内核的行为：已包装故障隔离，且跳过激活失败的插件。 */
  get behaviors(): readonly WorldBehavior[] {
    return this.behaviorList.filter((behavior) => !behavior.failed);
  }

  /** 已被停用的行为（抛过异常），Studio 用来标红。 */
  get failedBehaviors(): readonly string[] {
    return this.behaviorList.filter((behavior) => behavior.failed).map((behavior) => behavior.id);
  }

  get metrics(): MetricDescriptor[] {
    return this.collect('metrics');
  }

  get panels(): PanelDescriptor[] {
    return this.collect('panels');
  }

  get decisions(): DecisionDomainDescriptor[] {
    return this.collect('decisions');
  }

  get templates(): SceneTemplateDescriptor[] {
    return this.collect('templates');
  }

  template(id: string): SceneTemplateDescriptor | undefined {
    return this.templates.find((item) => item.id === id);
  }

  dispose(): void {
    for (const id of [...this.order].reverse()) this.uninstall(id);
  }

  private collect<K extends 'metrics' | 'decisions' | 'panels' | 'templates'>(key: K): NonNullable<PluginInstance[K]> extends readonly (infer T)[] ? T[] : never {
    const out: unknown[] = [];
    for (const id of this.order) {
      const record = this.records.get(id);
      if (!record?.instance) continue;
      const values = record.instance[key];
      if (values) out.push(...values);
    }
    return out as never;
  }

  private registerBehaviors(pluginId: string, instance: PluginInstance): void {
    for (const behavior of instance.behaviors ?? []) {
      this.behaviorList.push(new SafeBehavior(behavior.id, pluginId, behavior, (error) => this.recordError(error)));
    }
  }

  private recordError(error: PluginError): void {
    this.errors.push(error);
    this.onError?.(error);
  }

  private writeLog(pluginId: string, level: PluginLogEntry['level'], message: string): void {
    const entry: PluginLogEntry = { pluginId, level, message };
    this.logs.push(entry);
    this.onLog?.(entry);
  }
}

/**
 * 只放行 manifest 声明过的能力。
 *
 * 不是不信任插件，而是防止"改了 manifest 忘了改实现"这类漂移——
 * 声明即契约，宿主按声明决定加载什么。
 */
function filterContributions(
  manifest: TwinPluginManifest,
  instance: PluginInstance,
  warn: (message: string) => void,
): PluginInstance {
  const allowed = new Set(manifest.capabilities);
  const result: PluginInstance = { ...instance };
  if (!allowed.has('behavior') && instance.behaviors?.length) {
    warn('未声明 behavior 能力，已忽略行为贡献。');
    result.behaviors = undefined;
  }
  if (!allowed.has('analytics') && instance.metrics?.length) {
    warn('未声明 analytics 能力，已忽略指标贡献。');
    result.metrics = undefined;
  }
  if (!allowed.has('decision') && instance.decisions?.length) {
    warn('未声明 decision 能力，已忽略决策域贡献。');
    result.decisions = undefined;
  }
  if (!allowed.has('panel') && instance.panels?.length) {
    warn('未声明 panel 能力，已忽略面板贡献。');
    result.panels = undefined;
  }
  if (!allowed.has('scene-template') && instance.templates?.length) {
    warn('未声明 scene-template 能力，已忽略模板贡献。');
    result.templates = undefined;
  }
  return result;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
