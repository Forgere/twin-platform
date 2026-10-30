import type { DecisionRecord, Outcome } from './types';

export interface SerializedDecisionLog<A extends string = string> {
  readonly version: 1;
  readonly records: readonly DecisionRecord<A>[];
}

/**
 * 决策日志：每次判断的落库位点。
 *
 * 它同时是评测数据集的载体——决策 + 状态指纹 + 事后观测，缺一样都回答不了
 * "这次调整到底管不管用"。id 用递增计数器而不是随机数，保证同种子可回放。
 */
export class DecisionLog<A extends string = string> {
  private readonly records: DecisionRecord<A>[] = [];
  private counter = 0;
  private readonly prefix: string;

  constructor(prefix = 'd') {
    this.prefix = prefix;
  }

  append(input: Omit<DecisionRecord<A>, 'id'>): DecisionRecord<A> {
    this.counter += 1;
    const record: DecisionRecord<A> = { ...input, id: this.prefix + this.counter };
    this.records.push(record);
    return record;
  }

  all(): readonly DecisionRecord<A>[] {
    return this.records;
  }

  get size(): number {
    return this.records.length;
  }

  find(id: string): DecisionRecord<A> | undefined {
    return this.records.find((record) => record.id === id);
  }

  attachOutcome(id: string, outcome: Outcome): boolean {
    const record = this.find(id);
    if (!record) return false;
    record.outcome = outcome;
    return true;
  }

  attachScore(id: string, score: number): boolean {
    const record = this.find(id);
    if (!record) return false;
    record.score = score;
    return true;
  }

  toJSON(): SerializedDecisionLog<A> {
    return { version: 1, records: this.records };
  }

  static fromJSON<T extends string>(data: SerializedDecisionLog<T>): DecisionLog<T> {
    const log = new DecisionLog<T>();
    for (const record of data.records) {
      log.records.push(record);
      const numeric = Number(record.id.replace(/^[A-Za-z]+/, ''));
      if (Number.isFinite(numeric) && numeric > log.counter) log.counter = numeric;
    }
    return log;
  }
}
