/**
 * 软绳：钓线的"柔软度"。
 *
 * 一根线 = 首尾钉在两个挂线点上的一条顺滑曲线（二次贝塞尔），总长固定：
 * - **有余量就下垂**：垂度由"线长 vs 两端距离"反解出来（弧长守恒），方向是重力 + 水流
 *   在垂直于线的方向上的合力——静水里往下垂，走水时往下游鼓；
 * - **拉满就绷直**：两端拉开到线长，垂度为 0（线只能拉、不能伸长）；
 * - **柔**：垂下去的那一点是个弹簧阻尼，追着目标形状走——端点被猛拖时线会滞后、甩动再停稳
 *   （水里阻尼大、慢；空气里快一些）；
 * - 碰到底面就贴在底上。
 *
 * 为什么不用自由节点（Verlet）：线几乎竖直时重力沿着线，余量没有"往哪边弯"的依据，
 * 会被距离约束挤成锯齿，而锯齿同样满足每段等长，是个稳定的错解。
 *
 * 只做表现：不写世界状态；同样的 dt 序列得到同样的形状。
 */

export type Vec3 = readonly [number, number, number];

export interface RopeForces {
  /** 竖直加速度（m/s²，负为向下）：决定"往下垂"的倾向。 */
  readonly gravity: number;
  /** 水平加速度（m/s²）：走水的水流，只对水面以下的线起作用（按线的中点判断）。 */
  readonly current: Vec3;
  /** 水面高度：以上是空气（弹簧快、阻尼小），以下是水（慢、阻尼大）。 */
  readonly surfaceY: number;
  /** 底面：线不能低于它（躺底）。 */
  readonly floorY: number;
  /**
   * 额外的偏向（m/s²，不分水上水下）：两根并联子线各自往自己那一侧松，
   * 不然余量都往中间垂、两根线交叉成 X。
   */
  readonly spread?: Vec3;
}

/** 渲染分段数：越多越顺滑。 */
export const ROPE_SEGMENTS = 12;
/** 弹簧角频率（1/s）与阻尼比：水里慢而稳，空气里快、略有晃动。 */
const SPRING = { water: { omega: 7, zeta: 0.9 }, air: { omega: 14, zeta: 0.55 } } as const;
const SAMPLES = 24;

type V = [number, number, number];

/** 曲线：控制点 = 弦中点 + 2·bulge（曲线中点正好偏离弦中点 bulge）。 */
function curvePoint(from: Vec3, to: Vec3, bulge: Vec3, k: number, out: V): V {
  const u = 1 - k;
  for (let axis = 0; axis < 3; axis += 1) {
    const control = (from[axis] + to[axis]) / 2 + 2 * bulge[axis];
    out[axis] = u * u * from[axis] + 2 * u * k * control + k * k * to[axis];
  }
  return out;
}

function curveLength(from: Vec3, to: Vec3, bulge: Vec3): number {
  const a: V = [0, 0, 0];
  const b: V = [0, 0, 0];
  curvePoint(from, to, bulge, 0, a);
  let total = 0;
  for (let index = 1; index <= SAMPLES; index += 1) {
    curvePoint(from, to, bulge, index / SAMPLES, b);
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    a[0] = b[0];
    a[1] = b[1];
    a[2] = b[2];
  }
  return total;
}

export class Rope {
  /** 渲染节点，(ROPE_SEGMENTS + 1) × 3。 */
  readonly nodes = new Float64Array((ROPE_SEGMENTS + 1) * 3);
  private readonly bulge: V = [0, 0, 0];
  private readonly velocity: V = [0, 0, 0];
  private ready = false;

  point(index: number): Vec3 {
    const o = index * 3;
    return [this.nodes[o], this.nodes[o + 1], this.nodes[o + 2]];
  }

  /** 按当前挂点直接采样平衡曲线：回放 / 暂停用，不依赖此前渲染过多少帧。 */
  pose(from: Vec3, to: Vec3, length: number, forces: RopeForces): void {
    this.ready = false;
    this.step(from, to, length, 0, forces);
  }

  step(from: Vec3, to: Vec3, length: number, dt: number, forces: RopeForces): void {
    const target = targetBulge(from, to, length, forces);
    if (!this.ready) {
      this.bulge.splice(0, 3, ...target);
      this.velocity.fill(0);
      this.ready = true;
    } else {
      // 弹簧阻尼追目标（半隐式欧拉，分步保证稳定）。
      const midY = (from[1] + to[1]) / 2 + this.bulge[1];
      const { omega, zeta } = midY < forces.surfaceY ? SPRING.water : SPRING.air;
      const span = Math.min(dt, 1 / 15);
      const substeps = Math.max(1, Math.ceil(span / (1 / 240)));
      const h = span / substeps;
      for (let step = 0; step < substeps; step += 1) {
        for (let axis = 0; axis < 3; axis += 1) {
          const accel = omega * omega * (target[axis] - this.bulge[axis]) - 2 * zeta * omega * this.velocity[axis];
          this.velocity[axis] += accel * h;
          this.bulge[axis] += this.velocity[axis] * h;
        }
      }
    }
    // 拉满时不许"甩"出比线长还长的弧：绷直就是直线。
    const chord = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    if (chord >= length * 0.999) {
      this.bulge.fill(0);
      this.velocity.fill(0);
    }
    const out: V = [0, 0, 0];
    for (let index = 0; index <= ROPE_SEGMENTS; index += 1) {
      curvePoint(from, to, this.bulge, index / ROPE_SEGMENTS, out);
      const o = index * 3;
      this.nodes[o] = out[0];
      this.nodes[o + 1] = index === 0 || index === ROPE_SEGMENTS ? out[1] : Math.max(out[1], forces.floorY);
      this.nodes[o + 2] = out[2];
    }
  }
}

/**
 * 目标形状：垂度方向 = (重力 + 水流) 在垂直于弦方向上的分量；这个方向几乎为零时
 * （线竖直、又没有水流）退回水平 +X，保证余量总有地方去。垂度大小二分到弧长 = 线长。
 */
export function targetBulge(from: Vec3, to: Vec3, length: number, forces: RopeForces): V {
  const chord = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  if (chord >= length * 0.999 || chord < 1e-9) return [0, 0, 0];
  const c = [(to[0] - from[0]) / chord, (to[1] - from[1]) / chord, (to[2] - from[2]) / chord];
  const underwater = (from[1] + to[1]) / 2 < forces.surfaceY;
  const spread = forces.spread ?? [0, 0, 0];
  const pull: V = [
    (underwater ? forces.current[0] : 0) + spread[0],
    forces.gravity + (underwater ? forces.current[1] : 0) + spread[1],
    (underwater ? forces.current[2] : 0) + spread[2],
  ];
  const perpendicular = (v: Vec3): V => {
    const along = v[0] * c[0] + v[1] * c[1] + v[2] * c[2];
    return [v[0] - along * c[0], v[1] - along * c[1], v[2] - along * c[2]];
  };
  let dir = perpendicular(pull);
  if (Math.hypot(...dir) < 0.2 * Math.max(Math.hypot(...pull), 1e-9)) {
    const fallback = perpendicular([1, 0, 0]);
    dir = Math.hypot(...fallback) > 1e-6 ? fallback : perpendicular([0, 0, 1]);
  }
  const n = Math.hypot(...dir);
  const unit: V = [dir[0] / n, dir[1] / n, dir[2] / n];
  let lo = 0;
  let hi = length;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const mid = (lo + hi) / 2;
    if (curveLength(from, to, [unit[0] * mid, unit[1] * mid, unit[2] * mid]) < length) lo = mid;
    else hi = mid;
  }
  return [unit[0] * lo, unit[1] * lo, unit[2] * lo];
}
