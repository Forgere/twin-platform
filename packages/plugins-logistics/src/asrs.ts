import type { BehaviorContext, WorldBehavior, WorldEntityState } from '@twin-platform/world-kernel';

/**
 * 堆垛机存取循环行为。
 *
 * 与 `logistics-flow` 的分工：那条只"读懂内核搬运结果"，这条反过来——
 * 它自己就是运动源，用 `ctx.setTransform` 直接写门架 / 载货台 / 货叉 / 托盘的位姿。
 *
 * 位置是**时间的纯函数**（`u = (t / cycle + phase) mod 1`），不是累加状态：
 * - 同种子同时间必定同一位姿，满足确定性；
 * - 时间轴 seek 到任意点都能立刻算出正确姿态，不需要回放前面的帧。
 *
 * 一个循环拆成六拍：巷道口取货 → 走到目标列并起升 → 货叉伸出 → 放货 →
 * 货叉收回 → 回到巷道口并下降。目标列 / 货位层 / 左右侧按圈次轮转，
 * 所以看久了能看出"堆垛机在轮流填不同货位"。
 */

export interface AsrsBehaviorConfig {
  /** 门架实体的能力标记，默认 `stacker`。 */
  craneCapability?: string;
  /** 载货台 / 货叉 / 托盘实体的 id 后缀。 */
  carriageSuffix?: string;
  forkSuffix?: string;
  palletSuffix?: string;
  /** 入库（放货）事件类型。 */
  storeType?: string;
  /** 出库（取货）事件类型。 */
  retrieveType?: string;
}

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const numList = (value: unknown, fallback: number[]): number[] => {
  if (!Array.isArray(value)) return fallback;
  const list = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
  return list.length > 0 ? list : fallback;
};

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** 归一化到 [0,1] 并做 smoothstep，避免启停时的速度突变。 */
const ramp = (u: number, from: number, to: number): number => {
  const t = clamp01((u - from) / Math.max(to - from, 1e-9));
  return t * t * (3 - 2 * t);
};

/** 派生实体 id：门架 `stacker-a` → 载货台 `stacker-a-carriage`。 */
const derived = (ctx: BehaviorContext, base: string, suffix: string): WorldEntityState | undefined =>
  ctx.entity(`${base}${suffix}`);

export function createAsrsBehavior(config: AsrsBehaviorConfig = {}): WorldBehavior {
  const craneCap = config.craneCapability ?? 'stacker';
  const carriageSuffix = config.carriageSuffix ?? '-carriage';
  const forkSuffix = config.forkSuffix ?? '-fork';
  const palletSuffix = config.palletSuffix ?? '-load';
  const storeType = config.storeType ?? 'asrs:store';
  const retrieveType = config.retrieveType ?? 'asrs:retrieve';

  return {
    id: 'asrs-cycle',
    step(ctx: BehaviorContext): void {
      for (const crane of ctx.entities) {
        if (!crane.capabilities.includes(craneCap)) continue;

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
        const forkNear = forkPair[0] ?? aisleX - reach;
        const forkFar = forkPair[1] ?? aisleX + reach;
        const parkZ = ioZ - 0.9; // 空程时托盘停在巷道口的交接位

        // 位置只依赖时间，seek 到哪一帧都算得出同一姿态。
        const raw = ctx.time / cycle + phase;
        const u = raw - Math.floor(raw);
        const lap = Math.floor(raw);

        const column = ((lap % columns) + columns) % columns;
        const zTarget = zMin + (column / (columns - 1)) * (zMax - zMin);
        const levelY = levels[((lap % levels.length) + levels.length) % levels.length] ?? ioY;
        const toNear = ((lap % 2) + 2) % 2 === 0;
        const side = toNear ? -1 : 1;
        const forkX = toNear ? forkNear : forkFar;

        // 六拍：走 / 升 / 伸 / 放 / 收 / 回
        const outTravel = ramp(u, 0.06, 0.4);
        const backTravel = ramp(u, 0.64, 0.92);
        const up = ramp(u, 0.12, 0.44);
        const down = ramp(u, 0.66, 0.94);
        const extend = reach * (ramp(u, 0.44, 0.52) - ramp(u, 0.56, 0.64));
        const carrying = u < 0.54;

        const z = ioZ + (zTarget - ioZ) * (outTravel - backTravel);
        const y = ioY + (levelY - ioY) * (up - down);

        ctx.setTransform(crane.id, { position: [aisleX, 0, z] });

        const carriage = derived(ctx, crane.id, carriageSuffix);
        if (carriage) ctx.setTransform(carriage.id, { position: [aisleX, y, z] });

        const fork = derived(ctx, crane.id, forkSuffix);
        if (fork) ctx.setTransform(fork.id, { position: [aisleX + side * extend, y, z] });

        // 托盘：跟着货叉走时坐在叉齿上，空程时落在巷道口的接驳皮带台面上。
        // 托盘模型按自身高度居中，半高 0.28，所以"放稳"就是台面 + 0.28。
        const load = derived(ctx, crane.id, palletSuffix);
        if (load) {
          ctx.setTransform(load.id, {
            position: carrying ? [aisleX + side * (extend + 0.1), y + 0.32, z] : [aisleX, ioY, parkZ],
          });
        }

        // 事件只在跨过对应拍点时发一次，用圈次幂等，不靠浮点比较。
        const pickLap = num(crane.attrs.__pickLap, -1);
        if (lap > pickLap && u >= 0.06) {
          ctx.emit(retrieveType, { entityId: crane.id, payload: { lap, level: levelY, side: toNear ? 'near' : 'far' } });
          ctx.setAttr(crane.id, '__pickLap', lap);
        }
        const storeLap = num(crane.attrs.__storeLap, -1);
        if (lap > storeLap && u >= 0.54) {
          ctx.emit(storeType, {
            entityId: crane.id,
            payload: { lap, column, level: levelY, side: toNear ? 'near' : 'far' },
          });
          ctx.setAttr(crane.id, '__storeLap', lap);
        }
      }
    },
  };
}
