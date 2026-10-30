import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './index';

const SCENE = {
  version: 1,
  id: 'cli-demo',
  name: 'CLI demo',
  entities: [
    { id: 'box', kind: 'box', transform: { position: [0, 0, 0] }, capabilities: [], attrs: { count: 0 } },
  ],
};

let dir = '';
let logs: string[] = [];
let errors: string[] = [];

const cli = (argv: readonly string[]): Promise<number> =>
  runCli(argv, { cwd: dir, io: { log: (line) => logs.push(line), error: (line) => errors.push(line) } });

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, path), 'utf-8')) as Record<string, unknown>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scene-cli-'));
  logs = [];
  errors = [];
  writeFileSync(join(dir, 'scene.json'), `${JSON.stringify(SCENE, null, 2)}\n`, 'utf-8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('scene-cli', () => {
  test('run 产出 trace / 报告 / HTML / JUnit，且同输入重跑逐字节一致', async () => {
    const first = await cli(['run', '--scene', 'scene.json', '--seconds', '2', '--out', 'out-a']);
    expect(first).toBe(0);
    expect(existsSync(join(dir, 'out-a/trace.json'))).toBe(true);
    expect(existsSync(join(dir, 'out-a/report.html'))).toBe(true);
    const junit = readFileSync(join(dir, 'out-a/junit.xml'), 'utf-8');
    expect(junit).toContain('<testsuite name="cli-demo"');
    expect(junit).not.toContain('timestamp');

    const second = await cli(['run', '--scene', 'scene.json', '--seconds', '2', '--out', 'out-b']);
    expect(second).toBe(0);
    expect(readFileSync(join(dir, 'out-a/trace.json'), 'utf-8')).toBe(readFileSync(join(dir, 'out-b/trace.json'), 'utf-8'));
    expect(readFileSync(join(dir, 'out-a/junit.xml'), 'utf-8')).toBe(readFileSync(join(dir, 'out-b/junit.xml'), 'utf-8'));
  });

  test('replay 用黄金基线做门禁：一致通过，改动后给出首个分歧', async () => {
    expect(await cli(['replay', '--scene', 'scene.json', '--seconds', '2', '--update'])).toBe(0);
    expect(existsSync(join(dir, 'expected/trace.json'))).toBe(true);
    expect(await cli(['replay', '--scene', 'scene.json', '--seconds', '2', '--junit', 'pass.xml'])).toBe(0);

    const diverged = await cli(['replay', '--scene', 'scene.json', '--seconds', '3', '--junit', 'fail.xml']);
    expect(diverged).toBe(1);
    expect(logs.join('\n')).toContain('基线分歧：/steps');
    const junit = readFileSync(join(dir, 'fail.xml'), 'utf-8');
    expect(junit).toContain('<failure');
    expect(junit).toContain('/steps');
    expect(junit).toContain('name="firstDivergence"');
  });

  test('动作脚本进 trace：diff 能定位到动作差异', async () => {
    writeFileSync(
      join(dir, 'actions.json'),
      `${JSON.stringify([{ atStep: 0, id: 'set-attr', params: { entityId: 'box', key: 'count', value: 1 } }], null, 2)}\n`,
      'utf-8',
    );
    expect(await cli(['run', '--scene', 'scene.json', '--seconds', '1', '--actions', 'actions.json', '--out', 'with-action'])).toBe(0);
    expect(await cli(['run', '--scene', 'scene.json', '--seconds', '1', '--out', 'plain'])).toBe(0);
    expect((readJson('with-action/trace.json')['actions'] as unknown[]).length).toBe(1);

    const code = await cli(['diff', 'with-action/trace.json', 'plain/trace.json']);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('trace 分歧：/actions/0');
  });

  test('report 命令用已有 trace 渲染 HTML', async () => {
    await cli(['run', '--scene', 'scene.json', '--steps', '30', '--out', 'out']);
    expect(await cli(['report', 'out/trace.json'])).toBe(0);
    expect(readFileSync(join(dir, 'out/report.html'), 'utf-8')).toContain('场景审计报告');
  });

  test('verify 由本端重算外部 trace 哈希，篡改声明会被拒绝', async () => {
    await cli(['run', '--scene', 'scene.json', '--steps', '30', '--out', 'out']);
    expect(await cli(['verify', 'out/trace.json', '--junit', 'verify.xml'])).toBe(0);
    expect(readFileSync(join(dir, 'verify.xml'), 'utf-8')).toContain('name="event-hash"');
    const trace = readJson('out/trace.json');
    trace['eventHash'] = '00000000';
    writeFileSync(join(dir, 'bad-trace.json'), JSON.stringify(trace), 'utf-8');
    expect(await cli(['verify', 'bad-trace.json'])).toBe(1);
    expect(logs.join('\n')).toContain('FAIL event-hash');
  });

  test('package 校验场景包目录：齐全通过，缺件与假基线都被拒绝', async () => {
    const pack = join(dir, 'pack');
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, 'scene.json'), JSON.stringify(SCENE), 'utf-8');
    writeFileSync(join(pack, 'plugins.lock.json'), '[]', 'utf-8');
    writeFileSync(join(pack, 'seed.json'), JSON.stringify({ seed: 1, step: 0.5, seconds: 2 }), 'utf-8');
    expect(await cli(['package', 'pack', '--junit', 'package.xml'])).toBe(0);
    expect(readFileSync(join(dir, 'package.xml'), 'utf-8')).toContain('name="package.layout"');

    rmSync(join(pack, 'plugins.lock.json'));
    expect(await cli(['package', 'pack'])).toBe(1);
    expect(logs.join('\n')).toContain('缺少必填文件 plugins.lock.json');

    // 基线自报自证：改掉 eventHash 不改事件，必须被重算抓住。
    writeFileSync(join(pack, 'plugins.lock.json'), '[]', 'utf-8');
    mkdirSync(join(pack, 'expected'), { recursive: true });
    await cli(['run', '--scene', 'pack/scene.json', '--seconds', '2', '--out', 'pack/expected']);
    const trace = readJson('pack/expected/trace.json') as Record<string, unknown>;
    trace['eventHash'] = '00000000';
    writeFileSync(join(pack, 'expected', 'trace.json'), JSON.stringify(trace), 'utf-8');
    expect(await cli(['package', 'pack'])).toBe(1);
    expect(logs.join('\n')).toContain('基线 eventHash 与事件内容不符');
  });

  test('插件模板 + 运行时不变量：钓场审计通过并留下检查记录', async () => {
    const code = await cli(['audit', '--template', 'fishing.pond', '--seconds', '2', '--out', 'pond']);
    expect(code).toBe(0);
    const report = readJson('pond/report.json') as { checks: { id: string; status: string }[] };
    expect(report.checks.map((check) => check.id)).toContain('fishing.rig.layout');
    expect(report.checks.every((check) => check.status === 'pass')).toBe(true);
  });

  test('用法错误退出 2，并把原因写到 stderr', async () => {
    expect(await cli(['nope'])).toBe(2);
    expect(errors.join('\n')).toContain('未知命令 nope');
    expect(await cli(['run'])).toBe(2);
    expect(errors.join('\n')).toContain('需要 --scene');
  });
});
