import type { EvalCase, EvalResult, EvalRun } from '@twin-platform/scene-spec';

export type EvalCheck<Id extends string | number> = () => EvalResult<Id>;

/** evals.json 是用户故事清单，checks 是可执行事实；两者按 id 对齐，缺函数即失败。 */
export function runEvalCases<Id extends string | number>(
  cases: readonly EvalCase<Id>[],
  checks: Readonly<Record<Id, EvalCheck<Id>>>,
): EvalRun<Id> {
  const results = cases.map((item): EvalResult<Id> => {
    const check = checks[item.id];
    if (!check) return { id: item.id, pass: false, detail: `缺少检查函数（id=${String(item.id)}）` };
    try {
      const result = check();
      // 清单 id 是配对真相；检查函数返回错 id 时不允许悄悄错位。
      return { ...result, id: item.id };
    } catch (error) {
      return { id: item.id, pass: false, detail: `检查抛错：${error instanceof Error ? error.message : String(error)}` };
    }
  });
  const passed = results.filter((result) => result.pass).length;
  return { results, passed, total: results.length, ok: passed === results.length };
}
