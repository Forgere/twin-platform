import type { BehaviorContext, WorldBehavior, WorldEntityState } from '@twin-platform/world-kernel';
import type { TwinVector3 } from '@twin-platform/scene-schema';
import { approach, measurePolyline, num, numList, samplePolyline, str, toXZ, vector3, vectorList, type Polyline } from './geometry';

/**
 * 堆垛机存取循环 + 货架先入先出（FIFO）库存行为。
 *
 * 与 `logistics-flow` 的分工：那条只"读懂内核搬运结果"，这条反过来——
 * 它自己就是运动源，用 `ctx.setTransform` 直接写门架 / 载货台 / 货叉 / 托盘位姿，
 * 并且**维护货架库存**：哪个货位存着哪块托盘、下一块该取谁。
 *
 * ## 为什么托盘是场景里预置的实体池，而不是运行时生成
 *
 * 内核的 `BehaviorContext` 只给 setAttr / setStatus / setTransform / move / emit，
 * 没有 spawn / despawn。所以这里用"固定托盘池 + 状态机"表达出入库：
 *
 * ```
 *   queued ──取货──> carrying-in ──放货──> stored ──取货──> carrying-out ──> outbound ──> queued
 *   （入库队列）        （货叉上）          （货位）        （货叉上）      （出库带）   （回队列尾）
 * ```
 *
 * 每个状态都是**真实实体**，所以托盘点得中、在物料列表里看得到、货架上的数量也会变。
 * 池是闭环的：出库托盘在出库接驳带上等 `outboundDwell` 秒后回到入库队列尾部，
 * 语义上相当于"外部取走 + 新托盘到货"。内核补上 spawn/despawn 之后，
 * 这里换成真正的外部喂入/取走即可，状态机不用改。
 *
 * ## 先入先出
 *
 * 入库：挑**第一个空货位**（按 列 → 侧 → 层 的固定顺序，见 `craneLayout`），并给托盘打上入架序号 `seq`；
 * 出库：取 `seq` **最小**的那块。序号和货位都写在托盘 attrs 里，随快照一起恢复，
 * 所以 seek 回放不会乱序。
 *
 * ## 确定性
 *
 * 位姿是"本圈任务 + 时间"的纯函数（`u = (t / cycle + phase) mod 1`）；
 * 任务与库存在 attrs 里（快照覆盖）；不碰 `ctx.rng`、不读挂钟。
 */

/** 托盘坐在台面/货位横梁上时，中心相对台面的高度（托盘半高 0.28 + 一点余量）。 */
const PALLET_SEAT = 0.3;
/** 托盘坐在货叉上时，中心相对叉面的高度。 */
const CARRIED_SEAT = 0.32;
/** 放货/取货发生在这一圈相位的哪一点。 */
const HANDOVER_U = 0.54;
/**
 * 载货出巷时，货叉伸出后在哪一点把托盘卸到出库位。
 *
 * 卸下之后货叉缩回、门架空车返回巷道口，托盘留在出库位上——所以出库货是
 * **被堆垛机真正载出去**的，不会出现在巷道口"凭空瞬移"到缓存台。
 */
const DROP_U = 0.78;

export interface AsrsBehaviorConfig {
  /** 门架实体的能力标记，默认 `stacker`。 */
  craneCapability?: string;
  /** 载货台 / 货叉实体的 id 后缀。 */
  carriageSuffix?: string;
  forkSuffix?: string;
  /** 托盘实体的能力标记，默认 `pallet`。 */
  palletCapability?: string;
  /** 入库队列的节距（米）：托盘排队时前后间距。 */
  queuePitch?: number;
  /** 入库队列的滚动线速度（m/s）。 */
  queueSpeed?: number;
  /**
   * 出库托盘在出库接驳带上等待多久再回到队列（秒），默认 1.1 × cycle。
   *
   * 略大于一个循环：出库的托盘要等下一圈才回到队列，于是"取一块、存一块"交替进行，
   * 货架占用会明显涨落；同时最多只有 2 块托盘在出库带上（出库货位就 2 个）。
   */
  outboundDwell?: number;
  /** 入库（放货）事件类型。 */
  storeType?: string;
  /** 出库（取货）事件类型。 */
  retrieveType?: string;
}

/** 入库队列的一段：托盘按弧长在上面滚动。 */
export type QueueLine = Polyline;

/** 一个货位：位置 + 给人看的坐标（第几层第几列、哪一侧）。 */
interface RackSlot {
  /** 货位键 `侧:层:列`，写进托盘 attrs.slot，也是库存的真相。 */
  key: string;
  side: 0 | 1;
  level: number;
  column: number;
  levelY: number;
  position: TwinVector3;
}

/** 一台堆垛机（= 一条巷道）的完整布局：货位表 + 入库队列 + 出库货位。 */
interface CraneLayout {
  aisleX: number;
  ioZ: number;
  ioY: number;
  cycle: number;
  phase: number;
  reach: number;
  forkX: [number, number];
  slots: RackSlot[];
  /** 入库队列中心线：托盘按弧长在上面滚动。 */
  queue: QueueLine;
  /** 出库接驳带上的货位（XZ）。 */
  outfeed: [number, number][];
  /**
   * 出库卸货点 Z：声明后，取货任务**不再回巷道口**，而是载着托盘沿巷道走到
   * 这个 Z（通常在货架另一端之外）再放下，然后空车返回。
   *
   * 不声明则沿用旧行为：回到 `ioZ` 卸货——出库口与入库队列同侧时只能这样，
   * 但托盘会从巷道口瞬移到缓存台（见 `releaseCarriedOut` 的"退化落位"）。
   */
  outfeedTravelZ?: number;
  /** 出库卸货时货叉伸向哪一侧：+1 朝 +X，-1 朝 -X。 */
  outfeedDir: number;
  /** 出库托盘从取货点走到货位的路径（XZ），空数组表示直接落位。 */
  outbound: QueueLine;
  /** 出库托盘去向：回收（闭环托盘池）还是被卡车拉走。 */
  outboundMode: 'recycle' | 'shipped';
  /** 库存高水位：到线就转去出库。 */
  highWater: number;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** 归一化到 [0,1] 并做 smoothstep，避免启停时的速度突变。 */
const ramp = (u: number, from: number, to: number): number => {
  const t = clamp01((u - from) / Math.max(to - from, 1e-9));
  return t * t * (3 - 2 * t);
};

/** 派生实体 id：门架 `stacker-a` → 载货台 `stacker-a-carriage`。 */
const derived = (ctx: BehaviorContext, base: string, suffix: string): WorldEntityState | undefined =>
  ctx.entity(`${base}${suffix}`);

/** 布局只需要"位置 + config"这两样，所以场景声明（TwinEntity）和运行时状态都能传。 */
export interface CraneSpec {
  transform: { position: TwinVector3 };
  config?: Record<string, unknown>;
}

/**
 * 从堆垛机 config 推出整条巷道的布局：货位表 + 入库队列折线 + 出库货位。
 *
 * 货位表按「列 → 侧 → 层」排序，也就是**入库顺序**：入库时取第一个空位，
 * 于是靠近巷道口那一列会被从上到下铺满，堆垛机每圈起升到不同层，
 * 高货架上"哪几层有货"一眼能看出来。顺序固定 = 结果可复现。
 */
function craneLayout(crane: CraneSpec, queuePitch: number): CraneLayout {
  const conf = crane.config ?? {};
  const aisleX = num(conf.aisleX, crane.transform.position[0]);
  const ioZ = num(conf.ioZ, crane.transform.position[2]);
  const ioY = num(conf.ioY, 1.2);
  const zMin = num(conf.zMin, ioZ);
  const zMax = num(conf.zMax, ioZ + 8);
  const levels = numList(conf.levels, [1.5, 2.7, 3.9]);
  const columns = Math.max(2, Math.round(num(conf.columns, 4)));
  const cycle = Math.max(1, num(conf.cycle, 14));
  const phase = num(conf.phase, 0);
  const reach = Math.max(0.2, num(conf.reach, 1.4));
  const forkPair = numList(conf.forkX, [aisleX - reach, aisleX + reach]);
  const forkX: [number, number] = [forkPair[0] ?? aisleX - reach, forkPair[1] ?? aisleX + reach];
  const stationX = num(conf.stationX, aisleX - 4);

  // 货位顺序 = 入库顺序：**列 → 侧 → 层**。先把靠近巷道口那一列从上到下铺满，
  // 于是堆垛机每圈起升到不同层，高货架上"哪几层有货"一眼能看出来；
  // 顺序固定 = 结果可复现，跟"取空位"的策略分开记。
  const slots: RackSlot[] = [];
  for (let column = 0; column < columns; column += 1) {
    const z = columns === 1 ? zMin : zMin + (column / (columns - 1)) * (zMax - zMin);
    for (const side of [0, 1] as const) {
      for (let level = 0; level < levels.length; level += 1) {
        const levelY = levels[level]!;
        slots.push({
          key: `${side}:${level}:${column}`,
          side,
          level,
          column,
          levelY,
          position: [forkX[side], levelY + PALLET_SEAT, z],
        });
      }
    }
  }

  // 入库队列：从堆垛机取货点（巷道口正下方）沿站台横段西行，再拐到竖段南行。
  const headX = aisleX - 0.5;
  const cornerX = stationX + 0.4;
  const queue = measurePolyline([
    [headX, ioZ],
    [cornerX, ioZ],
    [stationX, ioZ - 0.4],
    [stationX, ioZ - 1.4],
  ]);

  const outfeedX = num(conf.outfeedX, stationX);
  const outfeedZ = numList(conf.outfeedZ, [1.6, 0.8]);
  const outfeed: [number, number][] = outfeedZ.map((z) => [outfeedX, z]);
  // 载货出巷：只有显式声明了 outfeedTravelZ 才启用（不声明 = 旧行为，回 ioZ 卸货）。
  const travelRaw = conf.outfeedTravelZ;
  const outfeedTravelZ =
    typeof travelRaw === 'number' && Number.isFinite(travelRaw) ? travelRaw : undefined;
  const outfeedDir = num(conf.outfeedDir, 1) < 0 ? -1 : 1;

  // 出库路径：从取货点出发（默认直接落到货位，即"没有路径"）。
  const outbound = measurePolyline(toXZ(vectorList(conf.outboundPath)));
  const outboundMode: 'recycle' | 'shipped' = str(conf.outboundMode, 'recycle') === 'shipped' ? 'shipped' : 'recycle';
  const highWater = num(conf.highWater, Number.POSITIVE_INFINITY);

  return {
    aisleX,
    ioZ,
    ioY,
    cycle,
    phase,
    reach,
    forkX,
    slots,
    queue,
    outfeed,
    outfeedTravelZ,
    outfeedDir,
    outbound,
    outboundMode,
    highWater,
  };
}

/** 托盘池里能排进队列的最大块数（受队列长度限制）。场景模板靠它决定生成几块托盘。 */
export function palletPoolCapacity(crane: CraneSpec, queuePitch = 0.9): number {
  const layout = craneLayout(crane, queuePitch);
  return Math.max(1, Math.floor(layout.queue.total / queuePitch) + 1);
}

interface CraneTask {
  kind: 'store' | 'retrieve' | 'idle';
  palletId: string;
  slotKey: string;
}

const readTask = (crane: WorldEntityState): CraneTask => ({
  kind: (str(crane.attrs.__task, 'idle') as CraneTask['kind']) ?? 'idle',
  palletId: str(crane.attrs.__taskPallet, ''),
  slotKey: str(crane.attrs.__taskSlot, ''),
});

const queueOrder = (a: WorldEntityState, b: WorldEntityState): number =>
  num(a.attrs.order, 0) - num(b.attrs.order, 0) || (a.id < b.id ? -1 : 1);

export function createAsrsBehavior(config: AsrsBehaviorConfig = {}): WorldBehavior {
  const craneCap = config.craneCapability ?? 'stacker';
  const carriageSuffix = config.carriageSuffix ?? '-carriage';
  const forkSuffix = config.forkSuffix ?? '-fork';
  const palletCap = config.palletCapability ?? 'pallet';
  const queuePitch = Math.max(0.4, config.queuePitch ?? 0.9);
  const queueSpeed = Math.max(0.05, config.queueSpeed ?? 0.8);
  const storeType = config.storeType ?? 'asrs:store';
  const retrieveType = config.retrieveType ?? 'asrs:retrieve';

  /** 场景第一步：给还没进过状态机的托盘排好队（按场景声明顺序）。 */
  const initPallets = (ctx: BehaviorContext, crane: WorldEntityState, pallets: WorldEntityState[], layout: CraneLayout): void => {
    let order = num(crane.attrs.__order, 0);
    let changed = false;
    for (const pallet of pallets) {
      if (pallet.attrs.state !== undefined) continue;
      ctx.setAttr(pallet.id, 'state', 'queued');
      ctx.setAttr(pallet.id, 'order', order);
      ctx.setAttr(pallet.id, 'qpos', Math.min(order * queuePitch, layout.queue.total));
      order += 1;
      changed = true;
    }
    if (changed) ctx.setAttr(crane.id, '__order', order);
  };

  /**
   * 出库托盘离开货叉：送到出库接驳带上。
   *
   * 两条路径：
   * - 声明了 `outboundPath`（出库带在巷道侧）→ 托盘沿路径**自己走出去**，
   *   位置每步由 `advanceOutbound` 推进，看起来就是出库输送机把它送走；
   * - 没声明 → 直接落到出库货位上（出库带与站台同侧时，路径会穿过入库队列，
   *   只能退化成落位，见 logistics-center）。
   */
  const releaseCarriedOut = (
    ctx: BehaviorContext,
    crane: WorldEntityState,
    pallets: WorldEntityState[],
    layout: CraneLayout,
    dwell: number,
  ): void => {
    for (const pallet of pallets) {
      if (pallet.attrs.state !== 'carrying-out') continue;
      const outOrder = num(crane.attrs.__outOrder, 0);
      ctx.setAttr(crane.id, '__outOrder', outOrder + 1);
      ctx.setAttr(pallet.id, 'state', 'outbound');
      ctx.setAttr(pallet.id, 'outOrder', outOrder);
      ctx.setAttr(pallet.id, 'outUntil', ctx.time + dwell);
      ctx.setAttr(pallet.id, 'slot', '');
      if (layout.outbound.total > 1e-6) {
        // 沿出库带走：outpos 是弧长，目标由"第几个出库托盘"决定（见 advanceOutbound）。
        ctx.setAttr(pallet.id, 'outpos', 0);
        const [px, pz] = samplePolyline(layout.outbound, 0);
        ctx.setTransform(pallet.id, { position: [px, layout.ioY + PALLET_SEAT, pz] });
        continue;
      }
      const dock = layout.outfeed[outOrder % layout.outfeed.length] ?? [layout.aisleX, layout.ioZ];
      ctx.setTransform(pallet.id, { position: [dock[0], layout.ioY + PALLET_SEAT, dock[1]] });
    }
  };

  /**
   * 出库托盘沿出库路径往外走（每步推进 `queueSpeed × dt`）。
   *
   * 走到终点就停在那儿等外部取走——`shipped` 模式下等卡车，`recycle` 模式下等
   * `outUntil` 到点回队列。位置是"弧长 + 路径"的纯函数，快照恢复后继续走不会错位。
   */
  const advanceOutbound = (ctx: BehaviorContext, pallets: WorldEntityState[], layout: CraneLayout): void => {
    if (layout.outbound.total <= 1e-6) return;
    // 出库托盘在带上按"第几个出库"排成一列：队首走到路径终点（离卡车最近），
    // 后面的依次退后一个节距。卡车拉走队首后，其余整体往前挪一格——
    // 和入库队列同一套逻辑，方向相反。
    const outbound = pallets
      .filter((pallet) => pallet.attrs.state === 'outbound')
      .sort((a, b) => num(a.attrs.outOrder, 0) - num(b.attrs.outOrder, 0) || (a.id < b.id ? -1 : 1));

    outbound.forEach((pallet, rank) => {
      const target = Math.max(0, layout.outbound.total - rank * queuePitch);
      const current = num(pallet.attrs.outpos, target);
      const next = approach(current, target, queueSpeed * ctx.dt);
      if (next === current) return; // 已就位：不再每步刷帧差量
      ctx.setAttr(pallet.id, 'outpos', next);
      const [px, pz] = samplePolyline(layout.outbound, next);
      ctx.setTransform(pallet.id, { position: [px, layout.ioY + PALLET_SEAT, pz] });
    });
  };

  /**
   * 出库等待结束的托盘回到入库队列尾部（= 外部补进一块新托盘）。
   *
   * 只用于 `recycle` 模式（托盘池闭环的演示场景）；`shipped` 模式下出库托盘
   * 由卡车 `despawn` 掉，不会回流。
   */
  const requeueExpired = (ctx: BehaviorContext, crane: WorldEntityState, pallets: WorldEntityState[], layout: CraneLayout): void => {
    if (layout.outboundMode !== 'recycle') return;
    let order = num(crane.attrs.__order, 0);
    for (const pallet of pallets) {
      if (pallet.attrs.state !== 'outbound') continue;
      if (ctx.time < num(pallet.attrs.outUntil, 0)) continue;
      ctx.setAttr(pallet.id, 'state', 'queued');
      ctx.setAttr(pallet.id, 'order', order);
      ctx.setAttr(pallet.id, 'qpos', layout.queue.total);
      ctx.setAttr(pallet.id, 'outUntil', 0);
      order += 1;
    }
    if (order !== num(crane.attrs.__order, 0)) ctx.setAttr(crane.id, '__order', order);
  };

  /**
   * 每圈一次的任务决策（FIFO）：
   * - 队列里有货、有空货位、且库存没到高水位 → 入库（取队列头）；
   * - 否则货架非空 → 出库（取入架序号最小）。
   *
   * `highWater` 让产线"边进边出"：库存到线就转去出库，而不是等货位填满
   * 才开始往外送（真实仓库也这么干，否则卡车要等到满库才有货）。
   */
  const planTask = (ctx: BehaviorContext, crane: WorldEntityState, pallets: WorldEntityState[], layout: CraneLayout): void => {
    const stored = pallets.filter((pallet) => pallet.attrs.state === 'stored');
    const queued = pallets.filter((pallet) => pallet.attrs.state === 'queued').sort(queueOrder);
    const head = queued[0];
    const freeSlot = layout.slots.find((slot) => !stored.some((pallet) => pallet.attrs.slot === slot.key));

    if (head && freeSlot && stored.length < layout.highWater) {
      ctx.setAttr(crane.id, '__task', 'store');
      ctx.setAttr(crane.id, '__taskPallet', head.id);
      ctx.setAttr(crane.id, '__taskSlot', freeSlot.key);
      // 队列头被取走：交给货叉，队列位置不再由队列逻辑写。
      ctx.setAttr(head.id, 'state', 'carrying-in');
      ctx.setTransform(head.id, { position: [layout.aisleX, layout.ioY + CARRIED_SEAT, layout.ioZ] });
      return;
    }
    if (stored.length > 0) {
      const oldest = stored.reduce((a, b) => (num(a.attrs.seq, 0) <= num(b.attrs.seq, 0) ? a : b));
      ctx.setAttr(crane.id, '__task', 'retrieve');
      ctx.setAttr(crane.id, '__taskPallet', oldest.id);
      ctx.setAttr(crane.id, '__taskSlot', str(oldest.attrs.slot, ''));
      return;
    }
    ctx.setAttr(crane.id, '__task', 'idle');
    ctx.setAttr(crane.id, '__taskPallet', '');
    ctx.setAttr(crane.id, '__taskSlot', '');
  };

  /**
   * 出料带上的托盘：沿**打包站声明的路径**（托盘自己的 `config.path`）往队列尾走，
   * 走到头就入队。
   *
   * 这段刻意不用内核 motion：打包站生成的托盘如果带 motion，内核每步都会把它拉回
   * 路径终点，和货架行为写的货位/出库带位置打架（踩过一次）。所以托盘从出生起
   * 位姿就全程归本行为管，"conveying → queued"只是状态切换。
   */
  const advanceConveying = (ctx: BehaviorContext, crane: WorldEntityState, pallets: WorldEntityState[], layout: CraneLayout): void => {
    let order = num(crane.attrs.__order, 0);
    let changed = false;
    for (const pallet of pallets) {
      if (pallet.attrs.state !== 'conveying') continue;
      const line = measurePolyline(toXZ(vectorList(pallet.config?.path)));
      const speed = Math.max(0.05, num(pallet.config?.speed, queueSpeed));
      const total = line.total;
      const current = num(pallet.attrs.inpos, 0);
      const next = total > 1e-6 ? approach(current, total, speed * ctx.dt) : total;

      if (total > 1e-6 && next !== current) {
        ctx.setAttr(pallet.id, 'inpos', next);
        const [px, pz] = samplePolyline(line, next);
        ctx.setTransform(pallet.id, { position: [px, layout.ioY + PALLET_SEAT, pz] });
      }
      if (next < total - 1e-6) continue; // 还在路上

      ctx.setAttr(pallet.id, 'state', 'queued');
      ctx.setAttr(pallet.id, 'order', order);
      ctx.setAttr(pallet.id, 'qpos', layout.queue.total);
      order += 1;
      changed = true;
    }
    if (changed) ctx.setAttr(crane.id, '__order', order);
  };

  /** 队列滚动：按 order 排队，目标弧长 = 名次 × 节距，位置沿折线插值。 */
  const rollQueue = (ctx: BehaviorContext, pallets: WorldEntityState[], layout: CraneLayout): void => {
    const queued = pallets.filter((pallet) => pallet.attrs.state === 'queued').sort(queueOrder);
    queued.forEach((pallet, rank) => {
      const target = rank * queuePitch;
      const current = num(pallet.attrs.qpos, target);
      const next = approach(current, target, queueSpeed * ctx.dt);
      const moved = Math.abs(next - current) > 1e-9;
      if (moved) ctx.setAttr(pallet.id, 'qpos', next);
      if (moved || num(pallet.attrs.__qrank, -1) !== rank) {
        const [px, pz] = samplePolyline(layout.queue, next);
        ctx.setTransform(pallet.id, { position: [px, layout.ioY + PALLET_SEAT, pz] });
        ctx.setAttr(pallet.id, '__qrank', rank);
      }
    });
  };

  /**
   * 把"库存 / 占用 / 本圈任务"发布成 attrs，给检视面板与 HUD 读。
   *
   * 只在这些值真的变了才写，避免每步刷帧差量（渲染层按 attrs 变化更新）。
   */
  const publishStatus = (
    ctx: BehaviorContext,
    crane: WorldEntityState,
    pallets: WorldEntityState[],
    layout: CraneLayout,
    racks: WorldEntityState[],
  ): void => {
    const capacityPerSide = layout.slots.length / 2;
    const stored = pallets.filter((pallet) => pallet.attrs.state === 'stored');
    // 只遍历这台吊车名下的货架（已按 craneId 预分组），不再扫全部实体。
    for (const rack of racks) {
      const side = num(rack.config?.side, 0) === 1 ? 1 : 0;
      const used = stored.filter((pallet) => str(pallet.attrs.slot, '').startsWith(`${side}:`)).length;
      if (num(rack.attrs.used, -1) !== used || num(rack.attrs.capacity, -1) !== capacityPerSide) {
        ctx.setAttr(rack.id, 'used', used);
        ctx.setAttr(rack.id, 'capacity', capacityPerSide);
      }
    }
    // 堆垛机：当前任务 + 库存水位 + 下一块要出库的托盘（先入先出的队首）。
    const oldest = stored.reduce<WorldEntityState | undefined>(
      (a, b) => (a === undefined || num(b.attrs.seq, 0) < num(a.attrs.seq, 0) ? b : a),
      undefined,
    );
    const task = str(crane.attrs.__task, 'idle');
    const nextOut = oldest?.id ?? '';
    if (str(crane.attrs.task, '') !== task) ctx.setAttr(crane.id, 'task', task);
    if (num(crane.attrs.stock, -1) !== stored.length) ctx.setAttr(crane.id, 'stock', stored.length);
    if (str(crane.attrs.nextOut, '') !== nextOut) ctx.setAttr(crane.id, 'nextOut', nextOut);

    // 入库队列还剩几个位子——打包站靠它做背压（在路上的 conveying 也算占位）。
    const capacity = Math.max(1, Math.floor(layout.queue.total / queuePitch) + 1);
    const occupied = pallets.filter((pallet) => pallet.attrs.state === 'queued' || pallet.attrs.state === 'conveying').length;
    const queueFree = Math.max(0, capacity - occupied);
    if (num(crane.attrs.queueFree, -1) !== queueFree) ctx.setAttr(crane.id, 'queueFree', queueFree);
  };

  return {
    id: 'asrs-cycle',
    step(ctx: BehaviorContext): void {
      const cranes = ctx.entities.filter((entity) => entity.capabilities.includes(craneCap));
      if (cranes.length === 0) return;

      // 托盘按归属的堆垛机分组（托盘是场景预置的实体池）。
      const byCrane = new Map<string, WorldEntityState[]>();
      for (const entity of ctx.entities) {
        if (!entity.capabilities.includes(palletCap)) continue;
        const carrier = str(entity.config?.carrier, '');
        if (!carrier) continue;
        const list = byCrane.get(carrier);
        if (list) list.push(entity);
        else byCrane.set(carrier, [entity]);
      }

      // 货架按归属的堆垛机分组：同理一次性建索引，避免 publishStatus 里每台吊车扫描
      // 全部实体（O(吊车数 × 实体数) = O(N²)，副本翻倍时平方级恶化）。
      const racksByCrane = new Map<string, WorldEntityState[]>();
      for (const entity of ctx.entities) {
        if (entity.kind !== 'asrs') continue;
        const owner = str(entity.config?.craneId, '');
        if (!owner) continue;
        const list = racksByCrane.get(owner);
        if (list) list.push(entity);
        else racksByCrane.set(owner, [entity]);
      }

      for (const crane of cranes) {
        const pallets = byCrane.get(crane.id);
        if (!pallets || pallets.length === 0) continue;
        const layout = craneLayout(crane, queuePitch);
        const dwell = config.outboundDwell ?? layout.cycle * 1.1;

        initPallets(ctx, crane, pallets, layout);

        // 位置只依赖时间，seek 到哪一帧都算得出同一姿态。
        const raw = ctx.time / layout.cycle + layout.phase;
        const u = raw - Math.floor(raw);
        const lap = Math.floor(raw);

        // 每圈开头一次：交接上一圈取回来的托盘 → 让等够了的托盘回队列 → 决定本圈任务。
        if (lap > num(crane.attrs.__lap, -1)) {
          releaseCarriedOut(ctx, crane, pallets, layout, dwell);
          requeueExpired(ctx, crane, pallets, layout);
          planTask(ctx, crane, pallets, layout);
          ctx.setAttr(crane.id, '__lap', lap);
        }

        // 出料带上走到头的托盘入队；已在出库路径上的托盘继续往外走。
        advanceConveying(ctx, crane, pallets, layout);
        advanceOutbound(ctx, pallets, layout);

        const task = readTask(crane);
        const slot = layout.slots.find((item) => item.key === task.slotKey);
        const dir = slot ? (slot.side === 0 ? -1 : 1) : 1;
        const zTarget = slot ? slot.position[2] : layout.ioZ;
        const levelY = slot ? slot.levelY : layout.ioY;

        // 取货任务要不要"载货出巷"：声明了 outfeedTravelZ 就一路走到卸货点。
        const trip = task.kind === 'retrieve' && layout.outfeedTravelZ !== undefined;
        const outZ = layout.outfeedTravelZ ?? layout.ioZ;
        // 卸货时货叉要伸多远：取 `outfeedX` 与巷道的距离（和货位共用同一套 reach 语义）。
        const outReach = layout.outfeed.length ? Math.abs(layout.outfeed[0]![0] - layout.aisleX) : 0;

        // 六拍：出车 / 起升 / 伸叉 / 换载 / 收叉 / 回程 / 下降
        // 载货出巷时多两拍：换载后先走到卸货点（并同步下降），伸叉卸货，再空车回巷道口。
        const outTravel = ramp(u, 0.06, trip ? 0.38 : 0.4);
        const up = ramp(u, 0.12, trip ? 0.4 : 0.44);
        const down = ramp(u, trip ? 0.6 : 0.66, trip ? 0.76 : 0.94);
        const z = trip
          ? layout.ioZ +
            (zTarget - layout.ioZ) * outTravel +
            (outZ - zTarget) * ramp(u, 0.6, 0.76) -
            (outZ - layout.ioZ) * ramp(u, 0.8, 0.97)
          : layout.ioZ + (zTarget - layout.ioZ) * (outTravel - ramp(u, 0.64, 0.92));
        const y = layout.ioY + (levelY - layout.ioY) * (up - down);

        const pickExtend = slot ? layout.reach * (ramp(u, 0.44, 0.52) - ramp(u, 0.56, 0.64)) : 0;
        const dropExtend = trip ? outReach * (ramp(u, 0.68, 0.76) - ramp(u, 0.8, 0.88)) : 0;
        const forkAt = layout.aisleX + dir * pickExtend + layout.outfeedDir * dropExtend;

        ctx.setTransform(crane.id, { position: [layout.aisleX, 0, z] });

        const carriage = derived(ctx, crane.id, carriageSuffix);
        if (carriage) ctx.setTransform(carriage.id, { position: [layout.aisleX, y, z] });

        const fork = derived(ctx, crane.id, forkSuffix);
        if (fork) ctx.setTransform(fork.id, { position: [forkAt, y, z] });

        // 托盘：入库时全程坐在货叉上（前半圈），出库时后半圈才被叉起来；
        // 载货出巷时到 DROP_U 就卸下——之后货叉缩回、门架空车返回，托盘留在卸货点。
        const carried = task.palletId ? ctx.entity(task.palletId) : undefined;
        if (carried && slot) {
          const onFork = task.kind === 'store' ? u < HANDOVER_U : u >= HANDOVER_U && u < (trip ? DROP_U : 1);
          if (onFork) {
            // 卸货时不加偏移：让放下那一刻的位置正好等于 outfeedX，
            // 下一圈 releaseCarriedOut 落位时才是零位移（否则会有 0.1m 的跳变）。
            const seat = trip && u >= 0.68 ? 0 : dir * 0.1;
            ctx.setTransform(carried.id, {
              position: [forkAt + seat, y + CARRIED_SEAT, z],
            });
          }
        }

        // 换载瞬间：入库 → 货位落位；出库 → 从货位取上货叉。用圈次幂等，不靠浮点比较。
        if (slot && task.palletId && u >= HANDOVER_U) {
          const pallet = ctx.entity(task.palletId);
          if (pallet && task.kind === 'store' && lap > num(crane.attrs.__storeLap, -1)) {
            const seq = num(crane.attrs.__seq, 0) + 1;
            ctx.setAttr(crane.id, '__seq', seq);
            ctx.setAttr(pallet.id, 'state', 'stored');
            ctx.setAttr(pallet.id, 'slot', slot.key);
            ctx.setAttr(pallet.id, 'seq', seq);
            ctx.setAttr(pallet.id, 'storedAt', ctx.time);
            ctx.setTransform(pallet.id, { position: [...slot.position] });
            ctx.setAttr(crane.id, '__storeLap', lap);
            ctx.emit(storeType, {
              entityId: crane.id,
              payload: {
                lap,
                pallet: pallet.id,
                slot: slot.key,
                side: slot.side === 0 ? 'near' : 'far',
                level: slot.level + 1,
                height: slot.levelY,
                column: slot.column,
                seq,
              },
            });
          }
          if (pallet && task.kind === 'retrieve' && lap > num(crane.attrs.__pickLap, -1)) {
            ctx.setAttr(pallet.id, 'state', 'carrying-out');
            ctx.setAttr(crane.id, '__pickLap', lap);
            ctx.emit(retrieveType, {
              entityId: crane.id,
              payload: {
                lap,
                pallet: pallet.id,
                slot: slot.key,
                side: slot.side === 0 ? 'near' : 'far',
                level: slot.level + 1,
                height: slot.levelY,
                column: slot.column,
                seq: num(pallet.attrs.seq, 0),
                dwell: Math.max(0, ctx.time - num(pallet.attrs.storedAt, ctx.time)),
              },
            });
          }
        }

        rollQueue(ctx, pallets, layout);
        publishStatus(ctx, crane, pallets, layout, racksByCrane.get(crane.id) ?? []);
      }
    },
  };
}
