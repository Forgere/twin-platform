import type {
  ActionDescriptor,
  Decision,
  DecisionRecord,
  DecisionState,
  DecisionVerdict,
  JudgeContext,
  Outcome,
} from './types';

/**
 * 决策内核的四个端口。领域只实现端口，不碰内核。
 *
 *   Judge      我应该怎么判断（规则 / Jev / 求解器，同端口可替换）
 *   Policy     判断是否合法（封闭动作空间 + 值域校验）
 *   Environment 这么做会发生什么（仿真 / 真实记录）
 *   Executor   真正执行（发建议给用户 / 调 MCP）
 *
 * MCP 不是内核的依赖：它只是 Executor 或 Environment 背后的一种传输。
 */
export interface Judge<S extends DecisionState, A extends string = string> {
  readonly id: string;
  judge(state: S, context: JudgeContext): Promise<Decision<A>> | Decision<A>;
}

export interface Policy<S extends DecisionState, A extends string = string> {
  readonly id: string;
  validate(state: S, decision: Decision<A>): DecisionVerdict<A>;
}

export interface Evaluator<A extends string = string> {
  readonly id: string;
  score(record: DecisionRecord<A>): number | undefined;
}

/** 一个领域的完整装配：动作空间 + 判断 + 策略 + 评分 + 降级动作。 */
export interface DecisionDomain<S extends DecisionState, A extends string = string> {
  readonly id: string;
  readonly actions: readonly ActionDescriptor<A>[];
  readonly judge: Judge<S, A>;
  readonly policy: Policy<S, A>;
  readonly evaluator?: Evaluator<A>;
  /** 判断未过策略时使用；返回的动作必须属于本域动作空间。 */
  fallback(state: S, reasonCode: string): Decision<A>;
}

export interface Environment<S extends DecisionState, A extends string = string> {
  observe(): S;
  step(decision: Decision<A>): Outcome;
}

export interface Executor<A extends string = string> {
  execute(record: DecisionRecord<A>): Promise<void> | void;
}
