import { describe, expect, it } from 'bun:test';
import type { TwinEntity } from '@twin-platform/scene-schema';
import { buildCenterScene } from './index';

/**
 * 布局回归测试：把"输送线怎么摆"从口头约定固化成断言。
 *
 * 背景：center 场景以前靠手写坐标铺皮带，结果是主线每个转角都叠 0.7m、
 * 立库接口转角直接压在主线皮带上、分流支线还压着拒收货架——渲染出来就是
 * 同高度叠面 z-fighting，也就是"输送线有重叠"。
 *
 * 这里定两条铁律并断言：
 * 1. 任何两个"占地面"实体不得叠出面积（贴边相接是允许的）；
 * 2. 任何物料路径的拐点都必须落在某段皮带/转角/移栽机的占地上——货物不许脱线。
 *
 * 谁再改坐标改漏了，测试会直接报出"哪两个实体、在哪叠了多少"，不用靠眼睛找。
 */

/** 只查占地面：会动的（物料/堆垛机/货叉/托举座）和跨在皮带上方的拱门（检测站）不算。 */
const FOOTPRINT_KINDS = new Set(['transport', 'transfer', 'buffer', 'asrs']);

/** 允许贴边相接，只有真叠出面积才算数（浮点噪声级别忽略）。 */
const EPS = 1e-6;

interface Footprint {
  id: string;
  kind: string;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

function footprints(entities: readonly TwinEntity[]): Footprint[] {
  const out: Footprint[] = [];
  for (const entity of entities) {
    if (!FOOTPRINT_KINDS.has(entity.kind)) continue;
    const size = entity.visual?.size ?? [1, 1, 1];
    const px = entity.transform.position[0];
    const pz = entity.transform.position[2];
    out.push({
      id: entity.id,
      kind: entity.kind,
      x0: px - size[0] / 2,
      x1: px + size[0] / 2,
      z0: pz - size[2] / 2,
      z1: pz + size[2] / 2,
    });
  }
  return out;
}

describe('center 场景布局', () => {
  const scene = buildCenterScene();
  const boxes = footprints(scene.entities);

  it('输送线与设备不互相叠面（不再 z-fighting）', () => {
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
        if (ox > EPS && oz > EPS) {
          overlaps.push(
            `${a.id}(${a.kind}) × ${b.id}(${b.kind})：X 叠 ${ox.toFixed(3)}m，Z 叠 ${oz.toFixed(3)}m`,
          );
        }
      }
    }
    expect(overlaps).toEqual([]);
  });

  it('物料路径的拐点都踩在皮带/转角/移栽机上（不脱线）', () => {
    const unsupported: string[] = [];
    for (const entity of scene.entities) {
      const points = entity.motion?.points;
      if (!points) continue;
      for (const point of points) {
        const [px, , pz] = point;
        // 允许落在边界上，故用 <= / >= 而不是严格小于
        const ok = boxes.some((b) => px >= b.x0 - EPS && px <= b.x1 + EPS && pz >= b.z0 - EPS && pz <= b.z1 + EPS);
        if (!ok) unsupported.push(`${entity.id} 的拐点 (${px.toFixed(2)}, ${pz.toFixed(2)}) 没有皮带托着`);
      }
    }
    expect(unsupported).toEqual([]);
  });
});
