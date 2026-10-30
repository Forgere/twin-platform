import type { SceneAuditCheck } from '@twin-platform/scene-audit';
import type { TwinWorld, WorldEvent } from '@twin-platform/world-kernel';

const countByType = (events: readonly WorldEvent[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
};

/** 闭环中心必须真的跑通，而不是只有设备声明和动画。 */
export const centerFlowInvariant: SceneAuditCheck<TwinWorld> = {
  id: 'logistics.center.flow',
  description: '产出 → 打包 → 入库 → 出库 → 运走全链路都有事件',
  check(world) {
    const counts = countByType(world.getEventLog());
    const required = ['goods:produced', 'goods:packed', 'asrs:store', 'asrs:retrieve', 'goods:shipped', 'truck:departed'];
    return required.filter((type) => (counts[type] ?? 0) === 0).map((type) => ({
      where: type,
      message: '观察窗内没有该环节事件，不能声称闭环已跑通。',
    }));
  },
};

/** 与原有运行时测试同一口径：小件 2 合 1，托盘只能运走或仍在系统内。 */
export const centerConservationInvariant: SceneAuditCheck<TwinWorld> = {
  id: 'logistics.center.conservation',
  description: '小货物与托盘在全链路中守恒',
  check(world) {
    const counts = countByType(world.getEventLog());
    const produced = counts['goods:produced'] ?? 0;
    const packed = counts['goods:packed'] ?? 0;
    const shipped = counts['goods:shipped'] ?? 0;
    const liveGoods = world.listEntities().filter((entity) => entity.kind === 'parcel' && String(entity.config?.source ?? '') !== '').length;
    const livePallets = world.listEntities().filter((entity) => entity.kind === 'pallet').length;
    const violations = [];
    if (produced !== packed * 2 + liveGoods) {
      violations.push({
        where: 'goods',
        message: `物料不守恒：produced=${produced}，2×packed+live=${packed * 2 + liveGoods}。`,
      });
    }
    if (packed !== shipped + livePallets) {
      violations.push({
        where: 'pallets',
        message: `托盘不守恒：packed=${packed}，shipped+live=${shipped + livePallets}。`,
      });
    }
    return {
      violations,
      notes: [`goods: ${produced} = 2×${packed} + ${liveGoods}`, `pallets: ${packed} = ${shipped} + ${livePallets}`],
    };
  },
};

export const centerRuntimeInvariants: readonly SceneAuditCheck<TwinWorld>[] = [
  centerFlowInvariant,
  centerConservationInvariant,
];
