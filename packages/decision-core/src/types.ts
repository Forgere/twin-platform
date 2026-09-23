/**
 * 决策内核的公共类型。
 *
 * 这些类型不认识"台钓"，也不认识"工厂"——领域语义全部由插件的 DecisionDomain
 * 提供。内核只保证三件事：判断可替换、动作可校验、过程可回放。
 */

/** 领域状态：由 Environment 观测得到，必须可序列化。 */
export interface DecisionState {
  readonly kind: string;
}

/** 动作参数的值域声明。封闭枚举优先，数值必须给出上下界。 */
export interface ActionParamSpec {
  readonly name: string;
  readonly kind: 'enum' | 'number';
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly optional?: boolean;
}

/** 动作描述符：插件用它声明"这个域允许哪些动作、每个动作带哪些参数"。 */
export interface ActionDescriptor<A extends string = string> {
  readonly id: A;
  readonly label: string;
  /** 可逆动作优先——不可逆动作必须显式标出来。 */
  readonly reversible: boolean;
  readonly params: readonly ActionParamSpec[];
}

/**
 * 一次判断的完整结果。规则、Jev、求解器都只允许产出这个结构。
 *
 * 没有自然语言字段：解释文案由解释层根据 action / reasonCode 生成，
 * 这样判断可以被校验、被替换、被统计。
 */
export interface Decision<A extends string = string> {
  readonly action: A;
  readonly params: Readonly<Record<string, number | string>>;
  readonly confidence: number;
  readonly reasonCode: string;
  /** 预期会发生什么（评测用，不展示给用户）。 */
  readonly predicted?: Readonly<Record<string, number | string>>;
}

export interface PolicyIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type DecisionVerdict<A extends string = string> =
  | { readonly ok: true; readonly decision: Decision<A> }
  | { readonly ok: false; readonly reasonCode: string; readonly issues: readonly PolicyIssue[] };

/** 执行动作之后观测到的结果。 */
export interface Outcome {
  readonly at: number;
  readonly metrics: Readonly<Record<string, number>>;
  readonly note?: string;
}

/** 用户的一次轻反馈。 */
export interface Feedback {
  readonly decisionId: string;
  readonly useful: boolean;
  readonly at: number;
  readonly note?: string;
}

/** 判断上下文：逻辑时间只能由调用方注入，内核禁止读挂钟。 */
export interface JudgeContext {
  readonly now: number;
  readonly seed?: number;
  readonly feedback?: readonly Feedback[];
  readonly targetFish?: string;
}

/** 决策日志的一条记录：决策 + 状态指纹 + 事后结果。 */
export interface DecisionRecord<A extends string = string> {
  readonly id: string;
  readonly at: number;
  readonly stateHash: string;
  readonly decision: Decision<A>;
  /** false 表示判断未过 Policy，已降级为 fallback。 */
  readonly accepted: boolean;
  readonly degradeReason?: string;
  outcome?: Outcome;
  score?: number;
  /** 用户轻反馈（👍/👎）。和 evaluator 的自动评分并存，评分时用户反馈优先。 */
  feedback?: Feedback;
}
