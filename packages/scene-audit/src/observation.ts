export interface ObservationWindowInput {
  readonly observedSeconds: number;
  readonly requiredSeconds: number;
  readonly samples?: number;
  readonly minimumSamples?: number;
}

export interface ObservationWindowAssessment {
  readonly sufficient: boolean;
  readonly warnings: readonly string[];
}

/** 观察窗不足只产生警告，不把“尚未观察到”伪造成“指标没有差异”。 */
export function assessObservationWindow(input: ObservationWindowInput): ObservationWindowAssessment {
  if (!Number.isFinite(input.observedSeconds) || input.observedSeconds < 0) throw new Error('observedSeconds 必须是非负有限数字。');
  if (!Number.isFinite(input.requiredSeconds) || input.requiredSeconds <= 0) throw new Error('requiredSeconds 必须是正有限数字。');
  const warnings: string[] = [];
  if (input.observedSeconds < input.requiredSeconds) {
    warnings.push(`观察窗 ${input.observedSeconds}s 小于要求的 ${input.requiredSeconds}s，当前指标不足以支持结论。`);
  }
  if (input.minimumSamples !== undefined && (input.samples ?? 0) < input.minimumSamples) {
    warnings.push(`样本 ${input.samples ?? 0} 个，少于要求的 ${input.minimumSamples} 个。`);
  }
  return { sufficient: warnings.length === 0, warnings };
}

import { canonicalJson } from '@twin-platform/scene-spec';

export interface SilentChange {
  readonly id: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly changed: boolean;
  readonly declaredNoOp: boolean;
  /** true 表示改动既不生效，也没有显式声明 no-op，应进入审计报告。 */
  readonly suspicious: boolean;
}

/** 动作/旋钮审计：无效果可以接受，但必须显式声明，不能静默。 */
export function inspectSilentChange(
  id: string,
  before: unknown,
  after: unknown,
  declaredNoOp = false,
): SilentChange {
  const changed = canonicalJson(before) !== canonicalJson(after);
  return { id, before, after, changed, declaredNoOp, suspicious: !changed && !declaredNoOp };
}
