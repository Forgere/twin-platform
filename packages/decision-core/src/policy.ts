import type { ActionDescriptor, ActionParamSpec, Decision, DecisionVerdict, PolicyIssue } from './types';

const issue = (code: string, path: string, message: string): PolicyIssue => ({ code, path, message });

function checkParam(
  spec: ActionParamSpec,
  value: number | string | undefined,
  path: string,
  issues: PolicyIssue[],
): void {
  if (value === undefined) {
    if (!spec.optional) issues.push(issue('MISSING_PARAM', path, '该参数必填。'));
    return;
  }
  if (spec.kind === 'enum') {
    const options = spec.options ?? [];
    if (typeof value !== 'string' || !options.includes(value)) {
      issues.push(issue('PARAM_NOT_ALLOWED', path, '取值不在允许的枚举内。'));
    }
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(issue('PARAM_NOT_A_NUMBER', path, '必须是有限数值。'));
    return;
  }
  if (spec.min !== undefined && value < spec.min) issues.push(issue('PARAM_OUT_OF_RANGE', path, '低于允许下界。'));
  if (spec.max !== undefined && value > spec.max) issues.push(issue('PARAM_OUT_OF_RANGE', path, '高于允许上界。'));
}

/**
 * 把任意来源（规则、模型、求解器）产出的 Decision 校验到封闭动作空间上。
 *
 * 越界一律拒绝：内核不负责猜测意图，Policy 说不合法就降级。降级动作由
 * 领域通过 DecisionDomain.fallback 提供。
 */
export function validateAgainstActionSpace<A extends string>(
  actions: readonly ActionDescriptor<A>[],
  decision: Decision<A>,
): DecisionVerdict<A> {
  const descriptor = actions.find((item) => item.id === decision.action);
  if (!descriptor) {
    return {
      ok: false,
      reasonCode: 'UNKNOWN_ACTION',
      issues: [issue('UNKNOWN_ACTION', 'action', '动作不在封闭动作空间内。')],
    };
  }

  const issues: PolicyIssue[] = [];
  if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
    issues.push(issue('INVALID_CONFIDENCE', 'confidence', '置信度必须是 0 到 1 之间的有限数值。'));
  }

  const declared = new Set(descriptor.params.map((spec) => spec.name));
  for (const spec of descriptor.params) {
    checkParam(spec, decision.params[spec.name], 'params.' + spec.name, issues);
  }
  for (const name of Object.keys(decision.params)) {
    if (!declared.has(name)) issues.push(issue('UNKNOWN_PARAM', 'params.' + name, '该参数不属于此动作。'));
  }

  if (issues.length > 0) {
    const first = issues[0];
    return { ok: false, reasonCode: first ? first.code : 'INVALID_DECISION', issues };
  }
  return { ok: true, decision: { ...decision, params: { ...decision.params } } };
}
