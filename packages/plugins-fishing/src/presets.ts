/**
 * 台钓调钓预设库 —— 纯数据，不含计算。
 *
 * 预设回答的是"新手第一竿该从哪开始"：给定常见的调钓组合（调四钓二等），
 * 附上适用鱼情说明。`t0` 是按"双钩压目 = 2"估的无钩调目，真实值以向导实测为准——
 * 预设给的是起点，不是真理。
 */

export interface TaidiaoPreset {
  readonly id: string;
  readonly label: string;
  /** 带钩半水调目。 */
  readonly t: number;
  /** 目标钓目。 */
  readonly d: number;
  /** 建议的单饵压目。 */
  readonly w: number;
  /** 按"双钩压目 ≈ 2"估算的无钩调目，仅作向导第 1 步的参考值。 */
  readonly t0Estimate: number;
  /** 适用鱼情。 */
  readonly note: string;
  readonly targetFish: string;
}

export const TAIDIAO_PRESETS: readonly TaidiaoPreset[] = [
  {
    id: 'diao4-diao2',
    label: '调四钓二',
    t: 4,
    d: 2,
    w: 1,
    t0Estimate: 6,
    note: '最经典的底钓起点：不灵不钝偏灵，鲫鲤都吃，不知道怎么调就先用它。',
    targetFish: '鲫鱼',
  },
  {
    id: 'diao5-diao3',
    label: '调五钓三',
    t: 5,
    d: 3,
    w: 1,
    t0Estimate: 7,
    note: '漂大一号或饵稍重时的等价组合，信号幅度更明显，适合看得懂口的进阶阶段。',
    targetFish: '鲫鱼',
  },
  {
    id: 'diao3-diao1',
    label: '调三钓一',
    t: 3,
    d: 1,
    w: 0.8,
    t0Estimate: 5,
    note: '偏灵：轻口鱼、冬季口弱时用，代价是空竿会变多。',
    targetFish: '轻口鲫鱼',
  },
  {
    id: 'ping-shui-diao2',
    label: '调平水钓二',
    t: 0,
    d: 2,
    w: 1,
    t0Estimate: 2,
    note: '明显偏钝：走水、小杂鱼闹窝、或想死守底部时用，出口多为稳黑漂。',
    targetFish: '鲤鱼',
  },
];

export function presetById(id: string): TaidiaoPreset | undefined {
  return TAIDIAO_PRESETS.find((preset) => preset.id === id);
}
