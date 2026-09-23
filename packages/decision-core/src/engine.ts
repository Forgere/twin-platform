import { hashState } from './hash';
import { DecisionLog } from './log';
import type { DecisionDomain } from './ports';
import type { DecisionRecord, DecisionState, JudgeContext } from './types';

export interface DecideOptions {
  /** 逻辑时间，由调用方注入；内核禁止读挂钟。 */
  readonly at?: number;
  readonly context?: Omit<Partial<JudgeContext>, 'now'>;
}

/**
 * 决策循环。
 *
 *   state -> Judge -> Policy -> (接受 | 降级) -> DecisionLog
 *
 * 内核只做搬运与把关：判断在 Judge 里，合法性在 Policy 里，结果落进日志。
 * 全程同步语义（Judge 可以是 async 以容纳 Jev），但给定同一 Judge 与同一
 * 输入必须逐位可复现。
 */
export class DecisionEngine<S extends DecisionState, A extends string = string> {
  private readonly domain: DecisionDomain<S, A>;
  private readonly log: DecisionLog<A>;

  constructor(domain: DecisionDomain<S, A>, log: DecisionLog<A> = new DecisionLog<A>()) {
    this.domain = domain;
    this.log = log;
  }

  get decisionLog(): DecisionLog<A> {
    return this.log;
  }

  async decide(state: S, options: DecideOptions = {}): Promise<DecisionRecord<A>> {
    const at = options.at ?? 0;
    const context: JudgeContext = { now: at, ...options.context };
    const proposed = await this.domain.judge.judge(state, context);
    const verdict = this.domain.policy.validate(state, proposed);
    const stateHash = hashState(state);

    if (verdict.ok) {
      return this.log.append({ at, stateHash, decision: verdict.decision, accepted: true });
    }
    const fallback = this.domain.fallback(state, verdict.reasonCode);
    return this.log.append({ at, stateHash, decision: fallback, accepted: false, degradeReason: verdict.reasonCode });
  }
}
