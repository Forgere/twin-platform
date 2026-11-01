// 故障注入演练：用 CLI 自己跑两遍 mini-line——
//   1) 对黄金基线：必须一致（exit 0），证明门禁不会误报；
//   2) 对被篡改的基线：必须 exit 1，且首个分歧精确落在 injection.json 声明的 pointer。
// 同时把 HTML / JUnit 证据落到 out 目录，可直接当演示材料。
// 用法：bun examples/fault-injection/check.ts [outDir]（默认 .scene-ci/fault-injection）
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const cli = join(repoRoot, 'packages/scene-cli/src/cli.ts');
const outRoot = resolve(repoRoot, process.argv[2] ?? '.scene-ci/fault-injection');

type Injection = { pointer: string; from: string; to: string };
const injection = JSON.parse(readFileSync(join(here, 'injection.json'), 'utf-8')) as Injection;

const replay = (label: string, baseline: string) =>
  spawnSync(
    process.execPath,
    [
      cli,
      'replay',
      '--scene', 'examples/community/mini-line/scene.json',
      '--plugin', 'logistics',
      '--seed', '1',
      '--seconds', '30',
      '--baseline', baseline,
      '--out', join(outRoot, label),
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );

const failures: string[] = [];
const check = (ok: boolean, message: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

const golden = replay('golden', 'examples/community/mini-line/expected/trace.json');
check(golden.status === 0, `黄金基线一致（exit ${golden.status}）`);
check((golden.stdout ?? '').includes('基线一致'), '黄金基线输出「基线一致」');

const tampered = replay('tampered', 'examples/fault-injection/tampered.json');
const tamperedOut = `${tampered.stdout ?? ''}${tampered.stderr ?? ''}`;
check(tampered.status === 1, `篡改基线被拦下（exit ${tampered.status}）`);
check(tamperedOut.includes(`基线分歧：${injection.pointer}`), `首个分歧精确到 ${injection.pointer}`);

for (const label of ['golden', 'tampered']) {
  for (const file of ['trace.json', 'report.html', 'junit.xml']) {
    check(existsSync(join(outRoot, label, file)), `${label}/${file} 已产出`);
  }
}
const html = readFileSync(join(outRoot, 'tampered', 'report.html'), 'utf-8');
check(html.includes(injection.pointer), '篡改报告 HTML 内嵌首个分歧 pointer');
check(html.includes(injection.to), '篡改报告 HTML 显示注入后的值');

if (failures.length > 0) {
  console.error(`\n故障注入演练失败：${failures.length} 项`);
  process.exit(1);
}
console.log(`\n故障注入演练通过：注入 ${injection.pointer}（${injection.from} → ${injection.to}）被抓到，证据在 ${outRoot}`);
