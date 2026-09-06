/**
 * 固定步长时钟。
 *
 * 渲染帧率会抖（30/60/144Hz、后台标签页掉帧），但仿真不能跟着抖：只要
 * `dt` 不固定，浮点累加顺序就会变，同种子重放就会漂。所以外部传真实
 * delta，时钟把它切成整数个固定步长，内核只在步长时间点上推进。
 */

export interface FixedStepClockOptions {
  /** 固定步长（秒）。默认 1/60。 */
  step?: number;
  /**
   * 单次 `advance` 最多补多少步。卡顿后一次性补几千步会雪崩，
   * 超出部分直接丢弃（宁可慢放，不卡死主线程）。
   */
  maxStepsPerAdvance?: number;
}

/**
 * 浮点容差（秒）。
 *
 * 累加余量时 `0.25 - 0.2` 会得到 `0.04999999999999999`，再补一个 0.05 的短帧
 * 就会差一点点凑不满一步、白白丢一帧。1 纳秒级别的误差对仿真毫无意义，
 * 但对"同输入必须同步数"是致命的，所以判定时统一加一个极小容差。
 */
const STEP_EPSILON = 1e-9;

export class FixedStepClock {
  readonly step: number;
  private readonly maxSteps: number;
  private currentTime = 0;
  private carried = 0;
  private steps = 0;

  constructor(options: FixedStepClockOptions = {}) {
    const step = options.step ?? 1 / 60;
    if (!Number.isFinite(step) || step <= 0) throw new Error('固定步长必须是正数。');
    this.step = step;
    this.maxSteps = options.maxStepsPerAdvance ?? 8;
  }

  get time(): number {
    return this.currentTime;
  }

  /** 已经走过的整数步数。回放置换用 `step × steps` 比对更稳。 */
  get stepCount(): number {
    return this.steps;
  }

  /** 未消耗的余量占一个步长的比例，供渲染层做插值。 */
  get alpha(): number {
    return this.carried / this.step;
  }

  /** 吃掉真实 delta，返回本次应该执行的步数。 */
  advance(realDelta: number): number {
    if (!Number.isFinite(realDelta) || realDelta < 0) throw new Error('realDelta 必须是非负有限数字。');
    this.carried += realDelta;
    let count = Math.floor((this.carried + STEP_EPSILON) / this.step);
    if (count > this.maxSteps) {
      count = this.maxSteps;
      this.carried = 0;
    } else {
      this.carried = Math.max(0, this.carried - count * this.step);
    }
    return count;
  }

  /** 推进一个固定步长。 */
  tick(): void {
    this.currentTime += this.step;
    this.steps += 1;
  }

  reset(): void {
    this.currentTime = 0;
    this.carried = 0;
    this.steps = 0;
  }
}
