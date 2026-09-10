import type { BehaviorContext, WorldBehavior } from '@twin-platform/world-kernel';
import { approach, headingAt, measurePolyline, num, samplePolyline, str, toXZ, vector3, vectorList } from './geometry';

/**
 * 卡车循环：产线的**出口**（外部消耗方）。
 *
 * 状态机：`docked`（在货位等货/装车）→ `departing`（沿路线驶离）→ `away`（门外）→
 * `returning`（空车回来）→ `docked`。装车时真正 `ctx.despawn` 掉托盘并记
 * `goods:shipped`——这是整条线唯一的"减量"环节，没有它仓库只会越堆越满。
 *
 * 位置沿路线按弧长采样（和入库队列同一套几何），朝向由切线给出，所以转弯时车身会摆。
 */

export interface TruckConfig {
  /** 卡车能力标记，默认 `truck`。 */
  truckCapability?: string;
  /** 装车事件类型，默认 `goods:shipped`。 */
  shipType?: string;
  /** 离场 / 回场事件类型。 */
  departType?: string;
  arriveType?: string;
}

export function createTruckBehavior(config: TruckConfig = {}): WorldBehavior {
  const truckCap = config.truckCapability ?? 'truck';
  const shipType = config.shipType ?? 'goods:shipped';
  const departType = config.departType ?? 'truck:departed';
  const arriveType = config.arriveType ?? 'truck:arrived';

  return {
    id: 'truck-cycle',
    step(ctx: BehaviorContext): void {
      for (const truck of ctx.entities) {
        if (!truck.capabilities.includes(truckCap)) continue;
        const conf = truck.config ?? {};
        const route = vectorList(conf.route);
        const line = measurePolyline(toXZ(route));
        if (line.points.length < 2) continue;

        const dock = vector3(conf.dock, truck.transform.position);
        const speed = Math.max(0.1, num(conf.speed, 2.4));
        const capacity = Math.max(1, Math.round(num(conf.capacity, 4)));
        const dwell = Math.max(0, num(conf.dwell, 6));
        const awayTime = Math.max(0, num(conf.awayTime, 10));
        const loadRadius = Math.max(0.1, num(conf.loadRadius, 2.2));
        const cargoCap = str(conf.cargoCapability, 'pallet');

        let state = str(truck.attrs.truckState, 'docked');
        let tpos = num(truck.attrs.tpos, 0);
        let load = num(truck.attrs.load, 0);
        let since = num(truck.attrs.since, ctx.time);

        if (state === 'docked') {
          // 装车：把货位附近的出库托盘搬上车（真正移除实体）。
          let loaded = 0;
          if (load < capacity) {
            for (const cargo of ctx.entities) {
              if (load >= capacity) break;
              if (!cargo.capabilities.includes(cargoCap)) continue;
              if (str(cargo.attrs.state, '') !== 'outbound') continue;
              const dx = cargo.transform.position[0] - dock[0];
              const dz = cargo.transform.position[2] - dock[2];
              if (dx * dx + dz * dz > loadRadius * loadRadius) continue;
              ctx.despawn(cargo.id);
              load += 1;
              loaded += 1;
              ctx.emit(shipType, { entityId: truck.id, payload: { cargo: cargo.id, load } });
            }
          }
          // 发货窗口：每装上一件就重新计时。
          //
          // 不加这句就会退化成"装一件就走"——`since` 是上次回到货位的时间，
          // 等第一件货（堆垛机一个循环十几秒）的时间全算进了等待窗口，
          // 于是货刚上车就"等够了"直接发车。改成"最后一件之后还等 dwell 秒"，
          // 只要出库带还在陆续送货就继续攒，攒满 capacity 才走。
          if (loaded > 0) since = ctx.time;
          if (load >= capacity || (load > 0 && ctx.time - since >= dwell)) {
            state = 'departing';
            since = ctx.time;
            ctx.emit(departType, { entityId: truck.id, payload: { load } });
          }
        } else if (state === 'departing') {
          tpos = approach(tpos, line.total, speed * ctx.dt);
          if (tpos >= line.total - 1e-9) {
            state = 'away';
            since = ctx.time;
            load = 0; // 货已卸在门外
          }
        } else if (state === 'away') {
          if (ctx.time - since >= awayTime) state = 'returning';
        } else if (state === 'returning') {
          tpos = approach(tpos, 0, speed * ctx.dt);
          if (tpos <= 1e-9) {
            state = 'docked';
            since = ctx.time;
            ctx.emit(arriveType, { entityId: truck.id });
          }
        }

        // 直接写，不做"变了才写"的判断：卡车的 transform 每步都要写，
        // 实体本来就是脏的，省下的那点差量不值得引入"读自己刚写的值"这类坑
        // （第一版就踩了：since 的兜底值取 ctx.time，导致比较永远相等、since 永远写不进去）。
        ctx.setAttr(truck.id, 'truckState', state);
        ctx.setAttr(truck.id, 'since', since);
        ctx.setAttr(truck.id, 'load', load);
        ctx.setAttr(truck.id, 'tpos', tpos);

        const [px, pz] = samplePolyline(line, tpos);
        ctx.setTransform(truck.id, { position: [px, dock[1], pz], rotation: [0, headingAt(line, tpos), 0] });
      }
    },
  };
}
