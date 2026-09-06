import type { TwinTransform, TwinValue, TwinVector3 } from '@twin-platform/scene-schema';

/**
 * 外部数据接入契约（对应 r3f-tools §14）。
 *
 * 现实约束：工厂里几乎不可能每台设备都有数据。所以模式是三级而不是两级：
 *
 * - `sim`      整个世界由内核推演（方案验证、无数据演示）；
 * - `external` 整个世界由外部喂（MES / SCADA / PLC 实时态），内核只做 diff；
 * - `hybrid`   逐实体指定，没数据的设备继续用内核推演（这是最常用的一种）。
 *
 * 外部信号的差别只在"谁推进距离"（见 `resolveExternalMotion`），
 * 因此四种信号共用同一套帧差量，渲染层不需要分支。
 */

export type DataMode = 'sim' | 'external' | 'hybrid';

export type EntityDataSource = 'sim' | 'external';

export type ExternalSignal =
  /** 上位机直接给位姿。`frame` 默认 `local`（设备本地坐标）。 */
  | { kind: 'pose'; frame?: 'world' | 'local'; position: TwinVector3; heading?: number }
  /** 给 0…1 进度，内核乘路径长度换算弧长。 */
  | { kind: 'progress'; progress: number }
  /** 只给进入时刻，内核用自己的速度×dt 推进。 */
  | { kind: 'entry'; tEnter: number }
  /** 给进入/离开时刻，内核在区间内线性插值。 */
  | { kind: 'span'; tEnter: number; tExit: number };

export interface ExternalEntityState {
  id: string;
  kind?: string;
  transform?: TwinTransform;
  attrs?: Record<string, TwinValue>;
  signal?: ExternalSignal;
}

export interface ExternalFrame {
  /**
   * 数据源自己的时间戳。内核不信任它推进时间（仿真时间必须严格单调且可重放），
   * 只用于审计与对账。
   */
  sourceTime?: number;
  entities: ExternalEntityState[];
}

export interface ExternalMotionContext {
  /** 当前仿真时间（秒）。 */
  time: number;
  /** 实体运动路径长度，无路径为 0。 */
  pathLength: number;
  /** 实体运动速度（米/秒）。 */
  speed: number;
  /** 实体本地坐标系原点。 */
  origin: TwinVector3;
  /** 实体本地坐标系偏航（弧度）。 */
  yaw: number;
}

export interface ResolvedExternalMotion {
  /** 沿路径的弧长；需要调用方自行采样成位姿。 */
  distance?: number;
  /** 直接给出的世界位姿。 */
  position?: TwinVector3;
  heading?: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** 绕 Y 轴旋转（与 Three.js `rotation.y` 同一约定）。一期只处理偏航。 */
function rotateY(point: TwinVector3, yaw: number): TwinVector3 {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return [point[0] * cos + point[2] * sin, point[1], -point[0] * sin + point[2] * cos];
}

/**
 * 把一种外部信号解析成"距离"或"世界位姿"。
 *
 * 纯函数、无状态，因此可以被单元测试完整覆盖，也是 CSV / MQTT / WebSocket
 * 三种 Adapter 共用的唯一换算点。
 */
export function resolveExternalMotion(signal: ExternalSignal, ctx: ExternalMotionContext): ResolvedExternalMotion {
  switch (signal.kind) {
    case 'pose': {
      if (signal.frame === 'world') {
        return { position: [...signal.position] as TwinVector3, heading: signal.heading ?? 0 };
      }
      const rotated = rotateY(signal.position, ctx.yaw);
      return {
        position: [rotated[0] + ctx.origin[0], rotated[1] + ctx.origin[1], rotated[2] + ctx.origin[2]],
        heading: (signal.heading ?? 0) + ctx.yaw,
      };
    }
    case 'progress':
      return { distance: clamp01(signal.progress) * ctx.pathLength };
    case 'entry':
      return { distance: Math.max(0, (ctx.time - signal.tEnter) * ctx.speed) };
    case 'span': {
      const duration = signal.tExit - signal.tEnter;
      const u = duration > 0 ? clamp01((ctx.time - signal.tEnter) / duration) : 1;
      return { distance: u * ctx.pathLength };
    }
  }
}

/** 信号是否要求实体声明 `motion`（需要路径长度与速度才能换算）。 */
export function signalRequiresPath(signal: ExternalSignal): boolean {
  return signal.kind !== 'pose';
}
