import type { TwinVector3 } from '@twin-platform/scene-schema';

/**
 * 折线几何小工具（纯函数，无状态）。
 *
 * 行为插件经常要"让一个实体沿折线走"——入库队列滚动、出库托盘送出、卡车行驶。
 * 内核的 `motion` 只对**声明时就有路径**的实体生效（运行时生成的实体没法改路径），
 * 所以这些场合由行为自己按弧长采样，位置写进 transform。
 *
 * 采样只依赖"折线 + 弧长"，因此同一时刻必定得到同一个点，回放不会分叉。
 */

export interface Polyline {
  /** [X, Z] 点列。 */
  points: [number, number][];
  /** 每段长度。 */
  lengths: number[];
  /** 总长（米）。 */
  total: number;
}

/** 把 [X, Z] 点列量成带弧长的折线。 */
export function measurePolyline(points: readonly (readonly [number, number])[]): Polyline {
  const copy: [number, number][] = points.map(([x, z]) => [x, z]);
  const lengths: number[] = [];
  for (let i = 0; i < copy.length - 1; i += 1) {
    const a = copy[i]!;
    const b = copy[i + 1]!;
    lengths.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return { points: copy, lengths, total: lengths.reduce((sum, value) => sum + value, 0) };
}

/** 从 3D 点列里抽 [X, Z]（行为摆位只看水平面）。 */
export function toXZ(points: readonly TwinVector3[]): [number, number][] {
  return points.map((point) => [point[0], point[2]]);
}

/** 沿折线按弧长取点；越界即 clamp 到两端。 */
export function samplePolyline(line: Polyline, s: number): [number, number] {
  const first = line.points[0];
  const last = line.points[line.points.length - 1];
  if (!first || !last) return [0, 0];
  let remaining = Math.max(0, s);
  for (let i = 0; i < line.lengths.length; i += 1) {
    const length = line.lengths[i] ?? 0;
    const a = line.points[i]!;
    const b = line.points[i + 1]!;
    if (remaining <= length || i === line.lengths.length - 1) {
      const t = length <= 1e-9 ? 0 : Math.min(1, remaining / length);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= length;
  }
  return [last[0], last[1]];
}

/**
 * 沿折线的朝向（弧度，绕 Y）：卡车转弯时车身要跟着摆。
 *
 * 约定：**车头（模型长边，即 local +Z）对齐行驶方向**。绕 Y 转 θ 后
 * local +Z `(0,0,1)` 落到 `(sinθ, 0, cosθ)`，要它等于切线 `(dx, dz)`，
 * 就得 `θ = atan2(dx, dz)`。
 *
 * 注意别写成 `atan2(-dz, dx)`（atan2 的"数学极角"直觉）：那算出来的是
 * 切线**左转 90°**，车身会永远侧着走——卡车横着平移，看着就像在飘。
 */
export function headingAt(line: Polyline, s: number): number {
  let remaining = Math.max(0, s);
  for (let i = 0; i < line.lengths.length; i += 1) {
    const length = line.lengths[i] ?? 0;
    if (remaining <= length || i === line.lengths.length - 1) {
      const a = line.points[i]!;
      const b = line.points[i + 1]!;
      return Math.atan2(b[0] - a[0], b[1] - a[1]);
    }
    remaining -= length;
  }
  return 0;
}

/** 朝目标推进，最多走 maxDelta（队列滚动 / 车辆行驶共用）。 */
export function approach(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + (delta > 0 ? maxDelta : -maxDelta);
}

export const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export const str = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

export const numList = (value: unknown, fallback: number[]): number[] => {
  if (!Array.isArray(value)) return fallback;
  const list = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
  return list.length > 0 ? list : fallback;
};

/** 读一个 3D 向量（config 里常写成数组），非法就给 fallback。 */
export function vector3(value: unknown, fallback: TwinVector3): TwinVector3 {
  return Array.isArray(value) && value.length === 3 && value.every((part) => typeof part === 'number' && Number.isFinite(part))
    ? [value[0] as number, value[1] as number, value[2] as number]
    : fallback;
}

/** 读 config 里的 3D 点列（世界坐标），非法就给空数组。 */
export function vectorList(value: unknown): TwinVector3[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is TwinVector3 =>
      Array.isArray(item) && item.length === 3 && item.every((part) => typeof part === 'number' && Number.isFinite(part)),
  );
}
