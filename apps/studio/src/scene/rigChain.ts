/**
 * 钓组受力链：鱼拖钩 → 子线 → 8 字环 → 铅坠 → 漂。
 *
 * 线**不伸缩**：
 * - 子线在两端之间是一段弧（二次贝塞尔，下垂并向外鼓），弧长 = 静止时的长度。
 *   钩被拖远时先吃掉松弛（弧变直、弧长不变）；绷直后再拖，8 字环被沿线拉过去。
 * - 主线三段（8 字环—铅坠—漂座）各自定长，前一个零件被拉走，后一个沿线跟过去。
 * 所以钝的钓组（子线弯）信号来得晚、来得小——这正是"钝"。
 *
 * 纯函数，与 3D 渲染共用同一条子线曲线（`subLinePoint`），算出的长度就是画出来的长度。
 */

export type V3 = readonly [number, number, number];

/** 子线曲线：控制点 = 弦中点 + (外侧 · 0.24·bend, −0.5·bend)；最低贴到 floorY（躺在底上）。 */
export function subLinePoint(from: V3, to: V3, bend: number, side: number, floorY: number, k: number): [number, number, number] {
  const cx = (from[0] + to[0]) / 2 + side * bend * 0.24;
  const cy = (from[1] + to[1]) / 2 - bend * 0.5;
  const cz = (from[2] + to[2]) / 2;
  const u = 1 - k;
  const x = u * u * from[0] + 2 * u * k * cx + k * k * to[0];
  const y = u * u * from[1] + 2 * u * k * cy + k * k * to[1];
  const z = u * u * from[2] + 2 * u * k * cz + k * k * to[2];
  return [x, Math.max(y, floorY), z];
}

const SAMPLES = 16;
const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function subLineLength(from: V3, to: V3, bend: number, side: number, floorY: number): number {
  let total = 0;
  let prev = subLinePoint(from, to, bend, side, floorY, 0);
  for (let index = 1; index <= SAMPLES; index += 1) {
    const next = subLinePoint(from, to, bend, side, floorY, index / SAMPLES);
    total += dist(prev, next);
    prev = next;
  }
  return total;
}

/** 给定弧长反解弯曲量（弧长随 bend 单调增）；弦已经 ≥ 弧长则绷直 = 0。 */
function bendForLength(from: V3, to: V3, side: number, floorY: number, length: number): number {
  if (subLineLength(from, to, 0, side, floorY) >= length) return 0;
  let lo = 0;
  let hi = 1;
  while (subLineLength(from, to, hi, side, floorY) < length && hi < 16) hi *= 2;
  for (let index = 0; index < 24; index += 1) {
    const mid = (lo + hi) / 2;
    if (subLineLength(from, to, mid, side, floorY) < length) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 让 follower 沿线跟向 leader：距离超过 length 才被拉过去（线只能拉、不能推）。 */
function follow(follower: V3, leader: V3, length: number): V3 {
  const d = dist(follower, leader);
  if (d <= length || d < 1e-9) return follower;
  const k = length / d;
  return [
    leader[0] + (follower[0] - leader[0]) * k,
    leader[1] + (follower[1] - leader[1]) * k,
    leader[2] + (follower[2] - leader[2]) * k,
  ];
}

/**
 * 漂跟线：漂浮在水面、横向几乎不动，被拉时主要是**往下沉**——保持水平位置、竖直下沉到
 * 线长刚好够；只有横向距离已经超过线长（被拖得极远）才整个被拽过去。
 */
function followFloat(float: V3, sinker: V3, length: number): V3 {
  if (dist(float, sinker) <= length) return float;
  const horizontal = Math.hypot(float[0] - sinker[0], float[2] - sinker[2]);
  if (horizontal >= length) return follow(float, sinker, length);
  return [float[0], sinker[1] + Math.sqrt(length * length - horizontal * horizontal), float[2]];
}

const aboveFloor = (point: V3, floorY: number): V3 => (point[1] >= floorY ? point : [point[0], floorY, point[2]]);

export interface ChainRest {
  /** 挂线点（世界坐标）：漂座 / 铅坠 / 8 字环 / 上钩眼 / 下钩眼。 */
  readonly float: V3;
  readonly sinker: V3;
  readonly swivel: V3;
  readonly upper: V3;
  readonly lower: V3;
  /** 静止时的子线弯曲量（调钓状态给的）。 */
  readonly bend: { readonly upper: number; readonly lower: number };
  readonly floorY: number;
}

export interface ChainSolved {
  readonly float: V3;
  readonly sinker: V3;
  readonly swivel: V3;
  readonly upper: V3;
  readonly lower: V3;
  readonly bend: { readonly upper: number; readonly lower: number };
}

/** 上子线在 −X 侧鼓、下子线在 +X 侧鼓（与双钩 V 字张开同侧）。 */
export const SUBLINE_SIDE = { upper: -1, lower: 1 } as const;

export type HookKey = 'upper' | 'lower';

/**
 * 鱼把被咬那只钩的钩眼拖到 `target`，沿链解出每个零件的新位置与两根子线的新弯曲量。
 * target 与静止位相同时，结果就是静止位。
 */
export function solveRigChain(rest: ChainRest, target: V3, bitten: HookKey = 'lower'): ChainSolved {
  const origin = rest[bitten];
  // 没被拖（绝大多数帧）：就是静止位，不必采样曲线、反解弯曲。
  if (target[0] === origin[0] && target[1] === origin[1] && target[2] === origin[2]) return rest;
  const other: HookKey = bitten === 'lower' ? 'upper' : 'lower';
  const { floorY } = rest;
  const lengthOf = (key: HookKey): number => subLineLength(rest.swivel, rest[key], rest.bend[key], SUBLINE_SIDE[key], floorY);
  const draggedLen = lengthOf(bitten);
  const otherLen = lengthOf(other);
  const leadLen = dist(rest.sinker, rest.swivel);
  const floatLen = dist(rest.float, rest.sinker);

  // 子线的弦最多等于弧长：拖得比松弛量还远，8 字环就被拉过去；
  // 8 字环 / 铅坠被拉到底就停在底上（只能贴着底被拖，不会穿到泥里）。
  const swivel = aboveFloor(follow(rest.swivel, target, draggedLen), floorY);
  const sinker = aboveFloor(follow(rest.sinker, swivel, leadLen), floorY);
  const float = followFloat(rest.float, sinker, floatLen);
  // 没被咬的那只钩：8 字环走远了，它那根子线也会被拉直、钩被拖着走。
  const follower = follow(rest[other], swivel, otherLen);
  const hooks = { [bitten]: target, [other]: follower } as Record<HookKey, V3>;

  return {
    float,
    sinker,
    swivel,
    upper: hooks.upper,
    lower: hooks.lower,
    bend: {
      upper: bendForLength(swivel, hooks.upper, SUBLINE_SIDE.upper, floorY, bitten === 'upper' ? draggedLen : otherLen),
      lower: bendForLength(swivel, hooks.lower, SUBLINE_SIDE.lower, floorY, bitten === 'lower' ? draggedLen : otherLen),
    },
  };
}

/** 漂的位移上限：往下沉多少、横向被拽开多少。 */
export interface FloatLimit {
  readonly drop: number;
  readonly shift: number;
}

/**
 * 带浮力上限的求解：漂最多被拉下去 `limit.drop`、横向拽开 `limit.shift`。拖得再狠，
 * 鱼也只能把钩拖到漂刚好到上限的位置（沿拖拽方向二分），线照样是拉动、不伸缩。
 */
export function solveRigChainBuoyant(rest: ChainRest, target: V3, bitten: HookKey, limit: FloatLimit): ChainSolved {
  const within = (solved: ChainSolved): boolean =>
    rest.float[1] - solved.float[1] <= limit.drop + 1e-9 &&
    Math.hypot(solved.float[0] - rest.float[0], solved.float[2] - rest.float[2]) <= limit.shift + 1e-9;
  const full = solveRigChain(rest, target, bitten);
  if (within(full)) return full;
  const origin = rest[bitten];
  const toward = (k: number): V3 => [
    origin[0] + (target[0] - origin[0]) * k,
    origin[1] + (target[1] - origin[1]) * k,
    origin[2] + (target[2] - origin[2]) * k,
  ];
  let lo = 0;
  let hi = 1;
  for (let index = 0; index < 18; index += 1) {
    const mid = (lo + hi) / 2;
    if (within(solveRigChain(rest, toward(mid), bitten))) lo = mid;
    else hi = mid;
  }
  return solveRigChain(rest, toward(lo), bitten);
}
