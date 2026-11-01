#!/usr/bin/env bun
/**
 * 一条命令跑完「对外传播」要讲的三件事，并把证据落在 ./demo-evidence/。
 *
 *   1. 跨 OS 确定性 —— 同 commit 同种子重跑，trace 逐字节一致；
 *   2. 故障注入抓伪造证据 —— 篡改一条事件且不重算哈希，门禁照样指到具体 pointer；
 *   3. 换引擎不换门禁 —— 同一套 verify/diff/report 吃 SimPy / FMU / OpenSCENARIO 的 trace。
 *
 * 用法：
 *   bun scripts/demo-evidence.ts                 # 全部跑（Python adapter 缺依赖会跳过并说明）
 *   bun scripts/demo-evidence.ts --only core     # 只跑 1、2（纯 bun，不需要 Python 依赖）
 *
 * 退出码：全部通过 0，任何一步红灯 1。
 */

type Step = { name: string; ok: boolean; detail: string };

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const outDir = 'demo-evidence';

const steps: Step[] = [];

function run(cmd: string[], label: string): { code: number; out: string } {
  const proc = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
  return {
    code: proc.exitCode,
    out: `${new TextDecoder().decode(proc.stdout)}${new TextDecoder().decode(proc.stderr)}`,
  };
}

function record(name: string, ok: boolean, detail: string): void {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} · ${detail}`);
}

function scene(argv: string[]): { code: number; out: string } {
  return run(['bun', 'packages/scene-cli/src/cli.ts', ...argv], argv.join(' '));
}

function hasPythonModule(module: string): boolean {
  return run(['python3', '-c', `import ${module}`], 'probe').code === 0;
}

// ── 1. 确定性：同输入两次运行逐字节一致 ────────────────────────────────────
console.log('\n── 1. 跨 OS 确定性（同种子两次运行逐字节一致）──\n');

const a = scene(['run', '--package', 'examples/community/mini-line', '--out', `${outDir}/determinism/a`]);
const b = scene(['run', '--package', 'examples/community/mini-line', '--out', `${outDir}/determinism/b`]);
const bytesA = Bun.file(`${outDir}/determinism/a/trace.json`);
const bytesB = Bun.file(`${outDir}/determinism/b/trace.json`);
const aBuf = await bytesA.arrayBuffer();
const bBuf = await bytesB.arrayBuffer();
const identical = a.code === 0 && b.code === 0 && aBuf.byteLength === bBuf.byteLength && Buffer.from(aBuf).equals(Buffer.from(bBuf));
const hashes = a.out.match(/event=(\w+)/)?.[1] ?? '?';
record('同种子两次运行 trace 逐字节一致', identical, `两次 exit 0 且字节相同 · event=${hashes}`);

const replay = scene(['replay', '--package', 'examples/community/mini-line', '--out', `${outDir}/determinism/replay`]);
record('与包内黄金基线一致', replay.code === 0, replay.out.split('\n').find((line) => line.includes('基线'))?.trim() ?? replay.out.trim());

// ── 2. 故障注入：篡改一条证据还声称复现，门禁照抓 ──────────────────────────
console.log('\n── 2. 故障注入（改了内容不重算哈希，也要指到具体字段）──\n');

const golden = scene(['replay', '--package', 'examples/community/mini-line', '--baseline', 'examples/community/mini-line/expected/trace.json', '--out', `${outDir}/fault/golden`]);
record('黄金基线 replay 通过', golden.code === 0, golden.out.split('\n').find((line) => line.includes('基线'))?.trim() ?? golden.out.trim());

const tampered = scene(['replay', '--package', 'examples/community/mini-line', '--baseline', 'examples/fault-injection/tampered.json', '--out', `${outDir}/fault/tampered`]);
const pointer = tampered.out.match(/基线分歧：(\/[\w/]+)/)?.[1] ?? '';
record('篡改基线被拦下且给出 pointer', tampered.code === 1 && pointer === '/events/2/payload/status', `exit=${tampered.code} pointer=${pointer || '无'}`);

const verifyTampered = scene(['verify', 'examples/fault-injection/tampered.json']);
const hashFail = verifyTampered.out.split('\n').find((line) => line.includes('event-hash') && line.includes('FAIL'))?.trim() ?? '';
record('verify 重算哈希抓出伪造', verifyTampered.code === 1, hashFail || '未失败');

// ── 3. 换引擎不换门禁：外部 runtime 的 trace 由 TypeScript 重算哈希 ────────
if (only !== 'core') {
  console.log('\n── 3. 换引擎不换门禁（SimPy / FMU / OpenSCENARIO 同吃一套 verify / diff）──\n');

  const engines: { name: string; module?: string; build?: string[]; run: string[]; baseline?: string }[] = [
    {
      name: 'SimPy（Python 真实跑）',
      module: 'simpy',
      run: ['python3', 'adapters/simpy/run.py', '--spec', 'adapters/simpy/scenes/two-stage-cell.json', '--out', `${outDir}/engines/simpy`],
    },
    {
      name: 'FMI 2.0 FMU（ctypes 加载二进制）',
      build: ['python3', 'adapters/fmu/scripts/build_reference_fmu.py', '--out-dir', 'adapters/fmu/build/tank', '--fmu', 'adapters/fmu/build/tank.fmu'],
      run: ['python3', 'adapters/fmu/run.py', '--spec', 'adapters/fmu/scenes/tank-step.json', '--out', `${outDir}/engines/fmu`],
    },
    {
      name: 'OpenSCENARIO 1.x（导入外部场景 XML）',
      run: ['python3', 'adapters/openscenario/run.py', '--spec', 'adapters/openscenario/scenes/follow-and-accelerate.json', '--out', `${outDir}/engines/openscenario`],
      baseline: 'adapters/openscenario/expected/trace.json',
    },
  ];

  for (const engine of engines) {
    if (engine.module && !hasPythonModule(engine.module)) {
      record(engine.name, false, `跳过：没装 Python 模块 ${engine.module}`);
      continue;
    }
    if (engine.build) {
      const built = run(engine.build, 'build');
      if (built.code !== 0) {
        record(engine.name, false, `编译失败：${built.out.trim().split('\n').at(-1) ?? ''}`);
        continue;
      }
    }
    const produced = run(engine.run, 'run');
    if (produced.code !== 0) {
      record(engine.name, false, `运行失败：${produced.out.trim().split('\n').at(-1) ?? ''}`);
      continue;
    }
    const tracePath = produced.out.match(/产物 (\S*trace\.json)/)?.[1] ?? engine.run.at(-1)!;
    const verified = scene(['verify', tracePath, '--junit', `${outDir}/engines/verify-${tracePath.split('/').at(-2)}.xml`]);
    const hashLine = verified.out.split('\n').find((line) => line.includes('event-hash'))?.trim() ?? '';
    record(`${engine.name} · verify 重算哈希`, verified.code === 0, hashLine || verified.out.trim());
    if (engine.baseline) {
      const diff = scene(['diff', tracePath, engine.baseline]);
      record(`${engine.name} · diff 对齐基线`, diff.code === 0, diff.out.trim().split('\n').at(-1) ?? '');
    }
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────
const failed = steps.filter((step) => !step.ok);
console.log(`\n证据落在 ./${outDir}/（trace / report.html / junit.xml）`);
console.log(`${steps.length - failed.length}/${steps.length} 通过${failed.length > 0 ? ` · 失败：${failed.map((step) => step.name).join('、')}` : ''}`);
process.exit(failed.length > 0 ? 1 : 0);
