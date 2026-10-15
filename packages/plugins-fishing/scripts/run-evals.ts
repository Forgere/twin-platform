import { readFileSync } from 'node:fs';
import { CHECKS, type EvalResult } from '../evals/checks.ts';

/**
 * fish evals 跑分器（借鉴 machine-skill 的 evals/evals.json + 审查纪律）。
 *
 *   bun run packages/plugins-fishing/scripts/run-evals.ts
 *
 * 每条 eval 打印：编号、prompt、PASS/FAIL、关键数字。
 * 全部通过退出码 0，有失败退出码 1——可以直接挂 CI。
 * 数字是给**人**看的：machine-skill 的要求是"拿模型输出对照公开数据"，
 * 这里对照的是模型自己的声称（不灵不钝最好、走水加铅恢复、漂相随状态……），
 * 方向错了比数值错了更严重，所以断言都是方向 + 量级。
 */

interface EvalCase {
  readonly id: number;
  readonly prompt: string;
  readonly expected_output: string;
}

const evalsPath = new URL('../evals/evals.json', import.meta.url);
const { evals }: { readonly evals: readonly EvalCase[] } = JSON.parse(readFileSync(evalsPath, 'utf-8'));

const results: EvalResult[] = evals.map((item) => {
  const check = CHECKS[item.id];
  if (!check) return { id: item.id, pass: false, detail: `缺少检查函数（evals/checks.ts 没有 id=${item.id}）` };
  try {
    return check();
  } catch (error) {
    return { id: item.id, pass: false, detail: `检查抛错：${error instanceof Error ? error.message : String(error)}` };
  }
});

const width = Math.max(...results.map((item) => item.detail.length), 40);
for (const item of evals) {
  const result = results.find((candidate) => candidate.id === item.id)!;
  const mark = result.pass ? 'PASS' : 'FAIL';
  console.log(`\n[${mark}] #${item.id} ${item.prompt}`);
  console.log(`  期望：${item.expected_output}`);
  console.log(`  实测：${result.detail}`);
  void width;
}

const passed = results.filter((item) => item.pass).length;
console.log(`\n${'─'.repeat(72)}`);
console.log(`evals: ${passed}/${results.length} 通过`);
if (passed !== results.length) {
  console.log('有 eval 未通过——模型行为与声称不一致，先修模型或修期望，别放过。');
  process.exit(1);
}
