import type { TwinVector3 } from '@twin-platform/scene-schema';

/**
 * 弧长参数化折线。
 *
 * 从 r3f-tools `sim/pathMath` 迁移而来，去掉了输送线语义：这里的"路径"只是
 * 一条空间折线，AGV 路线、堆垛机行程、输送线中心线都用它。纯数学，无 Three 依赖，
 * 因此可以在 Worker 与服务端跑出和前端一致的位姿。
 *
 * 关键点：先把折角换成二次贝塞尔圆角并密化，再建弧长表。这样直段严格笔直
 * （CatmullRom 会把直段吹弯），而采样是 O(log n) 二分。
 */

export interface TwinPath {
  /** 密化后的采样点。 */
  readonly points: readonly TwinVector3[];
  /** cumulative[i] = 从 points[0] 到 points[i] 的弧长。 */
  readonly cumulative: readonly number[];
  readonly length: number;
}

export interface PathSample {
  position: TwinVector3;
  /** 由路径切线得到的偏航角（弧度）。 */
  heading: number;
}

export interface BuildPathOptions {
  /** 折角圆角半径，0 表示保持尖角。默认 0.45。 */
  cornerRadius?: number;
  /** 每个圆角的密化段数，默认 6。 */
  arcSegments?: number;
}

const sub = (a: TwinVector3, b: TwinVector3): TwinVector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const distance = (a: TwinVector3, b: TwinVector3): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

const at = <T,>(items: readonly T[], index: number): T | undefined => items[index];

function quadraticBezier(a: TwinVector3, control: TwinVector3, b: TwinVector3, t: number): TwinVector3 {
  const u = 1 - t;
  const w0 = u * u;
  const w1 = 2 * u * t;
  const w2 = t * t;
  return [
    w0 * a[0] + w1 * control[0] + w2 * b[0],
    w0 * a[1] + w1 * control[1] + w2 * b[1],
    w0 * a[2] + w1 * control[2] + w2 * b[2],
  ];
}

/** 把每个内部折角换成小圆角，直段保持笔直。 */
export function filletPolyline(points: readonly TwinVector3[], radius = 0.45, arcSegments = 6): TwinVector3[] {
  if (points.length < 3) return points.map((point) => [...point] as TwinVector3);

  const first = at(points, 0);
  if (!first) return [];
  const out: TwinVector3[] = [[...first]];

  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = at(points, i - 1);
    const cur = at(points, i);
    const next = at(points, i + 1);
    if (!prev || !cur || !next) continue;

    const dIn = distance(prev, cur);
    const dOut = distance(cur, next);
    // 钳制半径，避免相邻圆角吃掉同一段直线。
    const r = Math.min(radius, dIn * 0.45, dOut * 0.45);
    const inDir = sub(cur, prev);
    const outDir = sub(next, cur);
    const inLen = Math.max(dIn, 1e-9);
    const outLen = Math.max(dOut, 1e-9);
    const a: TwinVector3 = [cur[0] - (inDir[0] / inLen) * r, cur[1] - (inDir[1] / inLen) * r, cur[2] - (inDir[2] / inLen) * r];
    const b: TwinVector3 = [cur[0] + (outDir[0] / outLen) * r, cur[1] + (outDir[1] / outLen) * r, cur[2] + (outDir[2] / outLen) * r];

    if (r > 1e-4) {
      for (let s = 0; s <= arcSegments; s += 1) out.push(quadraticBezier(a, cur, b, s / arcSegments));
    } else {
      out.push(a, b);
    }
  }

  const last = at(points, points.length - 1);
  if (last) out.push([...last]);
  return out;
}

/** 建一次弧长表，之后采样 O(log n)。 */
export function buildPath(points: readonly TwinVector3[], options: BuildPathOptions = {}): TwinPath {
  const cornerRadius = options.cornerRadius ?? 0.45;
  const dense = cornerRadius > 0 ? filletPolyline(points, cornerRadius, options.arcSegments ?? 6) : points.map((point) => [...point] as TwinVector3);

  const cumulative: number[] = [0];
  let acc = 0;
  for (let i = 1; i < dense.length; i += 1) {
    const prev = at(dense, i - 1);
    const cur = at(dense, i);
    acc += prev && cur ? distance(prev, cur) : 0;
    cumulative.push(acc);
  }
  return { points: dense, cumulative, length: acc };
}

/** 按弧长采样位置与偏航角。距离会被钳制到 [0, length]。 */
export function samplePath(path: TwinPath, distanceAlong: number): PathSample {
  const { points, cumulative, length } = path;
  const lastIndex = cumulative.length - 1;
  const first = at(points, 0);

  if (lastIndex < 1 || !first) return { position: first ? [...first] : [0, 0, 0], heading: 0 };

  const d = Math.min(Math.max(distanceAlong, 0), length);

  let lo = 0;
  let hi = lastIndex;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((at(cumulative, mid) ?? 0) < d) lo = mid + 1;
    else hi = mid;
  }

  const i = Math.max(1, lo);
  const segStart = at(cumulative, i - 1) ?? 0;
  const segEnd = at(cumulative, i) ?? segStart;
  const segLen = segEnd - segStart;
  const t = segLen > 1e-9 ? (d - segStart) / segLen : 0;

  const a = at(points, i - 1);
  const b = at(points, i);
  if (!a || !b) return { position: [...first], heading: 0 };

  return {
    position: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
    heading: Math.atan2(b[0] - a[0], b[2] - a[2]),
  };
}
