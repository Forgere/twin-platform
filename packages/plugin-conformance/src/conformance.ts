import { PLUGIN_SDK_VERSION, PluginHost, assertManifest, validateManifest, type TwinPlugin } from '@twin-platform/plugin-sdk';
import type { TwinScene } from '@twin-platform/scene-schema';
import type { AuditCheckResult } from '@twin-platform/scene-spec';
import { TwinWorld } from '@twin-platform/world-kernel';
import { eventFingerprint, worldFingerprint } from '@twin-platform/replay-core';

/**
 * 插件 conformance kit：开发者自检清单。
 *
 * 它不认识任何具体领域，只回答“这个插件能不能进公共验证链”：
 * manifest 合法、激活同步、能力与贡献一致、同种子可复现、源码没有裸随机 / 挂钟。
 */

export interface ConformanceSource {
  readonly path: string;
  readonly text: string;
}

export interface ConformanceInput {
  readonly plugin: TwinPlugin;
  /** 用来跑确定性检查的最小场景（由插件或宿主提供）。 */
  readonly scene: TwinScene;
  readonly seed?: number;
  readonly steps?: number;
  /** 插件源码（可选）：用于静态检查裸随机 / 挂钟。 */
  readonly sources?: readonly ConformanceSource[];
}

export interface ConformanceFinding {
  readonly id: string;
  readonly where: string;
  readonly line: number;
  readonly message: string;
}

export interface ConformanceReport {
  readonly formatVersion: 1;
  readonly pluginId: string;
  readonly passed: boolean;
  readonly checks: readonly AuditCheckResult[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
}

const NONDETERMINISM: readonly { readonly id: string; readonly pattern: RegExp; readonly message: string }[] = [
  { id: 'global-random', pattern: /Math\s*\.\s*random\s*\(/, message: '使用了 Math.random：回放会分叉' },
  { id: 'wall-clock', pattern: /Date\s*\.\s*now\s*\(|new\s+Date\s*\(/, message: '读取挂钟时间：回放会分叉' },
  { id: 'performance-clock', pattern: /performance\s*\.\s*now\s*\(/, message: '读取 performance.now：回放会分叉' },
  { id: 'timer', pattern: /\bsetTimeout\s*\(|\bsetInterval\s*\(/, message: '依赖真实定时器：不是固定步长' },
];

interface PluginInstanceLike {
  readonly behaviors?: readonly unknown[];
  readonly metrics?: readonly unknown[];
  readonly panels?: readonly unknown[];
  readonly templates?: readonly unknown[];
  readonly decisions?: readonly unknown[];
}

export function scanSources(sources: readonly ConformanceSource[]): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  for (const source of sources) {
    source.text.split(/\r?\n/).forEach((line, index) => {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return; // 注释里的示例不算
      for (const rule of NONDETERMINISM) {
        if (rule.pattern.test(line)) {
          findings.push({ id: rule.id, where: source.path, line: index + 1, message: rule.message });
        }
      }
    });
  }
  return findings;
}

const capabilityOf = (count: number, capability: string): boolean => count > 0;

export function runConformance(input: ConformanceInput): ConformanceReport {
  const steps = input.steps ?? 120;
  const seed = input.seed ?? 1;
  const warnings: string[] = [];
  const checks: AuditCheckResult[] = [];

  const manifestIssues = validateManifest(input.plugin.manifest);
  checks.push({
    id: 'conformance.manifest',
    description: 'manifest 字段合法（id / version / sdkVersion / name / capabilities）',
    status: manifestIssues.length === 0 ? 'pass' : 'fail',
    violations: manifestIssues.map((issue) => ({ where: issue.path, message: issue.message })),
    notes: manifestIssues.length === 0 ? [`${input.plugin.manifest.id}@${input.plugin.manifest.version}`] : [],
  });

  // 原始贡献（未经过 PluginHost 的能力过滤）：声明与实现漂移必须在这里被看见。
  let rawInstance: PluginInstanceLike | undefined;
  try {
    rawInstance = input.plugin.activate({
      manifest: assertManifest(input.plugin.manifest),
      config: {},
      sdkVersion: PLUGIN_SDK_VERSION,
      log: () => undefined,
    }) as PluginInstanceLike;
  } catch (error) {
    rawInstance = undefined;
    checks.push({
      id: 'conformance.activate',
      description: '插件可同步激活（异步激活会让插件锁与回放失效）',
      status: 'error',
      violations: [{ message: `activate 抛错：${error instanceof Error ? error.message : String(error)}` }],
      notes: [],
    });
  }
  if (rawInstance) {
    const asynchronous = rawInstance instanceof Promise || typeof (rawInstance as { then?: unknown }).then === 'function';
    checks.push({
      id: 'conformance.activate',
      description: '插件可同步激活（异步激活会让插件锁与回放失效）',
      status: asynchronous ? 'fail' : 'pass',
      violations: asynchronous ? [{ message: 'activate 返回了 Promise；插件激活必须同步。' }] : [],
      notes: asynchronous ? [] : ['activate 返回的是同步实例'],
    });
  }

  let host: PluginHost | undefined;
  let behaviorCount = 0;
  let metricCount = 0;
  try {
    host = new PluginHost();
    host.install(input.plugin);
    behaviorCount = host.behaviors.length;
    metricCount = host.metrics.length;
  } catch (error) {
    host = undefined;
    checks.push({
      id: 'conformance.host-install',
      description: '插件可被 PluginHost 安装（manifest / SDK 版本 / 配置都通过）',
      status: 'error',
      violations: [{ message: error instanceof Error ? error.message : String(error) }],
      notes: [],
    });
  }
  if (host) {
    checks.push({
      id: 'conformance.host-install',
      description: '插件可被 PluginHost 安装（manifest / SDK 版本 / 配置都通过）',
      status: 'pass',
      violations: [],
      notes: [`宿主可见 ${behaviorCount} 行为 / ${metricCount} 指标`],
    });
  }

  if (rawInstance) {
    const manifest = assertManifest(input.plugin.manifest);
    const declared = new Set(manifest.capabilities as readonly string[]);
    const contributed: readonly { capability: string; count: number }[] = [
      { capability: 'behavior', count: (rawInstance.behaviors ?? []).length },
      { capability: 'analytics', count: (rawInstance.metrics ?? []).length },
      { capability: 'panel', count: (rawInstance.panels ?? []).length },
      { capability: 'scene-template', count: (rawInstance.templates ?? []).length },
      { capability: 'decision', count: (rawInstance.decisions ?? []).length },
    ];
    const undeclared = contributed.filter((item) => capabilityOf(item.count, item.capability) && !declared.has(item.capability));
    checks.push({
      id: 'conformance.capabilities',
      description: '实际贡献都在 manifest 声明的能力里',
      status: undeclared.length === 0 ? 'pass' : 'fail',
      violations: undeclared.map((item) => ({ where: item.capability, message: `声明里没有该能力，却贡献了 ${item.count} 项` })),
      notes: [`声明 ${manifest.capabilities.join(', ') || '无'}`],
    });
  }

  if (host) {
    const runOnce = (worldSeed: number): { events: string; world: string } => {
      const world = new TwinWorld(input.scene, { seed: worldSeed, behaviors: host!.behaviors, maxStepsPerAdvance: 4096 });
      world.runSteps(steps);
      return { events: eventFingerprint(world.getEventLog()), world: worldFingerprint(world) };
    };
    const first = runOnce(seed);
    const second = runOnce(seed);
    const violations = [];
    if (first.events !== second.events) violations.push({ where: 'eventFingerprint', message: `同种子两次事件流不同：${first.events} vs ${second.events}` });
    if (first.world !== second.world) violations.push({ where: 'worldFingerprint', message: '同种子两次世界状态不同' });
    checks.push({
      id: 'conformance.determinism',
      description: '同场景 + 同种子两次运行逐位一致',
      status: violations.length === 0 ? 'pass' : 'fail',
      violations,
      notes: [`${steps} 步 · event=${first.events}`],
    });
  }

  const findings = scanSources(input.sources ?? []);
  if (!input.sources) warnings.push('没有提供插件源码：跳过裸随机 / 挂钟静态检查');
  checks.push({
    id: 'conformance.source-hygiene',
    description: '插件源码不出现 Math.random / Date.now / performance.now / 定时器',
    status: findings.length === 0 ? 'pass' : 'fail',
    violations: findings.map((item) => ({ where: `${item.where}:${item.line}`, message: item.message })),
    notes: input.sources ? [`扫描 ${input.sources.length} 个文件`] : ['未提供源码'],
  });

  if (host) {
    try {
      host.uninstall(input.plugin.manifest.id);
    } catch (error) {
      warnings.push(`卸载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    formatVersion: 1,
    pluginId: input.plugin.manifest.id,
    passed: checks.every((check) => check.status === 'pass'),
    checks,
    metrics: {
      checks: checks.length,
      behaviors: (rawInstance?.behaviors ?? []).length,
      behaviorsVisibleToHost: behaviorCount,
      metrics: (rawInstance?.metrics ?? []).length,
      sourceFindings: findings.length,
      steps,
    },
    warnings,
  };
}
