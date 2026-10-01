import type { RigState, RigZone } from './fishingCore';

/**
 * 漂语线组姿态（rigPosture）—— 回答"这副钓组现在长什么样、每个零件什么状态"。
 *
 * 与 `fishingCore` 的分工：
 * - fishingCore 算**力**（底承重 B、灵钝分区、钩饵受力分解）；
 - 这里算**形与状态**（谁悬着、谁躺底、子线弯不弯、漂露出几目、什么漂相）。
 *
 * 两条铁律：
 * 1. **连接关系是唯一真相**：`RIG_LINKS` 就是台钓线组的真实拓扑——主线从竿梢
 *    一路穿过漂座、铅皮座到 8 字环，**8 字环分出两根并联子线**分别到上钩与下钩
 *    （不是"上钩挂下钩"的串联，也不是铅坠直接接钩）。2D 剖面与 3D 场景都读它，
 *    不再各画一套。
 * 2. 纯函数：输入 RigState + 环境（走水 / 漂相），输出完整状态表，可回放可测。
 */

/** 线组部件，自上而下。 */
export type RigPartId =
  | 'rodTip'
  | 'float'
  | 'sinker'
  | 'swivel'
  | 'hookUpper'
  | 'hookLower'
  | 'baitUpper'
  | 'baitLower';

/** 主线（大线）与子线（脑线）。 */
export type RigLineKind = 'main' | 'branch';

export interface RigLink {
  readonly from: RigPartId;
  readonly to: RigPartId;
  readonly kind: RigLineKind;
  readonly label: string;
}

/**
 * 线组连接关系（唯一真相）。
 *
 *   竿梢 ─ 主线 ─ 漂座（浮漂套在主线上，不是端点）
 *              ─ 铅皮座
 *              ─ 8 字环 ─┬─ 短子线 ─ 上钩 + 上饵
 *                       └─ 长子线 ─ 下钩 + 下饵
 *
 * 上下钩是**并联**的：钩距 = 长子线 − 短子线，两者之间没有线。
 */
export const RIG_LINKS: readonly RigLink[] = [
  { from: 'rodTip', to: 'float', kind: 'main', label: '主线：竿梢 → 漂座' },
  { from: 'float', to: 'sinker', kind: 'main', label: '主线：漂座 → 铅皮座' },
  { from: 'sinker', to: 'swivel', kind: 'main', label: '主线：铅皮座 → 8 字环' },
  { from: 'swivel', to: 'hookUpper', kind: 'branch', label: '短子线 → 上钩' },
  { from: 'swivel', to: 'hookLower', kind: 'branch', label: '长子线 → 下钩' },
];

/** 部件与"底"的关系。 */
export type ContactState = 'suspended' | 'touching' | 'on_bottom';

/** 子线形态：绷直 / 松弛起弯 / 弯曲躺底。 */
export type SubLineState = 'straight' | 'sagging' | 'lying';

/** 漂相：用户唯一能直接看到的信号。 */
export type FloatSignal = 'none' | 'nod' | 'lift' | 'sink' | 'run';

export const SIGNAL_LABEL: Readonly<Record<FloatSignal, string>> = {
  none: '无信号',
  nod: '顿口（下顿）',
  lift: '送漂（上顶）',
  sink: '黑漂（没入）',
  run: '移漂（走漂）',
};

/** 状态表里每一行的语义码（UI 据此配色，测试据此断言）。 */
export type PartStatusCode =
  | 'fixed'
  | 'balanced'
  | 'submerged'
  | 'drifting'
  | 'taut'
  | 'tilted'
  | ContactState
  | SubLineState;

export interface PartPosture {
  readonly part: RigPartId;
  /** 中文名。 */
  readonly label: string;
  readonly code: PartStatusCode;
  /** 给人类读的一句话状态。 */
  readonly text: string;
}

export interface SubLinePosture {
  readonly state: SubLineState;
  /** 弯曲量 0~1：0 = 绷直，1 = 完全松弯（信号传不上来）。 */
  readonly bend: number;
  readonly text: string;
}

export interface RigPosture {
  readonly zone: RigZone;
  /** 浮漂：露出几目 / 什么姿态 / 什么漂相。 */
  readonly float: {
    readonly visibleMarks: number;
    readonly code: PartStatusCode;
    readonly signal: FloatSignal;
    /** 走水时被主线拉斜的角度（度）。 */
    readonly tiltDeg: number;
    readonly text: string;
  };
  /** 主线：绷直 / 被走水拉斜。 */
  readonly mainLine: { readonly code: 'taut' | 'tilted'; readonly tiltDeg: number; readonly text: string };
  /** 铅坠：悬坠（台钓的常态）/ 接近底 / 躺底（走铅）。 */
  readonly sinker: { readonly code: ContactState; readonly text: string };
  readonly subLineUpper: SubLinePosture;
  readonly subLineLower: SubLinePosture;
  /** 自上而下的逐部件状态，直接给 UI 列表用。 */
  readonly parts: readonly PartPosture[];
  /** 一句话总结，给面板标题用。 */
  readonly summary: string;
}

const EPSILON = 1e-9;
const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/**
 * 子线弯曲量。
 *
 * 力的分配顺序是"先托下饵 → 再托下钩 → 再上饵 → 再上钩"（见 fishingCore.loads）。
 * 底承重超过"下钩饵刚好全部到底"（B = hw + w）之后，多出来的重量不再把钩往下拽
 * （钩已经在底上了），而是让 8 字环继续下沉——**子线因此松弛起弯**，信号传不上
 * 来，这正是"钝"的物理含义。
 */
export function subLineBend(state: RigState, which: 'upper' | 'lower'): number {
  const w = state.w;
  const hw = state.hw;
  const neutral = which === 'lower' ? hw + w : 2 * w + hw; // 下钩饵 / 上饵各自"刚好到底"的 B
  const max = state.H + 2 * w; // 铅坠触底
  const span = max - neutral;
  if (span <= EPSILON) return 0;
  return clamp01((state.bottomLoad - neutral) / span);
}

function subLineStateOf(bend: number): SubLineState {
  if (bend <= 0.02) return 'straight';
  if (bend < 0.55) return 'sagging';
  return 'lying';
}

const SUBLINE_TEXT: Readonly<Record<SubLineState, string>> = {
  straight: '绷直（信号直达）',
  sagging: '松弛起弯（信号衰减）',
  lying: '弯曲躺底（信号基本传不上来）',
};

/** 部件与底的关系：B 越过阈值前是"触"，越过后是"躺"。 */
function contactOf(load: number, full: number): ContactState {
  if (load >= full - EPSILON) return 'on_bottom';
  if (load > EPSILON) return 'touching';
  return 'suspended';
}

const CONTACT_TEXT: Readonly<Record<ContactState, string>> = {
  suspended: '悬在水中',
  touching: '轻触底',
  on_bottom: '躺底',
};

const PART_LABEL: Readonly<Record<RigPartId, string>> = {
  rodTip: '竿梢',
  float: '浮漂',
  sinker: '铅坠',
  swivel: '8 字环',
  hookUpper: '上钩',
  hookLower: '下钩',
  baitUpper: '上饵',
  baitLower: '下饵',
};

/** 从钩自身的承重判断触底，不把先触底的饵当成钩，也不把灵钝方向当状态。 */
export function hookBottomState(state: RigState): { code: string; label: string; detail: string } {
  const lower = contactOf(state.loads.lowerHook, state.hw);
  const upper = contactOf(state.loads.upperHook, state.hw);
  if (state.bottomLoad >= state.H + 2 * state.w - EPSILON) {
    return { code: 'sinker_on_bottom', label: '双钩躺底 · 铅坠触底', detail: '双钩躺底，铅坠也已触底' };
  }
  if (upper === 'on_bottom') return { code: 'both_on_bottom', label: '双钩躺底', detail: '上下钩均由水底承托' };
  if (upper === 'touching') return { code: 'lower_lying_upper_touching', label: '一钩躺底、一钩触底', detail: '下钩躺底，上钩轻触底' };
  if (lower === 'on_bottom') return { code: 'single_on_bottom', label: '单钩触底', detail: '下钩落底，上钩仍悬浮' };
  if (lower === 'touching') return { code: 'single_touching', label: '单钩轻微触底', detail: '水底承担部分下钩重量，上钩仍悬浮' };
  if (state.loads.lowerBait > EPSILON) return { code: 'bait_touching', label: '下饵触底 · 双钩悬浮', detail: '下饵已触底，但上下钩仍悬浮' };
  return { code: 'suspended', label: '双钩悬浮', detail: '双钩双饵均离底' };
}

export interface PostureEnvironment {
  /** 走水：主线被水流拉斜、漂走位。 */
  readonly drift?: boolean;
  /** 当前漂相（咬钩那一口是什么口）。 */
  readonly signal?: FloatSignal;
}

/**
 * 由调钓状态算姿态。纯函数，无随机、无 IO。
 */
export function rigPosture(state: RigState, env: PostureEnvironment = {}): RigPosture {
  const drift = env.drift === true;
  const signal: FloatSignal = env.signal ?? 'none';

  const bendUpper = subLineBend(state, 'upper');
  const bendLower = subLineBend(state, 'lower');
  const upperState = subLineStateOf(bendUpper);
  const lowerState = subLineStateOf(bendLower);

  // 漂：露出 d 目；有漂相时优先表达漂相（这是用户当下看到的动作）。
  const visibleMarks = state.d;
  const floatCode: PartStatusCode = drift && signal === 'none'
    ? 'drifting'
    : signal === 'sink'
      ? 'submerged'
      : signal === 'none'
        ? 'balanced'
        : 'tilted';
  const floatText =
    signal === 'sink'
      ? '黑漂：整支没入水中'
      : signal === 'nod'
        ? '顿口：有力下顿约 1 目'
        : signal === 'lift'
          ? '送漂：上顶'
          : signal === 'run'
            ? '移漂：横向走位'
            : drift
              ? '露出 ' + visibleMarks + ' 目（走水拉斜）'
              : '露出 ' + visibleMarks + ' 目';

  const tiltDeg = drift ? (signal === 'none' ? 14 : 8) : 0;

  const sinkerCode = contactOf(state.bottomLoad, state.H + 2 * state.w);
  const sinkerText = sinkerCode === 'on_bottom' ? '躺底（走铅）' : sinkerCode === 'touching' ? '接近水底' : '悬坠（离底）';

  const parts: PartPosture[] = ([
    { part: 'rodTip', label: PART_LABEL.rodTip, code: 'fixed', text: '主线起点' },
    { part: 'float', label: PART_LABEL.float, code: floatCode, text: floatText },
    {
      part: 'sinker',
      label: PART_LABEL.sinker,
      code: sinkerCode,
      text: sinkerCode === 'on_bottom' ? '躺底（走铅）' : sinkerCode === 'touching' ? '接近水底' : '悬坠（离底）',
    },
    { part: 'swivel', label: PART_LABEL.swivel, code: 'fixed', text: '主线与两根子线的分叉点' },
    { part: 'hookUpper', label: PART_LABEL.hookUpper, code: contactOf(state.loads.upperHook, state.hw), text: '' },
    { part: 'baitUpper', label: PART_LABEL.baitUpper, code: contactOf(state.loads.upperBait, state.w), text: '' },
    { part: 'hookLower', label: PART_LABEL.hookLower, code: contactOf(state.loads.lowerHook, state.hw), text: '' },
    { part: 'baitLower', label: PART_LABEL.baitLower, code: contactOf(state.loads.lowerBait, state.w), text: '' },
  ] as PartPosture[]).map((part) => ({ ...part, text: part.text || CONTACT_TEXT[part.code as ContactState] }));

  const summary = hookBottomState(state).detail + '；长子线' + SUBLINE_TEXT[lowerState];

  return {
    zone: state.zone,
    float: { visibleMarks, code: floatCode, signal, tiltDeg, text: floatText },
    mainLine: {
      code: drift ? 'tilted' : 'taut',
      tiltDeg,
      text: drift ? '被水流拉斜 ' + tiltDeg + '°（走水）' : '绷直垂直',
    },
    sinker: { code: sinkerCode, text: sinkerText },
    subLineUpper: { state: upperState, bend: bendUpper, text: SUBLINE_TEXT[upperState] },
    subLineLower: { state: lowerState, bend: bendLower, text: SUBLINE_TEXT[lowerState] },
    parts,
    summary,
  };
}

/** 咬钩漂相的候选（鱼口模型里由 rng 等概率取一个）。 */
export const BITE_SIGNALS: readonly FloatSignal[] = ['nod', 'lift', 'sink'];
