import { describe, expect, test } from 'bun:test';
import { createRng, type BehaviorContext, type WorldBehavior } from '@twin-platform/world-kernel';
import {
  PluginConfigError,
  PluginHost,
  PluginIncompatibleError,
  PluginManifestError,
  assertManifest,
  isValidConfig,
  parseVersion,
  satisfiesSdkVersion,
  validateConfig,
  validateManifest,
  withDefaults,
  type TwinPlugin,
  type TwinPluginManifest,
  type ValueSchema,
} from './index';

const manifest = (overrides: Partial<TwinPluginManifest> = {}): TwinPluginManifest => ({
  id: 'demo',
  version: '0.1.0',
  sdkVersion: '^0.1.0',
  capabilities: ['behavior'],
  ...overrides,
});

function makeCtx(): BehaviorContext {
  const rng = createRng(1);
  return {
    dt: 1 / 60,
    time: 0,
    rng,
    entities: [],
    entity: () => undefined,
    setAttr: () => {},
    setStatus: () => {},
    setTransform: () => {},
    move: () => false,
    emit: (type) => ({ sequence: 1, type, occurredAt: 0 }),
  };
}

const countingBehavior = (id: string, counter: { steps: number }): WorldBehavior => ({
  id,
  step: () => {
    counter.steps += 1;
  },
});

describe('manifest 校验', () => {
  test('合法 manifest 通过，非法项逐条报出路径', () => {
    expect(validateManifest(manifest())).toEqual([]);
    const issues = validateManifest({ id: 'Bad Id', version: 'v1', sdkVersion: '', capabilities: ['teleport'] });
    expect(issues.map((issue) => issue.path)).toEqual(['id', 'version', 'sdkVersion', 'capabilities']);
  });

  test('assertManifest 抛错时带上全部问题', () => {
    try {
      assertManifest({ id: 'x', version: '0.1.0', sdkVersion: '*', capabilities: [] });
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginManifestError);
      expect((error as PluginManifestError).issues[0]?.path).toBe('capabilities');
    }
  });
});

describe('SDK 版本匹配', () => {
  test('^ 要求主版本一致且不更低', () => {
    expect(satisfiesSdkVersion('^0.1.0', '0.1.0')).toBe(true);
    expect(satisfiesSdkVersion('^0.1.0', '0.2.3')).toBe(true);
    expect(satisfiesSdkVersion('^0.1.0', '1.0.0')).toBe(false);
    expect(satisfiesSdkVersion('^1.2.0', '1.1.9')).toBe(false);
  });

  test('~ 锁到次版本，精确匹配与 * 也支持', () => {
    expect(satisfiesSdkVersion('~0.1.0', '0.1.7')).toBe(true);
    expect(satisfiesSdkVersion('~0.1.0', '0.2.0')).toBe(false);
    expect(satisfiesSdkVersion('0.1.0', '0.1.0')).toBe(true);
    expect(satisfiesSdkVersion('*', '9.9.9')).toBe(true);
    expect(parseVersion('1.2.3-beta')).toEqual({ major: 1, minor: 2, patch: 3 });
  });
});

describe('配置 Schema', () => {
  const schema: ValueSchema = {
    type: 'object',
    properties: {
      speed: { type: 'number', minimum: 0, maximum: 10 },
      mode: { type: 'string', enum: ['fast', 'slow'] },
      nested: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] },
    },
    required: ['speed'],
    additionalProperties: false,
  };

  test('类型、范围、枚举、必填与未知字段都能报出路径', () => {
    expect(isValidConfig(schema, { speed: 1, mode: 'fast', nested: { enabled: true } })).toBe(true);
    const issues = validateConfig(schema, { speed: 42, mode: 'turbo', extra: 1 });
    expect(issues.map((issue) => issue.path)).toEqual(['config.speed', 'config.mode', 'config.extra']);
    // 嵌套对象给了但缺必填字段，路径要指到最里面那一层
    expect(validateConfig(schema, { speed: 1, nested: {} }).map((issue) => issue.path)).toEqual(['config.nested.enabled']);
  });

  test('withDefaults 深拷贝缺省值，插件改配置不会污染 manifest', () => {
    const defaults = { speed: 2, nested: { enabled: false } };
    const merged = withDefaults(schema, defaults, { speed: 5 });
    expect(merged).toEqual({ speed: 5, nested: { enabled: false } });
    expect(defaults.speed).toBe(2);
  });
});

describe('PluginHost', () => {
  test('安装后行为按安装顺序暴露', () => {
    const host = new PluginHost();
    const a = { steps: 0 };
    const b = { steps: 0 };
    host.install({ manifest: manifest({ id: 'p1' }), activate: () => ({ behaviors: [countingBehavior('b1', a)] }) });
    host.install({ manifest: manifest({ id: 'p2' }), activate: () => ({ behaviors: [countingBehavior('b2', b)] }) });

    expect(host.behaviors.map((behavior) => behavior.id)).toEqual(['b1', 'b2']);
    for (const behavior of host.behaviors) behavior.step(makeCtx());
    expect([a.steps, b.steps]).toEqual([1, 1]);
  });

  test('行为抛错只停用自己，其余行为与宿主继续跑', () => {
    const host = new PluginHost();
    const healthy = { steps: 0 };
    host.install({
      manifest: manifest({ id: 'broken' }),
      activate: () => ({
        behaviors: [
          { id: 'explode', step: () => { throw new Error('设备掉线'); } },
        ],
      }),
    });
    host.install({ manifest: manifest({ id: 'healthy' }), activate: () => ({ behaviors: [countingBehavior('ok', healthy)] }) });

    const ctx = makeCtx();
    for (const behavior of host.behaviors) behavior.step(ctx); // 第一个在这里炸并被摘掉
    expect(host.failedBehaviors).toEqual(['explode']);
    expect(host.errors[0]?.phase).toBe('step');

    for (const behavior of host.behaviors) behavior.step(ctx);
    for (const behavior of host.behaviors) behavior.step(ctx);
    expect(healthy.steps).toBe(3);
    expect(host.get('broken')?.state).toBe('active'); // 插件本身没被摘，只是它的行为停了
  });

  test('activate 抛错时插件标记为 failed，不影响后续安装', () => {
    const host = new PluginHost();
    const record = host.install({ manifest: manifest({ id: 'bad' }), activate: () => { throw new Error('初始化失败'); } });
    expect(record.state).toBe('failed');
    expect(host.behaviors).toEqual([]);
    expect(host.install({ manifest: manifest({ id: 'good' }), activate: () => ({}) }).state).toBe('active');
  });

  test('重复安装、SDK 不兼容、配置非法都直接拒绝', () => {
    const host = new PluginHost();
    const plugin: TwinPlugin = { manifest: manifest(), activate: () => ({}) };
    host.install(plugin);
    expect(() => host.install(plugin)).toThrow(/已安装/);
    expect(() => host.install({ manifest: manifest({ id: 'future', sdkVersion: '^9.0.0' }), activate: () => ({}) })).toThrow(PluginIncompatibleError);

    try {
      host.install({ manifest: manifest({ id: 'cfg', configSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } }), activate: () => ({}) }, {});
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginConfigError);
      expect((error as PluginConfigError).issues[0]?.path).toBe('config.n');
    }
    expect(host.get('cfg')).toBeUndefined(); // 装一半的插件不留在注册表里
  });

  test('未声明的能力贡献被忽略并记 warn 日志', () => {
    const host = new PluginHost();
    host.install({
      manifest: manifest({ id: 'quiet', capabilities: ['behavior'] }),
      activate: () => ({ metrics: [{ id: 'm', label: 'M', eventTypes: ['x'], aggregation: 'count' }] }),
    });
    expect(host.metrics).toEqual([]);
    expect(host.logs.some((entry) => entry.level === 'warn')).toBe(true);
  });

  test('指标、面板、模板按安装顺序汇总', () => {
    const host = new PluginHost();
    host.install({
      manifest: manifest({ id: 'a', capabilities: ['analytics', 'panel', 'scene-template'] }),
      activate: () => ({
        metrics: [{ id: 'a.throughput', label: '吞吐', eventTypes: ['parcel:exit'], aggregation: 'count' }],
        panels: [{ id: 'a.panel', title: 'A', component: 'PanelA' }],
        templates: [{ id: 'a.line', label: '输送线', build: (params) => [{ id: String(params.id ?? 'e'), kind: 'transport', transform: { position: [0, 0, 0] }, capabilities: [] }] }],
      }),
    });
    expect(host.metrics).toHaveLength(1);
    expect(host.panels[0]?.component).toBe('PanelA');
    expect(host.template('a.line')?.build({ id: 'x' })[0]?.id).toBe('x');
  });

  test('卸载按逆序 dispose 并摘掉行为', () => {
    const host = new PluginHost();
    const disposed: string[] = [];
    host.install({ manifest: manifest({ id: 'first' }), activate: () => ({ behaviors: [countingBehavior('f', { steps: 0 })], dispose: () => disposed.push('first') }) });
    host.install({ manifest: manifest({ id: 'second' }), activate: () => ({ behaviors: [countingBehavior('s', { steps: 0 })], dispose: () => disposed.push('second') }) });

    expect(host.uninstall('none')).toBe(false);
    host.dispose();
    expect(disposed).toEqual(['second', 'first']); // 后装的先卸
    expect(host.behaviors).toEqual([]);
    expect(host.list()).toEqual([]);
  });
});
