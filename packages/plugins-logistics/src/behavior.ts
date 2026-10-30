import type { BehaviorContext, WorldBehavior, WorldEntityState } from '@twin-platform/world-kernel';

/**
 * 物流流转行为。
 *
 * 内核负责"沿路径搬运"（advanceSimMotion），本行为只负责"读懂搬运结果并发事件"：
 * - 包裹每绕完一圈（distance 从 ~length 绕回 ~0），记一次 `parcel:exit` + `parcel:enter`；
 *   首步额外补一次 `parcel:enter`，因为包裹开局就在产线里；
 * - 设备按"中心线两侧是否有包裹"切换 `busy` / `idle`，供利用率与停机指标消费。
 *
 * 全程确定性：只读 `motion.distance` 与 `transform.position`，不碰 `ctx.rng`、
 * 不读挂钟。同种子跑两遍，事件流逐条一致——这是"对比两个方案"的前提。
 */

export interface LogisticsBehaviorConfig {
  /** 包裹实体的能力标记，默认 `parcel`。 */
  parcelCapability?: string;
  /** 进入产线事件类型。 */
  enterType?: string;
  /** 离开产线事件类型。 */
  exitType?: string;
  /** 设备状态事件类型。 */
  statusType?: string;
  /** 视为"设备"的能力集合。 */
  deviceCapabilities?: readonly string[];
  /** 设备覆盖区半宽（米），缺省读实体 config.zoneHalfWidth。 */
  zoneHalfWidth?: number;
}

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export function createLogisticsBehavior(config: LogisticsBehaviorConfig = {}): WorldBehavior {
  const parcelCap = config.parcelCapability ?? 'parcel';
  const enterType = config.enterType ?? 'parcel:enter';
  const exitType = config.exitType ?? 'parcel:exit';
  const statusType = config.statusType ?? 'entity:status';
  const deviceCaps = config.deviceCapabilities ?? ['inspect', 'store', 'buffer', 'sort'];
  const defaultZone = config.zoneHalfWidth ?? 1.6;

  return {
    id: 'logistics-flow',
    step(ctx: BehaviorContext): void {
      const parcels: WorldEntityState[] = [];
      const devices: WorldEntityState[] = [];
      for (const entity of ctx.entities) {
        if (entity.capabilities.includes(parcelCap) && entity.motion) parcels.push(entity);
        else if (entity.capabilities.some((capability) => deviceCaps.includes(capability))) devices.push(entity);
      }

      // 1) 包裹绕圈检测：一圈 = 一次"出 + 进"。
      for (const parcelEntity of parcels) {
        const motion = parcelEntity.motion;
        if (!motion) continue;
        const length = motion.path.length;
        const distance = motion.distance;
        const prevRaw = num(parcelEntity.attrs.__raw, distance);
        const prevCum = num(parcelEntity.attrs.__cum, 0);

        // loop: repeat 会让 distance 从 ~length 跳回 ~0，delta 变负，补回一个周长。
        let delta = distance - prevRaw;
        if (delta < -1e-9) delta += length;
        const cumulative = prevCum + Math.max(0, delta);

        if (parcelEntity.attrs.__init === undefined) {
          ctx.emit(enterType, { entityId: parcelEntity.id });
          ctx.setAttr(parcelEntity.id, '__init', 1);
        }

        const prevLaps = prevCum <= 0 ? 0 : Math.floor(prevCum / length);
        const laps = cumulative <= 0 ? 0 : Math.floor(cumulative / length);
        if (laps > prevLaps) {
          ctx.emit(exitType, { entityId: parcelEntity.id });
          ctx.emit(enterType, { entityId: parcelEntity.id });
        }

        ctx.setAttr(parcelEntity.id, '__cum', cumulative);
        ctx.setAttr(parcelEntity.id, '__raw', distance);
      }

      // 2) 设备忙闲：中心线两侧 zoneHalfWidth 内有包裹即 busy（只看 X 轴，与设备声明一致）。
      //    按 X 轴把货物哈希进 1D 桶：每台设备只查自己附近的桶，不再扫全部货物
      //    （devices × parcels = O(N²)，副本翻倍时平方级恶化）。
      let maxHalf = defaultZone;
      for (const device of devices) {
        maxHalf = Math.max(
          maxHalf,
          config.zoneHalfWidth !== undefined ? config.zoneHalfWidth : num(device.config?.zoneHalfWidth, defaultZone),
        );
      }
      const cell = Math.max(0.1, maxHalf);
      const byX = new Map<number, WorldEntityState[]>();
      for (const parcel of parcels) {
        const key = Math.floor(parcel.transform.position[0] / cell);
        const list = byX.get(key);
        if (list) list.push(parcel);
        else byX.set(key, [parcel]);
      }
      for (const device of devices) {
        const centerX = device.transform.position[0];
        // 行为参数优先于设备声明：operator 想收紧/放宽检测区时不需要改场景。
        const half = config.zoneHalfWidth !== undefined ? config.zoneHalfWidth : num(device.config?.zoneHalfWidth, defaultZone);
        let busy = false;
        const lo = Math.floor((centerX - half) / cell);
        const hi = Math.floor((centerX + half) / cell);
        for (let kx = lo; kx <= hi; kx += 1) {
          const list = byX.get(kx);
          if (!list) continue;
          for (const parcelEntity of list) {
            if (Math.abs(parcelEntity.transform.position[0] - centerX) <= half) {
              busy = true;
              break;
            }
          }
          if (busy) break;
        }
        const next = busy ? 'busy' : 'idle';
        if (device.attrs.__status !== next) {
          ctx.emit(statusType, { entityId: device.id, payload: { status: next } });
          ctx.setAttr(device.id, '__status', next);
        }
      }
    },
  };
}
