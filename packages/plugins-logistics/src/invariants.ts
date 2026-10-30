import type { SceneAuditCheck } from '@twin-platform/scene-audit';
import type { TwinWorld, WorldEvent } from '@twin-platform/world-kernel';

const countByType = (events: readonly WorldEvent[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
};

/** 环节的中文名：违例要在面板和 JUnit 里都能直接读明白“缺的是哪一环”。 */
const STAGE_LABEL: Readonly<Record<string, string>> = {
  'goods:produced': '产出入料',
  'goods:packed': '打包',
  'asrs:store': '入库',
  'asrs:retrieve': '出库',
  'goods:shipped': '装车运走',
  'truck:departed': '卡车离场',
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
      // 环节代码由面板当标签渲染，这里不重复写一遍代码，只写人话。
      message: `${STAGE_LABEL[type] ?? type}这一环在观察窗内没有发生，不能声称闭环已跑通。`,
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

const NO_CHECKS: readonly SceneAuditCheck<TwinWorld>[] = [];

/** 闭环中心的四种设备都在，才谈得上"全链路"；缺一件就只剩半条线。 */
const CLOSED_LOOP_KINDS = ['source', 'pack', 'asrs', 'stacker', 'truck'] as const;

/**
 * 这个场景该跑哪组不变量。
 *
 * 闭环不变量只对真的装了「发生器 / 打包站 / 立库 / 卡车」的中心场景成立；
 * 换到 line / factory 模板还硬套，就会把"这条链路本来就没有"报成违例——
 * 虚假红灯比没有红灯更糟。
 *
 * CLI（`bun run scene audit`）与 Studio 审计面板都走这一条规则：
 * "CI 里挡你的"和"页面上看到的"必须是同一个口径。
 */
export function runtimeInvariantsFor(scene: TwinWorld['scene']): readonly SceneAuditCheck<TwinWorld>[] {
  const kinds = new Set(scene.entities.map((entity) => entity.kind));
  return CLOSED_LOOP_KINDS.every((kind) => kinds.has(kind)) ? centerRuntimeInvariants : NO_CHECKS;
}
