import type { BehaviorContext, WorldBehavior } from '@twin-platform/world-kernel';
import type { TwinVector3 } from '@twin-platform/scene-schema';
import { num, numList, str, vector3, vectorList } from './geometry';

/**
 * 小货物发生器：产线的**入口**。
 *
 * 这是"一处持续产出小货物"的落地：行为按固定间隔调用 `ctx.spawn` 生成实体，
 * 小货物沿声明的闭环路径自己跑（内核 motion），直到在打包站被吃掉。
 *
 * 两个关键设计：
 * - **id 由计数器派生**（`source-1-goods-0001`），计数器存在发生器 attrs 里，
 *   随快照恢复，所以回放 / 分叉不会生成出不同的世界；
 * - **背压**：线上在制品达到 `maxWip` 就停产。没有它，发生器会把场景塞爆，
 *   而且"产得太快"这种工况在真实产线里是靠堵料体现的，这里就用"暂停产出"表达。
 */

export interface GoodsSourceConfig {
  /** 发生器能力标记，默认 `source`。 */
  sourceCapability?: string;
  /** 产出事件类型，默认 `goods:produced`。 */
  produceType?: string;
  /** 产出间隔（秒）的默认值，发生器没声明时用它。 */
  interval?: number;
  /** 在制品上限的默认值。 */
  maxWip?: number;
}

export function createGoodsSourceBehavior(config: GoodsSourceConfig = {}): WorldBehavior {
  const sourceCap = config.sourceCapability ?? 'source';
  const produceType = config.produceType ?? 'goods:produced';
  const defaultInterval = Math.max(0.1, config.interval ?? 5);
  const defaultMaxWip = Math.max(1, Math.round(config.maxWip ?? 10));

  return {
    id: 'goods-source',
    step(ctx: BehaviorContext): void {
      // 一次性统计"每个发生器当前在制的货物数"，避免对每台发生器扫描全部实体（O(N²)）。
      // 货物由本行为 spawn 时打上 `config.source = 发生器 id`，所以按该 tag 计数即可，
      // 与逐台扫描全部实体再比对 capability + source 的旧逻辑等价。
      const liveBySource = new Map<string, number>();
      for (const entity of ctx.entities) {
        const src = str(entity.config?.source, '');
        if (src !== '') liveBySource.set(src, (liveBySource.get(src) ?? 0) + 1);
      }

      for (const source of ctx.entities) {
        if (!source.capabilities.includes(sourceCap)) continue;
        const conf = source.config ?? {};
        const path = vectorList(conf.goodsPath);
        if (path.length < 2) continue;

        const goodsCap = str(conf.goodsCapability, 'parcel');
        const interval = Math.max(0.1, num(conf.interval, defaultInterval));
        const maxWip = Math.max(1, Math.round(num(conf.maxWip, defaultMaxWip)));

        // 背压：只数"我产出的、还活着的"货物（来自上面的单次统计）。
        const live = liveBySource.get(source.id) ?? 0;
        if (live >= maxWip) continue;
        if (ctx.time < num(source.attrs.nextAt, 0)) continue;

        const seq = num(source.attrs.produced, 0) + 1;
        const id = `${source.id}-goods-${String(seq).padStart(4, '0')}`;
        if (ctx.entity(id)) continue; // 不该发生：id 撞车说明计数器坏了，跳过而不是抛错

        const label = str(conf.label, source.id);
        ctx.spawn({
          id,
          kind: 'parcel',
          transform: { position: [...path[0]!] },
          capabilities: [goodsCap],
          visual: {
            kind: 'box',
            color: str(conf.goodsColor, '#F4A261'),
            size: numList(conf.goodsSize, [0.55, 0.55, 0.55]) as TwinVector3,
          },
          motion: {
            points: path.map((point) => [...point]),
            speed: num(conf.goodsSpeed, 1.1),
            loop: 'repeat',
            cornerRadius: num(conf.goodsCornerRadius, 0.4),
          },
          config: { label: `${label} #${seq}`, source: source.id },
          attrs: { born: ctx.time, seq },
        });
        ctx.setAttr(source.id, 'produced', seq);
        ctx.setAttr(source.id, 'nextAt', ctx.time + interval);
        ctx.emit(produceType, { entityId: id, payload: { source: source.id, seq } });
      }
    },
  };
}
