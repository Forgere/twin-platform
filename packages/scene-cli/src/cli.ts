import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { renderAuditHtml, runAudit } from '@twin-platform/scene-audit';
import { diffTrace, runTwinScene, type RunTwinSceneInput } from '@twin-platform/scene-runner';
import { migrateTwinScene, validateTwinScene, type TwinScene } from '@twin-platform/scene-schema';
import type { AuditReport, SceneTrace, TraceDiff } from '@twin-platform/scene-spec';
import { buildTwinActions, type ActionSpec } from './actions';
import { flagBoolean, flagNumber, flagString, parseArgs, USAGE, type ParsedArgs } from './args';
import {
  BASELINE_DIR,
  HTML_FILE,
  JUNIT_FILE,
  REPORT_FILE,
  TRACE_FILE,
  readTraceFile,
  writeJsonFile,
  writeTextFile,
} from './artifacts';
import { junitFromAudit, toJUnitXml } from './junit';
import { auditScenePackage } from './package';
import { verifySceneTrace } from './verify';
import { loadCliPlugin, parseTemplateSpec, type CliPlugin } from './plugins';

export interface CliIo {
  log(line: string): void;
  error(line: string): void;
}

export interface CliContext {
  /** 相对路径的解析基准，默认 `process.cwd()`。 */
  readonly cwd?: string;
  readonly io?: Partial<CliIo>;
}

const DEFAULT_DURATION_SECONDS = 60;
/** 退出码：0 通过 · 1 审计或差分失败 · 2 用法 / IO / 执行错误。 */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_ERROR = 2;

interface RunPlan {
  readonly scene: TwinScene;
  readonly plugin: CliPlugin;
  readonly input: RunTwinSceneInput;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function readJsonAt(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

function loadSceneFile(path: string): TwinScene {
  const raw = readJsonAt(path);
  const migrated = migrateTwinScene(raw);
  const issues = validateTwinScene(migrated.scene);
  if (issues.length > 0) {
    throw new Error(`场景 ${path} 校验失败：\n${issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n')}`);
  }
  return migrated.scene;
}

function parseTemplateParams(raw: string | undefined, cwd: string): Record<string, unknown> {
  if (raw === undefined) return {};
  const text = raw.trim().startsWith('{') ? raw : readFileSync(resolve(cwd, raw), 'utf-8');
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--template-params 必须是 JSON 对象。');
  return parsed as Record<string, unknown>;
}

function parseActions(raw: string | undefined, cwd: string, step: number) {
  if (raw === undefined) return undefined;
  const parsed = readJsonAt(resolve(cwd, raw));
  if (!Array.isArray(parsed)) throw new Error('--actions 必须是动作数组。');
  return buildTwinActions(parsed as ActionSpec[], step);
}

async function buildPlan(args: ParsedArgs, cwd: string): Promise<RunPlan> {
  const flags = args.flags;
  const scenePath = flagString(flags, 'scene');
  const templateSpec = flagString(flags, 'template');
  if (scenePath && templateSpec) throw new Error('--scene 与 --template 只能给一个。');

  const step = flagNumber(flags, 'step') ?? 1 / 60;
  if (!Number.isFinite(step) || step <= 0) throw new Error('--step 必须是正数字。');
  const seed = flagNumber(flags, 'seed') ?? 1;
  const stepsFlag = flagNumber(flags, 'steps');
  const secondsFlag = flagNumber(flags, 'seconds');
  if (stepsFlag !== undefined && secondsFlag !== undefined) throw new Error('--steps 与 --seconds 只能给一个。');
  const durationSeconds = stepsFlag === undefined ? secondsFlag ?? DEFAULT_DURATION_SECONDS : undefined;

  let scene: TwinScene;
  let pluginId: string;
  if (templateSpec) {
    const spec = parseTemplateSpec(templateSpec);
    const explicit = flagString(flags, 'plugin');
    if (explicit && explicit !== spec.plugin) throw new Error(`--plugin ${explicit} 与 --template ${templateSpec} 指向不同插件。`);
    pluginId = spec.plugin;
    const templatePlugin = await loadCliPlugin(pluginId);
    if (!templatePlugin.buildScene) throw new Error(`插件 ${pluginId} 没有场景模板。`);
    scene = templatePlugin.buildScene(spec.template, parseTemplateParams(flagString(flags, 'template-params'), cwd));
  } else if (scenePath) {
    scene = loadSceneFile(resolve(cwd, scenePath));
    pluginId = flagString(flags, 'plugin') ?? 'none';
  } else {
    throw new Error('需要 --scene <file> 或 --template <plugin.template>。');
  }

  const plugin = await loadCliPlugin(pluginId);
  const locks = pluginId === 'none' ? [] : [{ id: plugin.id, version: plugin.version }];
  const input: RunTwinSceneInput = {
    scene,
    seed,
    step,
    behaviors: plugin.behaviors(),
    checks: plugin.checksForScene(scene),
    plugins: locks,
    ...(stepsFlag !== undefined ? { steps: stepsFlag } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(flagNumber(flags, 'event-log-size') !== undefined ? { eventLogSize: flagNumber(flags, 'event-log-size')! } : {}),
  };
  const actions = parseActions(flagString(flags, 'actions'), cwd, step);
  if (actions) return { scene, plugin, input: { ...input, actions } };
  return { scene, plugin, input };
}

interface ArtifactPaths {
  readonly outDir?: string;
  readonly html?: string;
  readonly junit?: string;
}

function writeArtifacts(
  cwd: string,
  paths: ArtifactPaths,
  run: { trace: SceneTrace; report: AuditReport },
  diff?: TraceDiff,
): string[] {
  const written: string[] = [];
  const outDir = paths.outDir === undefined ? undefined : resolve(cwd, paths.outDir);
  if (outDir) {
    writeJsonFile(join(outDir, TRACE_FILE), run.trace);
    writeJsonFile(join(outDir, REPORT_FILE), run.report);
    written.push(join(paths.outDir!, TRACE_FILE), join(paths.outDir!, REPORT_FILE));
  }
  const htmlPath = paths.html ?? (paths.outDir ? join(paths.outDir, HTML_FILE) : undefined);
  if (htmlPath) {
    writeTextFile(resolve(cwd, htmlPath), renderAuditHtml(run.report, run.trace, diff));
    written.push(htmlPath);
  }
  const junitPath = paths.junit ?? (paths.outDir ? join(paths.outDir, JUNIT_FILE) : undefined);
  if (junitPath) {
    writeTextFile(resolve(cwd, junitPath), junitFromAudit(run.report, diff));
    written.push(junitPath);
  }
  return written;
}

function summarize(io: CliIo, run: { trace: SceneTrace; report: AuditReport }, diff?: TraceDiff): void {
  const { trace, report } = run;
  const failed = report.checks.filter((check) => check.status === 'fail').length;
  const errors = report.checks.filter((check) => check.status === 'error').length;
  io.log(`场景 ${trace.sceneId} · seed=${trace.seed} step=${trace.step} steps=${trace.steps}`);
  io.log(`哈希 scene=${trace.sceneHash} event=${trace.eventHash} state=${trace.stateHash}`);
  io.log(`不变量 ${report.checks.length} 条：通过 ${report.checks.length - failed - errors} / 失败 ${failed} / 异常 ${errors}`);
  io.log(`报告 ${report.passed ? 'PASS' : 'FAIL'}`);
  if (diff) {
    io.log(
      diff.identical
        ? `基线一致（${diff.baselineHash}）`
        : `基线分歧：${diff.firstDivergence?.pointer ?? '/'}（${diff.firstDivergence?.reason ?? 'unknown'}）`,
    );
  }
  for (const warning of report.warnings) io.log(`警告 ${warning}`);
  for (const check of report.checks.filter((item) => item.status !== 'pass')) {
    for (const violation of check.violations) {
      io.log(`违例 ${check.id}${violation.where ? ` @ ${violation.where}` : ''}：${violation.message}`);
    }
  }
}

async function executeCommand(args: ParsedArgs, cwd: string, io: CliIo): Promise<number> {
  const flags = args.flags;
  const outDir = flagString(flags, 'out');
  const paths: ArtifactPaths = { outDir, html: flagString(flags, 'html'), junit: flagString(flags, 'junit') };

  if (args.command === 'package') {
    const dir = args.positionals[0];
    if (!dir) throw new Error('package 需要场景包目录。');
    const target = resolve(cwd, dir);
    if (!existsSync(target)) throw new Error(`找不到场景包目录：${target}`);
    const report = auditScenePackage(target);
    for (const check of report.checks) {
      io.log(`${check.status === 'pass' ? 'PASS' : 'FAIL'} ${check.id} · ${check.notes.join(' / ')}`);
      for (const violation of check.violations) io.log(`  违例 ${violation}`);
    }
    if (report.packageHash) io.log(`包哈希 ${report.packageHash}`);
    if (paths.junit) {
      writeTextFile(resolve(cwd, paths.junit), toJUnitXml({
        name: `package:${report.package}`,
        cases: report.checks.map((check) => ({
          name: check.id,
          status: check.status,
          message: check.violations.join(' | '),
        })),
        properties: { verified: report.passed ? 1 : 0, ...(report.packageHash ? { packageHash: report.packageHash } : {}) },
      }));
    }
    if (outDir) {
      writeJsonFile(join(outDir, 'package-report.json'), report);
      io.log(`产物 ${join(paths.outDir!, 'package-report.json')}`);
    }
    return report.passed ? EXIT_OK : EXIT_FAILED;
  }

  if (args.command === 'verify') {
    const tracePath = args.positionals[0];
    if (!tracePath) throw new Error('verify 需要 trace.json 路径。');
    const trace = readTraceFile(resolve(cwd, tracePath));
    const verification = verifySceneTrace(trace);
    for (const check of verification.checks) io.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.id} · ${check.detail}`);
    if (paths.junit) {
      writeTextFile(resolve(cwd, paths.junit), toJUnitXml({
        name: `${trace.sceneId}:verify`,
        cases: verification.checks.map((check) => ({ name: check.id, status: check.pass ? 'pass' : 'fail', message: check.detail })),
        properties: { sceneHash: trace.sceneHash, verified: verification.ok ? 1 : 0 },
      }));
    }
    return verification.ok ? EXIT_OK : EXIT_FAILED;
  }

  if (args.command === 'report') {
    const tracePath = args.positionals[0];
    if (!tracePath) throw new Error('report 需要 trace.json 路径。');
    const trace = readTraceFile(resolve(cwd, tracePath));
    const reportPath = args.positionals[1];
    const report = reportPath
      ? (readJsonAt(resolve(cwd, reportPath)) as AuditReport)
      : runAudit({ sceneId: trace.sceneId, subject: null, checks: [] });
    const htmlPath = flagString(flags, 'html') ?? join(dirname(tracePath), HTML_FILE);
    writeTextFile(resolve(cwd, htmlPath), renderAuditHtml(report, trace));
    if (paths.junit) writeTextFile(resolve(cwd, paths.junit), junitFromAudit(report));
    io.log(`报告已写入 ${htmlPath}`);
    return EXIT_OK;
  }

  if (args.command === 'diff') {
    const [currentPath, baselinePath] = args.positionals;
    if (!currentPath || !baselinePath) throw new Error('diff 需要两个位置参数：<current> <baseline>。');
    const diff = diffTrace(readTraceFile(resolve(cwd, currentPath)), readTraceFile(resolve(cwd, baselinePath)));
    if (paths.junit) writeTextFile(resolve(cwd, paths.junit), junitFromAudit(runAudit({ sceneId: diff.currentHash, subject: null, checks: [] }), diff));
    io.log(
      diff.identical
        ? `trace 一致（${diff.currentHash}）`
        : `trace 分歧：${diff.firstDivergence?.pointer ?? '/'}（${diff.firstDivergence?.reason ?? 'unknown'}）baseline=${diff.baselineHash} current=${diff.currentHash}`,
    );
    return diff.identical ? EXIT_OK : EXIT_FAILED;
  }

  const plan = await buildPlan(args, cwd);
  const run = runTwinScene(plan.input);

  const baselineFlag = flagString(flags, 'baseline');
  const baselinePath = resolve(cwd, baselineFlag ?? join(BASELINE_DIR, TRACE_FILE));
  const wantsBaseline = args.command === 'replay' || baselineFlag !== undefined;
  const update = flagBoolean(flags, 'update');
  let diff: TraceDiff | undefined;
  if (wantsBaseline) {
    if (update) {
      writeJsonFile(baselinePath, run.trace);
      io.log(`已更新基线 ${baselineFlag ?? join(BASELINE_DIR, TRACE_FILE)}`);
    } else if (!existsSync(baselinePath)) {
      throw new Error(`基线不存在：${baselineFlag ?? join(BASELINE_DIR, TRACE_FILE)}（加 --update 生成）。`);
    } else {
      diff = diffTrace(readTraceFile(baselinePath), run.trace);
    }
  }

  const written = writeArtifacts(cwd, paths, run, diff);
  summarize(io, run, diff);
  for (const path of written) io.log(`产物 ${path}`);

  const gateFailed = !run.report.passed || (diff !== undefined && !diff.identical);
  if (args.command === 'audit' && gateFailed) return EXIT_FAILED;
  if (args.command === 'replay' && gateFailed) return EXIT_FAILED;
  if (gateFailed && flagBoolean(flags, 'strict')) return EXIT_FAILED;
  return EXIT_OK;
}

export async function runCli(argv: readonly string[], context: CliContext = {}): Promise<number> {
  const cwd = context.cwd ?? process.cwd();
  const io: CliIo = { log: context.io?.log ?? ((line: string) => console.log(line)), error: context.io?.error ?? ((line: string) => console.error(line)) };
  try {
    const args = parseArgs(argv);
    if (args.command === '' || args.command === 'help' || flagBoolean(args.flags, 'help')) {
      io.log(USAGE);
      return args.command === '' ? EXIT_ERROR : EXIT_OK;
    }
    if (!['run', 'audit', 'replay', 'diff', 'report', 'verify', 'package'].includes(args.command)) {
      throw new Error(`未知命令 ${args.command}；可用：run / audit / replay / diff / report / verify / package。`);
    }
    return await executeCommand(args, cwd, io);
  } catch (error) {
    io.error(`scene-cli: ${message(error)}`);
    return EXIT_ERROR;
  }
}

// 直接执行本文件时才跑命令（`bun run scene ...`）。
// 不用 `import.meta.main`：仓库没装 bun-types，且测试会 import 本模块，不能顺带执行 CLI。
const invokedDirectly = process.argv[1] !== undefined && /(?:^|[\\/])cli\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  void runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
