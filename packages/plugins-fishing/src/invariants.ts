import type { SceneAuditCheck } from '@twin-platform/scene-audit';
import type { TwinWorld } from '@twin-platform/world-kernel';
import { fishingView } from './environment';
import type { FishingLayout } from './fishSim';
import type { LayoutSlot } from './template';

/**
 * 钓场运行时不变量（供 headless runner / CLI 直接消费）。
 *
 * 与 `scripts/audit-scene.ts` 是同一套纪律，但**只做运行中世界的检查**：
 * 图上位置必须等于行为写进世界的位置，否则"看到的样子"和"仿真的事实"就分家了。
 */

const SLOT_ENTITY_IDS: Readonly<Record<LayoutSlot, string>> = {
  float: 'float-01',
  sinker: 'sinker-01',
  swivel: 'swivel-01',
  upperHook: 'hook-upper-01',
  lowerHook: 'hook-lower-01',
  upperBait: 'bait-upper-01',
  lowerBait: 'bait-lower-01',
};

const CHAIN: readonly LayoutSlot[] = ['float', 'sinker', 'swivel', 'upperHook', 'lowerHook'];

const y = (layout: FishingLayout, slot: LayoutSlot): number => layout[slot][1]!;

export const fishingRigInvariant: SceneAuditCheck<TwinWorld> = {
  id: 'fishing.rig.layout',
  description: '链序自上而下、饵不离钩、整链在水里、图与世界写入一致',
  check(world) {
    const view = fishingView(world);
    if (!view) return [{ message: '读不到钓场视图（世界没有 rig-01）。' }];
    const { layout, surfaceY, depth } = view;
    const violations: { where?: string; message: string }[] = [];
    const bottomY = surfaceY - depth;

    for (let index = 1; index < CHAIN.length; index += 1) {
      const upper = y(layout, CHAIN[index - 1]!);
      const lower = y(layout, CHAIN[index]!);
      if (!(upper > lower)) {
        violations.push({
          where: `${CHAIN[index - 1]} > ${CHAIN[index]}`,
          message: `链序破坏：${upper.toFixed(3)} 不在 ${lower.toFixed(3)} 之上。`,
        });
      }
    }
    if (Math.abs(y(layout, 'upperBait') - y(layout, 'upperHook')) > 1e-9) {
      violations.push({ where: 'upperBait', message: '上饵脱离上钩。' });
    }
    if (Math.abs(y(layout, 'lowerBait') - y(layout, 'lowerHook')) > 1e-9) {
      violations.push({ where: 'lowerBait', message: '下饵脱离下钩。' });
    }
    if (!(y(layout, 'sinker') < surfaceY - 0.05)) {
      violations.push({ where: 'sinker', message: `铅坠未没入水面（${y(layout, 'sinker').toFixed(3)}）。` });
    }
    if (!(y(layout, 'lowerHook') > bottomY + 0.01)) {
      violations.push({ where: 'lowerHook', message: `下钩穿透水底（${y(layout, 'lowerHook').toFixed(3)}）。` });
    }
    if (Math.abs(y(layout, 'float') - surfaceY) > 0.25) {
      violations.push({ where: 'float', message: `浮漂离开水面（${y(layout, 'float').toFixed(3)} vs ${surfaceY.toFixed(3)}）。` });
    }

    for (const slot of Object.keys(SLOT_ENTITY_IDS) as LayoutSlot[]) {
      const entity = world.getEntity(SLOT_ENTITY_IDS[slot]);
      const position = entity?.transform.position;
      if (!position) {
        violations.push({ where: slot, message: `布局实体缺失：${SLOT_ENTITY_IDS[slot]}。` });
        continue;
      }
      const expected = layout[slot];
      for (let axis = 0; axis < 3; axis += 1) {
        if (Math.abs(position[axis]! - expected[axis]!) > 1e-9) {
          violations.push({
            where: slot,
            message: `图与行为不一致：世界 ${position[axis]} vs 布局 ${expected[axis]}（轴 ${axis}）。`,
          });
        }
      }
    }

    return {
      violations,
      notes: [`分区 ${view.state.rig.zone} · 水深 ${depth}m · 漂相 ${view.signal}`],
    };
  },
};
