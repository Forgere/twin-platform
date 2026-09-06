/**
 * 可注入的确定性随机源。
 *
 * 内核里任何"随机"都必须从这里取：仿真一跑就是几十万帧，只要有一处用了
 * `Math.random()`，同种子重放就会对不上，回放、对比方案、回归测试全部失效。
 *
 * 算法用 mulberry32：单 uint32 状态，状态可导出（快照/恢复需要），
 * 速度快，周期对仿真足够长。
 */

export interface Rng {
  readonly seed: number;
  /** [0, 1) */
  next(): number;
  /** [0, maxExclusive) 的整数。 */
  int(maxExclusive: number): number;
  /** [min, max) 的浮点数。 */
  range(min: number, max: number): number;
  bool(probability: number): boolean;
  /** 等概率取一个元素。 */
  pick<T>(items: readonly T[]): T;
  /** 按权重取一个元素，权重可以为 0，全 0 时退化为等概率。 */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T;
  /** 当前内部状态，用于快照与恢复。 */
  getState(): number;
  setState(state: number): void;
}

/** 在 `noUncheckedIndexedAccess` 下安全地按下标取值。 */
const at = <T,>(items: readonly T[], index: number): T => {
  const value = items[index];
  if (value === undefined) throw new Error('随机取值越界。');
  return value;
};

export function createRng(seed: number): Rng {
  if (!Number.isFinite(seed)) throw new Error('seed 必须是有限数字。');
  let state = Math.floor(seed) >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    seed,
    next,
    int(maxExclusive) {
      if (maxExclusive <= 0) throw new Error('int(maxExclusive) 需要正数上界。');
      return Math.floor(next() * maxExclusive);
    },
    range(min, max) {
      return min + next() * (max - min);
    },
    bool(probability) {
      return next() < probability;
    },
    pick(items) {
      if (items.length === 0) throw new Error('pick() 需要非空数组。');
      return at(items, Math.floor(next() * items.length));
    },
    weighted(items, weight) {
      if (items.length === 0) throw new Error('weighted() 需要非空数组。');
      let total = 0;
      for (const item of items) total += Math.max(0, weight(item));
      if (total <= 0) return rng.pick(items);
      let roll = next() * total;
      for (const item of items) {
        roll -= Math.max(0, weight(item));
        if (roll < 0) return item;
      }
      return at(items, items.length - 1);
    },
    getState() {
      return state;
    },
    setState(nextState) {
      state = Math.floor(nextState) >>> 0;
    },
  };

  return rng;
}
