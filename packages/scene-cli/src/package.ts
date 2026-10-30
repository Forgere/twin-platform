import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { migrateTwinScene, validateTwinScene, type TwinScene } from '@twin-platform/scene-schema';
import { canonicalize, stableHash, type SceneTrace } from '@twin-platform/scene-spec';

/**
 * Scene package 目录约定（阶段 1 的 `scene.json / plugins.lock.json / seed.json / ...`）：
 * 一个包 = 一次可验证运行所需的全部输入，加上黄金基线 `expected/`。
 *
 * 必填：`scene.json`、`plugins.lock.json`、`seed.json`
 * 可选：`actions.json`、`invariants.json`、`metrics.json`、`expected/trace.json`
 */

export const SCENE_PACKAGE_FILES = {
  scene: 'scene.json',
  plugins: 'plugins.lock.json',
  seed: 'seed.json',
  actions: 'actions.json',
  invariants: 'invariants.json',
  metrics: 'metrics.json',
  baseline: join('expected', 'trace.json'),
} as const;

export interface ScenePackageLayout {
  readonly dir: string;
  readonly scene?: TwinScene;
  readonly plugins?: readonly unknown[];
  readonly seed?: Record<string, unknown>;
  readonly actions?: readonly unknown[];
  readonly invariants?: readonly unknown[];
  readonly metrics?: readonly unknown[];
  readonly baseline?: SceneTrace;
  readonly present: readonly string[];
  readonly missing: readonly string[];
  readonly packageHash?: string;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf-8')) as unknown;

function readOptional<T>(path: string): T | undefined {
  return existsSync(path) ? (readJson(path) as T) : undefined;
}

/** 读一遍目录并校验：坏包要在报告里说清哪里坏，而不是抛一个栈。 */
export function loadScenePackage(dir: string): { layout: ScenePackageLayout; issues: string[] } {
  const issues: string[] = [];
  const present: string[] = [];
  const missing: string[] = [];
  for (const name of [SCENE_PACKAGE_FILES.scene, SCENE_PACKAGE_FILES.plugins, SCENE_PACKAGE_FILES.seed] as const) {
    const path = resolve(dir, name);
    if (existsSync(path)) present.push(name);
    else {
      missing.push(name);
      issues.push(`缺少必填文件 ${name}`);
    }
  }
  if (missing.length > 0) return { layout: { dir, present, missing }, issues };

  let scene: TwinScene | undefined;
  try {
    const raw = readJson(resolve(dir, SCENE_PACKAGE_FILES.scene));
    scene = migrateTwinScene(raw).scene;
    const problems = validateTwinScene(scene);
    if (problems.length > 0) {
      issues.push(...problems.map((issue) => `${SCENE_PACKAGE_FILES.scene} ${issue.path}: ${issue.message}`));
      scene = undefined;
    }
  } catch (error) {
    issues.push(`${SCENE_PACKAGE_FILES.scene} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }

  let plugins: readonly unknown[] | undefined;
  try {
    const raw = readJson(resolve(dir, SCENE_PACKAGE_FILES.plugins));
    if (!Array.isArray(raw)) issues.push(`${SCENE_PACKAGE_FILES.plugins} 必须是数组`);
    else {
      plugins = raw;
      raw.forEach((entry, index) => {
        if (typeof entry !== 'object' || entry === null) issues.push(`plugins.lock.json[${index}] 必须是对象`);
        else {
          const record = entry as Record<string, unknown>;
          if (typeof record.id !== 'string' || !record.id) issues.push(`plugins.lock.json[${index}] 缺少 id`);
          if (typeof record.version !== 'string' || !record.version) issues.push(`plugins.lock.json[${index}] 缺少 version`);
        }
      });
    }
  } catch (error) {
    issues.push(`${SCENE_PACKAGE_FILES.plugins} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }

  let seed: Record<string, unknown> | undefined;
  try {
    const raw = readJson(resolve(dir, SCENE_PACKAGE_FILES.seed));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) issues.push('seed.json 必须是对象');
    else {
      seed = raw as Record<string, unknown>;
      const step = Number(seed.step ?? 1 / 60);
      const seconds = seed.seconds === undefined ? undefined : Number(seed.seconds);
      const steps = seed.steps === undefined ? undefined : Number(seed.steps);
      if (!Number.isFinite(step) || step <= 0) issues.push('seed.json.step 必须是正数');
      if (seconds !== undefined && steps !== undefined) issues.push('seed.json 里 seconds 与 steps 只能给一个');
      if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) issues.push('seed.json.seconds 必须是正数');
      if (seconds !== undefined && Math.abs(seconds / step - Math.round(seconds / step)) > 1e-9) {
        issues.push('seed.json.seconds 必须是 step 的整数倍');
      }
      if (steps !== undefined && (!Number.isInteger(steps) || steps <= 0)) issues.push('seed.json.steps 必须是正整数');
    }
  } catch (error) {
    issues.push(`seed.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }

  for (const name of [SCENE_PACKAGE_FILES.actions, SCENE_PACKAGE_FILES.invariants, SCENE_PACKAGE_FILES.metrics] as const) {
    if (!existsSync(resolve(dir, name))) continue;
    present.push(name);
    try {
      const raw = readJson(resolve(dir, name));
      if (!Array.isArray(raw)) issues.push(`${name} 必须是数组`);
    } catch (error) {
      issues.push(`${name} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const actions = readOptional<readonly unknown[]>(resolve(dir, SCENE_PACKAGE_FILES.actions));
  const invariants = readOptional<readonly unknown[]>(resolve(dir, SCENE_PACKAGE_FILES.invariants));
  const metrics = readOptional<readonly unknown[]>(resolve(dir, SCENE_PACKAGE_FILES.metrics));

  let baseline: SceneTrace | undefined;
  const baselinePath = resolve(dir, SCENE_PACKAGE_FILES.baseline);
  if (existsSync(baselinePath)) {
    present.push(SCENE_PACKAGE_FILES.baseline);
    try {
      baseline = readJson(baselinePath) as SceneTrace;
      if (baseline?.formatVersion !== 1) issues.push('expected/trace.json 的 formatVersion 必须是 1');
      if (scene && baseline.sceneId !== scene.id) {
        issues.push(`基线 sceneId=${baseline.sceneId} 与 scene.json 的 ${scene.id} 不一致`);
      }
      // 基线不能自报自证：本端按 scene-spec 重算两个哈希。
      if (baseline?.events && baseline.eventHash !== stableHash(baseline.events)) issues.push('基线 eventHash 与事件内容不符');
      if (baseline?.finalState !== undefined && baseline.stateHash !== stableHash(baseline.finalState)) issues.push('基线 stateHash 与末态不符');
    } catch (error) {
      issues.push(`expected/trace.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const packageHash = scene
    ? stableHash({
        scene: canonicalize(scene),
        plugins: canonicalize(plugins ?? []),
        seed: canonicalize(seed ?? {}),
        actions: canonicalize(actions ?? []),
      })
    : undefined;
  return { layout: { dir, scene, plugins, seed, actions, invariants, metrics, baseline, present, missing, packageHash }, issues };
}

export interface ScenePackageReport {
  readonly formatVersion: 1;
  readonly package: string;
  readonly passed: boolean;
  readonly checks: readonly {
    readonly id: string;
    readonly description: string;
    readonly status: 'pass' | 'fail';
    readonly violations: readonly string[];
    readonly notes: readonly string[];
  }[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly packageHash?: string;
}

export function auditScenePackage(dir: string): ScenePackageReport {
  const { layout, issues } = loadScenePackage(dir);
  const layoutIssues = issues.filter((message) => message.startsWith('缺少') || message.includes('不是合法 JSON'));
  const sceneIssues = issues.filter((message) => message.startsWith(SCENE_PACKAGE_FILES.scene));
  const lockIssues = issues.filter((message) => message.startsWith(SCENE_PACKAGE_FILES.plugins));
  const seedIssues = issues.filter((message) => message.startsWith('seed.json'));
  const baselineIssues = issues.filter((message) => message.startsWith('expected/trace.json') || message.startsWith('基线'));
  const otherIssues = issues.filter((message) =>
    ![layoutIssues, sceneIssues, lockIssues, seedIssues, baselineIssues].some((group) => group.includes(message)),
  );
  const checks = [
    {
      id: 'package.layout',
      description: '必填文件齐全且都是合法 JSON',
      status: layoutIssues.length === 0 && otherIssues.length === 0 ? 'pass' : 'fail',
      violations: [...layoutIssues, ...otherIssues],
      notes: [`已读 ${layout.present.join(', ') || '无'}`],
    },
    {
      id: 'package.scene',
      description: 'scene.json 可迁移并通过场景校验',
      status: sceneIssues.length === 0 ? 'pass' : 'fail',
      violations: sceneIssues,
      notes: [layout.scene ? `sceneId=${layout.scene.id}，${layout.scene.entities.length} 个实体` : 'scene 不可用'],
    },
    {
      id: 'package.plugin-lock',
      description: 'plugins.lock.json 的每条锁都有 id 与 version',
      status: lockIssues.length === 0 ? 'pass' : 'fail',
      violations: lockIssues,
      notes: [`${(layout.plugins ?? []).length} 条插件锁`],
    },
    {
      id: 'package.seed',
      description: 'seed.json 的时间网格可落到整数固定步',
      status: seedIssues.length === 0 ? 'pass' : 'fail',
      violations: seedIssues,
      notes: [layout.seed ? `seed=${String(layout.seed.seed ?? 1)} step=${String(layout.seed.step ?? 1 / 60)}` : 'seed 不可用'],
    },
    {
      id: 'package.baseline',
      description: '黄金基线存在时，sceneId 一致且哈希由本端重算通过',
      status: baselineIssues.length === 0 ? 'pass' : 'fail',
      violations: baselineIssues,
      notes: [layout.baseline ? `基线 events=${layout.baseline.events.length}` : '没有 expected/trace.json（可选）'],
    },
  ] as const;
  return {
    formatVersion: 1,
    package: dir,
    passed: checks.every((check) => check.status === 'pass'),
    checks,
    metrics: {
      entities: layout.scene?.entities.length ?? 0,
      pluginLocks: (layout.plugins ?? []).length,
      actions: (layout.actions ?? []).length,
      invariants: (layout.invariants ?? []).length,
      metrics: (layout.metrics ?? []).length,
      baselineEvents: layout.baseline?.events.length ?? 0,
    },
    ...(layout.packageHash ? { packageHash: layout.packageHash } : {}),
  };
}
