import type { BehaviorContext, WorldBehavior, WorldEntityState } from '@twin-platform/world-kernel';
import type { TwinVector3 } from '@twin-platform/scene-schema';
import { bucketEntities, neighborsWithinRadius, num, numList, str, vectorList } from './geometry';

/**
 * 打包行为：把 `batch` 个小货物合成 1 个大货物。
 *
 * 与旧版的区别：旧版只给经过工位的小货物打个 `boxed` 标记——小货物还在线上绕圈，
 * "打包"只是贴了个标签。现在是真的**消耗 + 生成**：
 * - 经过工位的小货物被**扣在缓存位**上等着（`attrs.heldBy`），凑够 `batch` 个；
 * - 凑够就一起 `ctx.despawn`，再 `ctx.spawn` 一个大货物（托盘），
 *   沿站台声明的出料路径自己走到立库入库队列尾。
 *
 * 为什么要"缓存位"而不是"同时抓到 2 个"：主环线很长，货物间距 7 米以上，
 * 一台工位的认领半径里**几乎不可能同时出现 2 个货**——那样永远不会打包。
 * 缓存位把"等第二个货来"显式建模出来，顺带在画面上能看到站台在攒货。
 *
 * 背压：目标堆垛机的入库队列没空位时先不认领（`attrs.queueFree` 由 `asrs-cycle` 发布），
 * 货物继续在线上跑；否则打包出来的托盘会全堵在站台上叠成一坨。
 *
 * 确定性：认领顺序按 `born`（产出时刻）+ id，缓存位由"第几个被扣住"决定，不碰随机。
 */

export interface PackingConfig {
  /** 打包工位能力标记，默认 `pack`。 */
  packCapability?: string;
  /** 小货物的能力标记，默认 `parcel`。 */
  goodsCapability?: string;
  /** 合成事件类型，默认 `goods:packed`。 */
  packType?: string;
  /** 工位忙闲状态事件类型，默认 `entity:status`。 */
  statusType?: string;
  /**
   * 覆盖所有工位声明的批大小（几个小货物合一个大货物）。
   * 方案对比用：同一套场景只改打包批量，就能看出"托盘数 / 出库节拍"的变化。
   */
  batch?: number;
  /** 缓存位之间的间距（米），默认 0.8（小货物 0.6 宽，留点缝）。 */
  holdSpacing?: number;
  /** 缓存位的高度（米），默认与输送线台面齐平 1.5。 */
  holdY?: number;
}

export function createPackingBehavior(config: PackingConfig = {}): WorldBehavior {
  const packCap = config.packCapability ?? 'pack';
  const defaultGoodsCap = config.goodsCapability ?? 'parcel';
  const packType = config.packType ?? 'goods:packed';
  const statusType = config.statusType ?? 'entity:status';

  const holdSpacing = Math.max(0.2, config.holdSpacing ?? 0.8);
  const holdY = num(config.holdY, 1.5);

  return {
    id: 'packing',
    step(ctx: BehaviorContext): void {
      const stations = ctx.entities.filter((entity) => entity.capabilities.includes(packCap));
      if (stations.length === 0) return;

      // 网格 cell 取所有工位里最大的认领半径；一次性把"扣在缓存位上的货"按工位分组——
      // 二者都是把"每台工位扫全部实体"的 O(N²) 双层循环压成 O(N)。
      let maxRadius = 1.8;
      for (const station of stations) {
        maxRadius = Math.max(maxRadius, Math.max(0.1, num(station.config?.radius, 1.8)));
      }
      const heldByStation = new Map<string, WorldEntityState[]>();
      for (const entity of ctx.entities) {
        const held = str(entity.attrs.heldBy, '');
        if (held !== '') {
          const list = heldByStation.get(held);
          if (list) list.push(entity);
          else heldByStation.set(held, [entity]);
        }
      }
      const grid = bucketEntities(ctx.entities, maxRadius);

      for (const station of stations) {
        const conf = station.config ?? {};
        const goodsCap = str(conf.goodsCapability, defaultGoodsCap);
        const batch = Math.max(1, Math.round(config.batch ?? num(conf.batch, 2)));
        const radius = Math.max(0.1, num(conf.radius, 1.8));
        const palletPath = vectorList(conf.palletPath);
        const carrier = str(conf.carrier, '');
        const palletCap = str(conf.palletCapability, 'pallet');
        const stationX = station.transform.position[0];
        const stationY = station.transform.position[1];
        const stationZ = station.transform.position[2];

        /** 缓存位：第 i 个被扣住的货停在哪儿（沿 X 排开，居中）。 */
        const holdSlot = (index: number): TwinVector3 => [
          stationX + (index - (batch - 1) / 2) * holdSpacing,
          stationY + holdY,
          stationZ,
        ];

        // 1) 已经被扣在缓存位上的货：每步把位置钉住（内核 motion 还在推它，这里覆盖掉）。
        //    来自上面的单次分组，不再是"每台工位扫全部实体"。
        const held = (heldByStation.get(station.id) ?? []).slice();
        held.sort((a, b) => num(a.attrs.holdIndex, 0) - num(b.attrs.holdIndex, 0) || (a.id < b.id ? -1 : 1));
        held.forEach((entity, index) => {
          ctx.setTransform(entity.id, { position: holdSlot(index) });
        });

        // 2) 背压：立库入口没空位就先不认领（货物继续在线上跑）。
        const carrierState = carrier ? ctx.entity(carrier) : undefined;
        const queueFree = carrierState ? num(carrierState.attrs.queueFree, Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
        if (queueFree <= 0) {
          if (station.status !== 'idle') {
            ctx.setStatus(station.id, 'idle');
            ctx.emit(statusType, { entityId: station.id, payload: { status: 'idle', reason: 'queue-full' } });
          }
          continue;
        }

        // 3) 认领新货：从网格里"半径内 + 有产出源 + 还没被扣住"的货按到达顺序补满缓存位。
        //    只认**发生器产出**的货（config.source 非空）——否则场景里别的物料
        //    （比如分流支线的 divert-cargo-1）路过这里也会被卷进打包站。
        const incoming = neighborsWithinRadius(grid, stationX, stationZ, maxRadius, radius)
          .filter(
            (entity) =>
              entity.capabilities.includes(goodsCap) &&
              str(entity.config?.source, '') !== '' &&
              str(entity.attrs.heldBy, '') === '',
          )
          .sort((a, b) => num(a.attrs.born, 0) - num(b.attrs.born, 0) || (a.id < b.id ? -1 : 1));
        for (const entity of incoming) {
          if (held.length >= batch) break;
          ctx.setAttr(entity.id, 'heldBy', station.id);
          ctx.setAttr(entity.id, 'holdIndex', held.length);
          ctx.setTransform(entity.id, { position: holdSlot(held.length) });
          held.push(entity);
        }

        // 4) 攒够一批就合一个大货物。
        if (held.length < batch) {
          if (station.status !== 'idle') {
            ctx.setStatus(station.id, 'idle');
            ctx.emit(statusType, { entityId: station.id, payload: { status: 'idle', held: held.length } });
          }
          continue;
        }

        const inputs = held.slice(0, batch);
        for (const input of inputs) ctx.despawn(input.id);

        const seq = num(station.attrs.packed, 0) + 1;
        const id = `${station.id}-pallet-${String(seq).padStart(4, '0')}`;
        const label = str(conf.label, station.id);
        const inputsKey = inputs.map((entity) => entity.id).join(',');
        ctx.spawn({
          id,
          kind: 'pallet',
          transform: { position: palletPath[0] ? [...palletPath[0]] : [...station.transform.position] },
          capabilities: [palletCap],
          visual: {
            kind: 'box',
            color: str(conf.palletColor, '#FFDAC1'),
            size: numList(conf.palletSize, [0.8, 0.56, 1]) as TwinVector3,
          },
          // **不给 motion**：托盘的位姿从出生起就由 `asrs-cycle` 全程接管
          // （见 asrs.ts 的 advanceConveying）。否则内核 motion 与货架行为会同时写
          // 同一个实体——内核每步都把它拉回路径终点，覆盖掉货位/出库带上的位置。
          config: {
            label: `${label} 托盘 #${seq}`,
            carrier,
            source: station.id,
            path: palletPath.map((point) => [...point]),
            speed: num(conf.palletSpeed, 0.9),
          },
          // state='conveying'：还在出料带上，等走到队列尾由 asrs-cycle 接管。
          attrs: { state: 'conveying', born: ctx.time, seq, inputs: inputsKey },
        });

        ctx.setAttr(station.id, 'packed', seq);
        ctx.setStatus(station.id, 'busy');
        ctx.emit(packType, {
          entityId: station.id,
          payload: { pallet: id, count: batch, inputs: inputsKey, carrier, seq },
        });
      }
    },
  };
}
