/**
 * 漂语 Fishing Core —— 台钓调钓的确定性计算。
 *
 * 纯函数、无 UI、无网络、无模型。它回答的是"现在钓得有多灵/多钝、钩饵处于
 * 什么受力状态"，不回答"下一步该怎么调"——那是 Judge 的事。
 *
 * 单位约定：t0 / t / d 是漂尾目数，w 是"单饵压目数"（不是克）。
 */

export interface TaidiaoInput {
  /** 无钩调目。 */
  readonly t0: number;
  /** 带钩调目。 */
  readonly t: number;
  /** 单饵压目。 */
  readonly w: number;
  /** 当前钓目。 */
  readonly d: number;
}

export type RigIssueCode =
  | 'NOT_FINITE'
  | 'NO_HOOK_MARK_NOT_POSITIVE'
  | 'HOOK_MARK_NOT_BELOW_NO_HOOK'
  | 'BAIT_WEIGHT_NOT_POSITIVE'
  | 'CAST_MARK_NEGATIVE';

export interface RigIssue {
  readonly code: RigIssueCode;
  readonly field: 't0' | 't' | 'w' | 'd';
  readonly message: string;
}

/** 灵钝分区。 */
export type RigZone = 'off_bottom' | 'sensitive' | 'neutral' | 'blunt' | 'sinker_on_bottom';

/** 双钩状态。 */
export type HookState = 'suspended' | 'lower_touching' | 'lower_on_bottom' | 'sinker';

/** 双饵状态。 */
export type BaitState = 'suspended' | 'lower_touching' | 'lower_settled' | 'both_settled';

/** 底承重 B 的分解：下饵 / 下钩 / 上饵 / 上钩 各被底托住多少（同单位：目）。 */
export interface RigLoads {
  readonly lowerBait: number;
  readonly lowerHook: number;
  readonly upperBait: number;
  readonly upperHook: number;
}

export interface RigState {
  readonly t0: number;
  readonly t: number;
  readonly w: number;
  readonly d: number;
  /** 双钩压目。 */
  readonly H: number;
  /** 单钩压目。 */
  readonly hw: number;
  readonly criticalMarks: { readonly d1: number; readonly d2: number; readonly d3: number };
  readonly span: number;
  /** 底承重 B。 */
  readonly bottomLoad: number;
  readonly zone: RigZone;
  readonly loads: RigLoads;
  readonly hookState: HookState;
  readonly baitState: BaitState;
  readonly adjustableRange: { readonly min: number; readonly max: number };
}

export type RigResult =
  | { readonly ok: true; readonly state: RigState }
  | { readonly ok: false; readonly issues: readonly RigIssue[] };

const EPSILON = 1e-9;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

function validate(input: TaidiaoInput): RigIssue[] {
  const issues: RigIssue[] = [];
  const fields: readonly { field: RigIssue['field']; value: number }[] = [
    { field: 't0', value: input.t0 },
    { field: 't', value: input.t },
    { field: 'w', value: input.w },
    { field: 'd', value: input.d },
  ];
  for (const item of fields) {
    if (!Number.isFinite(item.value)) {
      issues.push({ code: 'NOT_FINITE', field: item.field, message: '必须是有限数值。' });
    }
  }
  if (issues.length > 0) return issues;

  if (input.t0 <= 0) {
    issues.push({ code: 'NO_HOOK_MARK_NOT_POSITIVE', field: 't0', message: '无钩调目必须大于 0。' });
  }
  if (input.t >= input.t0) {
    issues.push({ code: 'HOOK_MARK_NOT_BELOW_NO_HOOK', field: 't', message: '带钩调目必须小于无钩调目（钩有重量）。' });
  }
  if (input.w <= 0) {
    issues.push({ code: 'BAIT_WEIGHT_NOT_POSITIVE', field: 'w', message: '单饵压目必须大于 0。' });
  }
  if (input.d < 0) {
    issues.push({ code: 'CAST_MARK_NEGATIVE', field: 'd', message: '钓目不能为负。' });
  }
  return issues;
}

/**
 * 灵钝分区。
 *
 *   B <= 0                     未到底
 *   0 < B < hw + w             灵区
 *   B = hw + w                 不灵不钝（下钩饵全着底、上钩饵全悬）
 *   hw + w < B < H + 2w        钝区
 *   B >= H + 2w                铅坠触底
 */
function zoneOf(bottomLoad: number, hw: number, w: number, H: number): RigZone {
  if (bottomLoad <= EPSILON) return 'off_bottom';
  const neutral = hw + w;
  const max = H + 2 * w;
  if (Math.abs(bottomLoad - neutral) <= EPSILON) return 'neutral';
  if (bottomLoad < neutral) return 'sensitive';
  if (bottomLoad < max - EPSILON) return 'blunt';
  return 'sinker_on_bottom';
}

function loadsOf(bottomLoad: number, w: number, hw: number): RigLoads {
  return {
    lowerBait: clamp(bottomLoad, 0, w),
    lowerHook: clamp(bottomLoad - w, 0, hw),
    upperBait: clamp(bottomLoad - w - hw, 0, w),
    upperHook: clamp(bottomLoad - w - hw - w, 0, hw),
  };
}

function hookStateOf(bottomLoad: number, w: number, hw: number, H: number): HookState {
  if (bottomLoad >= H + 2 * w - EPSILON) return 'sinker';
  if (bottomLoad >= w + hw - EPSILON) return 'lower_on_bottom';
  if (bottomLoad > EPSILON) return 'lower_touching';
  return 'suspended';
}

function baitStateOf(bottomLoad: number, w: number, hw: number): BaitState {
  if (bottomLoad >= 2 * w + hw - EPSILON) return 'both_settled';
  if (bottomLoad >= w - EPSILON) return 'lower_settled';
  if (bottomLoad > EPSILON) return 'lower_touching';
  return 'suspended';
}

/**
 * 调钓计算与状态判断。
 *
 *   H  = t0 - t
 *   hw = H / 2
 *   d1 = t - 2w          （B = 0，双饵离底临界）
 *   d2 = t - w + hw      （B = hw + w，不灵不钝）
 *   d3 = t0              （B = H + 2w，铅坠触底）
 *   B  = d + 2w - t
 *
 * 参数不合法时返回 issues，不抛异常——这些是用户输入，不是程序错误。
 */
export function calculateRigState(input: TaidiaoInput): RigResult {
  const issues = validate(input);
  if (issues.length > 0) return { ok: false, issues };

  const H = input.t0 - input.t;
  const hw = H / 2;
  const d1 = input.t - 2 * input.w;
  const d2 = input.t - input.w + hw;
  const d3 = input.t0;
  const bottomLoad = input.d + 2 * input.w - input.t;
  const zone = zoneOf(bottomLoad, hw, input.w, H);

  return {
    ok: true,
    state: {
      t0: input.t0,
      t: input.t,
      w: input.w,
      d: input.d,
      H,
      hw,
      criticalMarks: { d1, d2, d3 },
      span: d3 - d1,
      bottomLoad,
      zone,
      loads: loadsOf(bottomLoad, input.w, hw),
      hookState: hookStateOf(bottomLoad, input.w, hw, H),
      baitState: baitStateOf(bottomLoad, input.w, hw),
      adjustableRange: { min: d1, max: d3 },
    },
  };
}
