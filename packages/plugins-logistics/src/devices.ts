import type { TwinEntity, TwinVector3 } from '@twin-platform/scene-schema';

/**
 * 物流设备实体工厂。
 *
 * 这里只产出"声明"（TwinEntity），不产逻辑——逻辑全在 `behavior.ts`。
 * 设备语义被拆成三类能力：`move`（输送）、`inspect`（检测）、`store`/`buffer`（缓存）、
 * `sort`（分拣）。内核不认这些词，只认 `capabilities` 数组，所以加一种新设备
 * 不必动内核，只在这里加一个工厂。
 */

export interface ConveyorOptions {
  label?: string;
  color?: string;
  size?: TwinVector3;
  /**
   * **必须显式声明**这条线沿哪个轴铺：`'x'` 长边给 X、`'z'` 长边给 Z。
   *
   * 渲染层原来靠 `sizeZ > sizeX` 猜走向——短接驳段（比如 0.9m 长 × 1.4m 宽）
   * 会被误判成"沿 Z 铺"，整段转 90°、长宽互换，滚筒轴和箭头方向跟着全错。
   * 所以走向只能由声明决定，不能靠尺寸比较。
   */
  axis?: 'x' | 'z';
  /**
   * 皮带箭头流动方向：`+1` 顺 local +X，`-1` 逆行。
   * 沿 X 铺设时 local +X = 世界 +X；沿 Z 铺设时模型会转 90°，local +X = 世界 -Z。
   * 按物料实际行进方向填，箭头才跟 path 一致。
   */
  beltDirection?: 1 | -1;
}

/** 一段静态输送线（无自身运动，只作视觉与设备占位）。 */
export function conveyorSegment(id: string, position: TwinVector3, options: ConveyorOptions = {}): TwinEntity {
  return {
    id,
    kind: 'transport',
    transform: { position },
    capabilities: ['move'],
    visual: { kind: 'box', color: options.color ?? '#22c55e', size: options.size ?? [3, 0.6, 1.4] },
    config: {
      label: options.label ?? id,
      beltAxis: options.axis ?? 'x',
      beltDirection: options.beltDirection ?? 1,
    },
  };
}

/** 视觉检测站：有 `zoneHalfWidth` 表示它"罩"住中心线两侧多远。 */
export function inspectionStation(id: string, position: TwinVector3, zoneHalfWidth = 1.6): TwinEntity {
  return {
    id,
    kind: 'inspect',
    transform: { position },
    capabilities: ['inspect'],
    visual: { kind: 'box', color: '#38bdf8', size: [1.6, 1.6, 1.6] },
    config: { label: id, zoneHalfWidth },
  };
}

export interface PolylineOptions {
  label?: string;
  color?: string;
  /** 带宽（米）。 */
  width?: number;
  /** 箭头流动方向：+1 沿 `path` 点列顺序，-1 逆行。 */
  beltDirection?: number;
  /** 拐角倒圆半径，默认取带宽一半（= 半个模块，跟 90° 转角模块占地一致）。 */
  radius?: number;
}

/**
 * 折线输送线：一段线自己带 90° 拐，不再拆成"直段 + 独立转角模块"。
 *
 * `path` 是相对 `position` 的本地 [X, Z] 点列，按行进顺序给（起点 → 拐点 → 终点）。
 * 渲染层按 `radius` 把拐角倒圆、沿中心线连续扫掠出皮带面，箭头 UV 走弧长，
 * 所以人字形一定顺着 path 指，不会像直段那样只能沿单一轴流。
 */
export function conveyorPolyline(
  id: string,
  position: TwinVector3,
  path: readonly [number, number][],
  options: PolylineOptions = {},
): TwinEntity {
  const width = options.width ?? 1.4;
  return {
    id,
    kind: 'transport',
    transform: { position },
    capabilities: ['move'],
    visual: { kind: 'box', color: options.color ?? '#22c55e', size: [width, 0.6, width] },
    config: {
      label: options.label ?? id,
      beltPath: path.map(([px, pz]) => [px, pz] as [number, number]),
      beltWidth: width,
      beltDirection: options.beltDirection ?? 1,
      beltRadius: options.radius ?? width / 2,
    },
  };
}

export interface CornerOptions {
  label?: string;
  color?: string;
  size?: TwinVector3;
  /**
   * **入口处货物行进的方向**（不是"从哪一侧进来"）：`'x+' | 'x-' | 'z+' | 'z-'`。
   * 90° 弯道的圆弧由「进 / 出」这两个方向唯一确定，填反了弧线会朝外翻。
   */
  turnIn?: string;
  /** 出口处货物行进的方向，取值同 `turnIn`，且必须与 `turnIn` 垂直。 */
  turnOut?: string;
}

/**
 * 90° 弯曲输送线：一段真正的圆弧，把两条互相垂直的输送线接起来。
 *
 * 什么时候用它：**这一段线路只有一条、且没有别的功能**（不分流、不合流、不加工）
 * ——纯过路的拐弯。如果这个拐点还要承担分流 / 合流，就该上顶升移栽机。
 * 台面比直行皮带高 1cm 以避免 z-fighting（见 entityMeshes 的 buildCurvedConveyor）。
 */
export function conveyorCorner(id: string, position: TwinVector3, options: CornerOptions = {}): TwinEntity {
  return {
    id,
    kind: 'transport',
    transform: { position },
    capabilities: ['move'],
    visual: { kind: 'box', color: options.color ?? '#22c55e', size: options.size ?? [1.4, 0.6, 1.4] },
    config: {
      label: options.label ?? id,
      corner: true,
      cornerIn: options.turnIn ?? 'x+',
      cornerOut: options.turnOut ?? 'z-',
    },
  };
}

/** 缓存货架：能存料，没有覆盖区（不占中心线）。 */
export function bufferRack(id: string, position: TwinVector3): TwinEntity {
  return {
    id,
    kind: 'buffer',
    transform: { position },
    capabilities: ['store', 'buffer'],
    visual: { kind: 'box', color: '#f59e0b', size: [2.2, 2, 1.8] },
    config: { label: id },
  };
}

export interface ParcelOptions {
  label?: string;
  color?: string;
  size?: TwinVector3;
  /** 折角圆角半径：闭环路径给 0.2~0.8 才能拐出圆角，0 是尖角。 */
  cornerRadius?: number;
  /**
   * 路径循环方式：`'repeat'`（默认）闭环往复；`'clamp'` / `'none'` 走到终点停住，
   * 单向产线物料不回流（`'none'` 是口语写法，落到场景里统一成内核认识的 `'clamp'`）。
   */
  loop?: 'repeat' | 'clamp' | 'none';
}

/**
 * 在制物料：沿 `path` 以 `speed` m/s 循环前进（内核按 `loop: 'repeat'` 自动搬运）。
 * 行为插件靠检测"绕回起点"来发 `parcel:enter` / `parcel:exit`。
 *
 * 注意：`path` 必须首尾闭合（最后一个点等于第一个点），否则 `loop: 'repeat'`
 * 会让物料从终点瞬移回起点——那看起来就是"货物脱线乱飞"。
 */
export function parcel(id: string, path: TwinVector3[], speed: number, options: ParcelOptions = {}): TwinEntity {
  return {
    id,
    kind: 'parcel',
    transform: { position: path[0] ?? [0, 0, 0] },
    capabilities: ['parcel'],
    visual: { kind: 'box', color: options.color ?? '#f97316', size: options.size ?? [0.6, 0.6, 0.6] },
    // 'none' 只是"不回流"的口语说法，内核只认 clamp / repeat。
    motion: { points: path, speed, loop: options.loop === 'none' ? 'clamp' : (options.loop ?? 'repeat'), cornerRadius: options.cornerRadius ?? 0 },
    config: { label: options.label ?? id },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 立体仓库（AS/RS）
// ─────────────────────────────────────────────────────────────────────────

export interface AsrsRackOptions {
  label?: string;
  color?: string;
  /** 货位层数，默认按 `levelHeights` 的长度推，再退到 5。 */
  levels?: number;
  /** 沿长边的货位数（列），默认按长度推。 */
  bays?: number;
  /**
   * 每层货位的**实际高度**（米）。必须与同一巷道堆垛机 config.levels 用同一个数组，
   * 否则托盘会被放到横梁以外的空中——渲染层也按它铺横梁。
   */
  levelHeights?: number[];
  /** 该货架排服务哪台堆垛机（= 巷道）。行为靠它把货架和堆垛机配对，写占用率。 */
  craneId?: string;
  /** 货架在巷道的哪一侧：0 = 堆垛机 forkX[0] 那侧，1 = forkX[1] 那侧。 */
  side?: 0 | 1;
}

/**
 * 高层货架：一座立体仓库的货架排。`size` 为 [宽(X), 高(Y), 长(Z)]，
 * 长边即货架延伸方向（巷道在它侧面）。
 *
 * 只声明几何与能力，不声明运动——它不动，动的是堆垛机。
 * 货位上有没有托盘**不由这里声明**：托盘是场景里独立的实体（见 `pallet`），
 * 由 `asrs-cycle` 行为按先入先出搬进搬出，所以点得中、数量也会变。
 */
export function asrsRack(
  id: string,
  position: TwinVector3,
  size: TwinVector3,
  options: AsrsRackOptions = {},
): TwinEntity {
  const levelHeights = options.levelHeights ?? [];
  return {
    id,
    kind: 'asrs',
    transform: { position },
    capabilities: ['rack'],
    visual: { kind: 'box', color: options.color ?? '#B5EAD7', size },
    config: {
      label: options.label ?? id,
      levels: options.levels ?? (levelHeights.length || 5),
      levelHeights,
      bays: options.bays ?? Math.max(2, Math.round(Math.max(size[0], size[2]) / 1.8)),
      craneId: options.craneId ?? '',
      side: options.side ?? 0,
    },
  };
}

/** 堆垛机运行循环参数，全部放在 config 里，行为只读不写。 */
export interface StackerCycleConfig {
  /** 巷道中心线 X。 */
  aisleX: number;
  /** 出入库交接点 Z（巷道口）。 */
  ioZ: number;
  /** 交接高度 Y（与输送线台面齐平）。 */
  ioY: number;
  /** 货架区起止 Z。 */
  zMin: number;
  zMax: number;
  /** 可取货位高度（Y）。 */
  levels: number[];
  /** 目标列数（沿 Z 均分）。 */
  columns: number;
  /** 一个完整存取循环的秒数。 */
  cycle: number;
  /** 相位偏移 0~1，用来让两台堆垛机错开。 */
  phase: number;
  /** 货叉最大伸出距离。 */
  reach: number;
  /** 左/右两侧货架的货位 X。 */
  forkX: [number, number];
  /**
   * 入库载货站台（L 形）**横段西端**的 X：托盘在这里排队等堆垛机取货。
   * 不给就按 `aisleX - 4` 推（= 默认 IO_SPAN）。
   */
  stationX?: number;
  /**
   * 出库接驳带上的货位 Z 列表（托盘出库后在这里等待被"外部取走"）。
   * 出库接驳带沿 X = outfeedX 铺开，所以只需要给 Z。
   */
  outfeedZ?: number[];
  /** 出库接驳带的 X，默认 = stationX（与入库站台同侧）。 */
  outfeedX?: number;
  /**
   * 出库卸货点 Z：声明后，取货任务**不再回巷道口**，而是载着托盘沿巷道走到这个
   * Z（通常在货架另一端之外）再放下，空车才返回；不声明则沿用旧行为回 `ioZ`
   * （出库口与入库队列同侧时只能这样，但托盘会从巷道口瞬移到缓存台）。
   *
   * asrs 行为的布局计算一直在读它，**工厂侧的这个类型却漏了**——于是模板写
   * `outfeedTravelZ` 时反而类型报错（TS2353）。补声明是为了让类型说实话。
   */
  outfeedTravelZ?: number;
  /** 出库卸货时货叉伸向哪一侧：+1 朝 +X，-1 朝 -X（不给默认 +1）。 */
  outfeedDir?: number;
  /**
   * 出库托盘从取货点走到出库货位的路径（世界坐标）。
   * 不给就直接落到货位上——那看起来是瞬移，只在"出库带与站台同侧、路径会穿过
   * 入库队列"时才这么退化（见 logistics-center）。
   */
  outboundPath?: TwinVector3[];
  /**
   * 出库托盘的去向：
   * - `'recycle'`（默认）等一会儿回到入库队列尾——托盘池闭环，适合演示场景；
   * - `'shipped'` 停在出库货位上等卡车拉走——真正的产线闭环（有外部消耗方）。
   */
  outboundMode?: 'recycle' | 'shipped';
  /** 库存高水位：到线就转去出库（默认不限，货位填满才出库）。 */
  highWater?: number;
}

export interface StackerOptions {
  label?: string;
  color?: string;
  cycle: StackerCycleConfig;
}

/** 堆垛机门架：沿巷道（Z）行走，高度固定，载货台与货叉由行为单独驱动。 */
export function stackerCrane(id: string, position: TwinVector3, options: StackerOptions): TwinEntity {
  return {
    id,
    kind: 'stacker',
    transform: { position },
    capabilities: ['stacker'],
    visual: { kind: 'box', color: options.color ?? '#C4B5E0', size: [1, 5.4, 1.6] },
    config: { label: options.label ?? id, ...options.cycle },
  };
}

/** 载货台：跟着门架走 Z，同时沿立柱升到货位高度。 */
export function stackerCarriage(id: string, position: TwinVector3, color?: string, label?: string): TwinEntity {
  return {
    id,
    kind: 'carriage',
    transform: { position },
    capabilities: ['carriage'],
    visual: { kind: 'box', color: color ?? '#C4B5E0', size: [0.92, 0.34, 1.2] },
    config: { label: label ?? id },
  };
}

/** 货叉：跟着载货台升降，并沿 X 伸进货架取放。 */
export function stackerFork(id: string, position: TwinVector3, color?: string, label?: string): TwinEntity {
  return {
    id,
    kind: 'fork',
    transform: { position },
    capabilities: ['fork'],
    visual: { kind: 'box', color: color ?? '#8BD3C7', size: [1.1, 0.14, 0.9] },
    config: { label: label ?? id },
  };
}

export interface PalletOptions {
  label?: string;
  color?: string;
  /**
   * 这块托盘归哪台堆垛机（= 哪个巷道）管。`asrs-cycle` 行为按它把托盘分组：
   * 一组托盘共享一条入库队列和一条巷道的货位。
   */
  carrier?: string;
}

/**
 * 托盘（货架上的存货单位）。
 *
 * 托盘是**独立实体**，不是货架模型的一部分：货架只声明"有哪些货位"，
 * 托盘由 `asrs-cycle` 行为在"入库队列 → 货位 → 出库接驳带"之间搬运，
 * 所以它在场景里点得中、在物料列表里看得到、数量也会随存取变化。
 */
export function pallet(id: string, position: TwinVector3, options: PalletOptions = {}): TwinEntity {
  return {
    id,
    kind: 'pallet',
    transform: { position },
    capabilities: ['pallet'],
    visual: { kind: 'box', color: options.color ?? '#FFDAC1', size: [0.8, 0.56, 1] },
    config: { label: options.label ?? id, carrier: options.carrier ?? '' },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 生产线：发生器 / 打包站 / 卡车
// ─────────────────────────────────────────────────────────────────────────

export interface GoodsSourceOptions {
  label?: string;
  color?: string;
  /** 产出间隔（秒）。 */
  interval?: number;
  /** 在制品上限（背压）：线上一超过就暂停产出，直到被消耗掉。 */
  maxWip?: number;
  /** 小货物沿哪条路径走（世界坐标，首尾闭合，内核按 loop:'repeat' 搬运）。 */
  goodsPath: TwinVector3[];
  /** 小货物速度（m/s）。 */
  goodsSpeed?: number;
  goodsColor?: string;
  goodsSize?: TwinVector3;
  /** 闭环拐角的圆角半径。 */
  goodsCornerRadius?: number;
  /** 小货物的能力标记，默认 `parcel`（这样流转/指标行为能直接认出来）。 */
  goodsCapability?: string;
}

/**
 * 小货物发生器：一处持续产出。
 *
 * 行为插件按 `interval` 生成实体（内核 `ctx.spawn`），小货物沿 `goodsPath`
 * 循环前进，直到在打包站被吃掉。线上在制品达到 `maxWip` 就暂停产出——
 * 这是最朴素也最必要的背压，否则发生器会把场景塞爆。
 */
export function goodsSource(id: string, position: TwinVector3, options: GoodsSourceOptions): TwinEntity {
  return {
    id,
    kind: 'source',
    transform: { position },
    capabilities: ['source'],
    visual: { kind: 'box', color: options.color ?? '#A7D8F0', size: [1.4, 1.6, 1.4] },
    config: {
      label: options.label ?? id,
      interval: options.interval ?? 5,
      maxWip: options.maxWip ?? 10,
      goodsPath: options.goodsPath.map((point) => [...point]),
      goodsSpeed: options.goodsSpeed ?? 1.1,
      goodsColor: options.goodsColor ?? '#F4A261',
      goodsSize: options.goodsSize ?? [0.55, 0.55, 0.55],
      goodsCornerRadius: options.goodsCornerRadius ?? 0.4,
      goodsCapability: options.goodsCapability ?? 'parcel',
    },
  };
}

export interface PackingStationOptions {
  label?: string;
  color?: string;
  /** 几个小货物合成一个大货物，默认 2。 */
  batch?: number;
  /** 认领半径（米，只看 XZ）。 */
  radius?: number;
  /** 大货物（托盘）从站台出来的路径（世界坐标，走到终点停下）。 */
  palletPath: TwinVector3[];
  palletSpeed?: number;
  palletSize?: TwinVector3;
  palletColor?: string;
  /** 产出的大货物归哪台堆垛机管（写进 config.carrier）。 */
  carrier?: string;
  /** 大货物的能力标记，默认 `pallet`。 */
  palletCapability?: string;
}

/**
 * 打包站：把 `batch` 个小货物合成 1 个大货物。
 *
 * 小货物被消耗（despawn）、大货物被生成（spawn），都是真事件；
 * 大货物沿 `palletPath` 自己走到立库入库队列尾，等堆垛机取走。
 */
export function packingStation(id: string, position: TwinVector3, options: PackingStationOptions): TwinEntity {
  return {
    id,
    kind: 'pack',
    transform: { position },
    capabilities: ['pack'],
    visual: { kind: 'box', color: options.color ?? '#F7C8A0', size: [2, 1.7, 2] },
    config: {
      label: options.label ?? id,
      batch: options.batch ?? 2,
      radius: options.radius ?? 1.8,
      palletPath: options.palletPath.map((point) => [...point]),
      palletSpeed: options.palletSpeed ?? 0.9,
      palletSize: options.palletSize ?? [0.8, 0.56, 1],
      palletColor: options.palletColor ?? '#FFDAC1',
      carrier: options.carrier ?? '',
      palletCapability: options.palletCapability ?? 'pallet',
    },
  };
}

export interface LabelingMachineOptions {
  label?: string;
  color?: string;
  /** 贴标触发半径（米）：货物中心进入这个圆圈就贴一张标签。 */
  radius?: number;
  /** 被贴标的货物能力标记，默认 `pallet`。 */
  cargoCapability?: string;
}

/**
 * 打标机 / 贴标机：跨在输送线上的龙门工位，货物从底下经过就贴一张标签。
 *
 * 和检测站（`inspect`）的区别：检测站只判忙闲，打标机会**真的改状态**——
 * 给经过的货物打上 `labeled`，并发出 `label:applied` 事件，所以"这箱货贴没贴标"
 * 是能查、能回放的。每块货只贴一次（`labeled` 打上就不再触发），
 * 货被卡车拉走后新货重新贴。
 */
export function labelingMachine(id: string, position: TwinVector3, options: LabelingMachineOptions = {}): TwinEntity {
  return {
    id,
    kind: 'labeler',
    transform: { position },
    capabilities: ['labeler'],
    // Z 向深度取 1.4 = 一条皮带的宽度：龙门骑在带上，再深就会蹭到旁边
    // 平行铺的皮带（立库 L 形站台的水平段就在 z=5，离这条带只有 1.4m）。
    visual: { kind: 'box', color: options.color ?? '#9FD8F0', size: [1.8, 2.2, 1.4] },
    config: {
      label: options.label ?? id,
      radius: options.radius ?? 1.2,
      cargoCapability: options.cargoCapability ?? 'pallet',
    },
  };
}

export interface TruckOptions {
  label?: string;
  color?: string;
  /** 装车货位（世界坐标）：出库托盘送到这里上车。 */
  dock: TwinVector3;
  /** 行驶路线（dock → 门外 → …），到达终点即离场。 */
  route: TwinVector3[];
  speed?: number;
  /** 一趟最多拉几个大货物。 */
  capacity?: number;
  /** 在货位等货的时间（秒）。 */
  dwell?: number;
  /** 离场后在门外待多久再回来（秒）。 */
  awayTime?: number;
  /** 认领半径（米）：货位附近多远内的大货物算"可以装车"。 */
  loadRadius?: number;
  /** 装载的货物能力标记，默认 `pallet`。 */
  cargoCapability?: string;
}

/**
 * 卡车：产线的**出口**（外部消耗方）。
 *
 * 在货位等货 → 装满（或等到 `dwell` 且至少一件）→ 沿 `route` 驶离 → 在门外等
 * `awayTime` → 回来。装走的托盘会被真正移除（despawn），所以整条线是
 * "产出 → 输送 → 打包 → 入库 → 出库 → 运走"的闭环，不会在场景里越堆越多。
 */
export function truck(id: string, position: TwinVector3, options: TruckOptions): TwinEntity {
  return {
    id,
    kind: 'truck',
    transform: { position },
    capabilities: ['truck'],
    visual: { kind: 'box', color: options.color ?? '#C4B5E0', size: [2.2, 2.4, 6] },
    config: {
      label: options.label ?? id,
      dock: [...options.dock],
      route: options.route.map((point) => [...point]),
      speed: options.speed ?? 2.4,
      capacity: options.capacity ?? 4,
      dwell: options.dwell ?? 6,
      awayTime: options.awayTime ?? 10,
      loadRadius: options.loadRadius ?? 2.2,
      cargoCapability: options.cargoCapability ?? 'pallet',
    },
  };
}

export interface LiftTransferOptions {
  label?: string;
  color?: string;
  /** 台面尺寸（沿 X 长、沿 Z 宽）。宽度要和接入的输送线一致，货物才滚得过去。 */
  size?: TwinVector3;
  /** 托举高度（米）：把货物顶离滚筒，好让横向传动轴送出去。 */
  liftHeight?: number;
  /**
   * 会在此处被**横向分流**的物料 id；不在表里的货物直着滚过去，不顶升。
   * 由场景模板声明——它同时生成路径和移栽机，所以知道谁该拐弯。
   */
  divertIds?: string[];
  /** 顶升 / 下降耗时（秒）。 */
  upTime?: number;
  downTime?: number;
  /** 台面滚筒的滚动方向：+1 顺 local +X（= 世界 +X），-1 逆行。 */
  beltDirection?: 1 | -1;
  /** 顶起后链带把货送向哪一侧：+1 沿世界 +Z，-1 沿 -Z。 */
  divertSign?: 1 | -1;
  /**
   * 'divert' = 主线上的货被顶向支路（中央 → 边缘）；
   * 'merge'  = 支路的货并入主线（边缘 → 中央）。
   * 两者的认领判据相反，用错会把货往回推，不能混。
   */
  mode?: 'divert' | 'merge';
  /**
   * 双向：同一台机器兼做"顶进支路"和"从支路接回"。
   * 认领时按货从哪一侧驶入决定顶送方向——从台面中央那侧来 → +divertSign，
   * 从 +Z 支路那侧来 → −divertSign。用于立库载货站台这种进出共用一台的场合。
   */
  bidirectional?: boolean;
}

/**
 * 顶升移栽机（分流转接台）。
 *
 * 真机怎么干活，这里就怎么建模：
 * - 台面与所接入的输送线**同宽**，串在线里，货物直接滚上来；
 * - 一排滚筒（轴垂直于流向）把货物继续往前推，跟两侧皮带一模一样；
 * - 滚筒缝隙里藏着一组顶升链带，缩在滚筒线以下（idle 时货压在滚筒上）；
 * - 要分流的货来了，链带顶起把货抬离滚筒，链条转起来把货**垂直**送出去，
 *   然后落回缝里，下一个货继续直着滚过去。
 *
 * cassette 是独立实体（`liftTransferCassette`）：渲染层只认 position，
 * "顶升"这种相对位移必须靠子实体表达（和堆垛机拆门架/载货台/货叉同理）。
 */
export function liftTransfer(id: string, position: TwinVector3, options: LiftTransferOptions = {}): TwinEntity {
  return {
    id,
    kind: 'transfer',
    transform: { position },
    capabilities: ['transfer', 'lift'],
    visual: { kind: 'box', color: options.color ?? '#C4B5E0', size: options.size ?? [1.6, 0.6, 1.4] },
    config: {
      label: options.label ?? id,
      liftHeight: options.liftHeight ?? 0.13,
      divertIds: options.divertIds ?? [],
      upTime: options.upTime ?? 0.18,
      downTime: options.downTime ?? 0.18,
      beltDirection: options.beltDirection ?? 1,
      divertSign: options.divertSign ?? -1,
      transferMode: options.mode ?? 'divert',
      bidirectional: options.bidirectional ?? false,
    },
  };
}

/**
 * 顶升移栽机的托举座：滚筒缝隙里那组顶升链带，由 `transfer-cycle` 抬升。
 *
 * 台面尺寸必须和 `liftTransfer` 一致——两边共用同一套节距算链带位置，
 * 宽度不同链带就会跑到滚筒上而不是缝里。
 */
export function liftTransferCassette(
  id: string,
  position: TwinVector3,
  color?: string,
  label?: string,
  size: TwinVector3 = [1.6, 0.14, 1.4],
  divertSign = -1,
): TwinEntity {
  return {
    id,
    kind: 'cassette',
    transform: { position },
    capabilities: ['cassette'],
    visual: { kind: 'box', color: color ?? '#F4A261', size },
    config: { label: label ?? id, divertSign },
  };
}
