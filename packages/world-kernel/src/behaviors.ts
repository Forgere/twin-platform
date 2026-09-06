import type { TwinTransform, TwinValue } from '@twin-platform/scene-schema';
import type { WorldEntityState } from './entities';
import type { WorldEvent } from './events';
import type { Rng } from './rng';

/**
 * 行为插件：内核里的"领域逻辑"挂载点。
 *
 * 内核只提供三件通用的东西——沿路径运动、属性、事件。设备语义
 * （质检判定、分拣路由、缓存堵塞、吞吐量统计）一律写在这里，由插件注入。
 * 这样 `world-kernel` 永远不需要认识"输送线"这个词。
 *
 * 约束：
 * - `step` 必须是纯确定性的：随机只能从 `ctx.rng` 取，时间只能用 `ctx.time`；
 * - 同一场景下多个行为按注册顺序执行，顺序即契约，改动顺序等于改动结果。
 */

export interface BehaviorEmitOptions {
  entityId?: string;
  detail?: string;
  payload?: Record<string, TwinValue>;
}

export interface BehaviorContext {
  /** 本步的固定步长（秒）。 */
  readonly dt: number;
  /** 本步结束时的仿真时间（秒）。 */
  readonly time: number;
  readonly rng: Rng;
  /** 按场景顺序排列的实体快照；只读。 */
  readonly entities: readonly WorldEntityState[];
  entity(id: string): WorldEntityState | undefined;
  setAttr(id: string, key: string, value: TwinValue): void;
  setStatus(id: string, status: string | undefined): void;
  setTransform(id: string, transform: TwinTransform): void;
  /** 沿实体自身路径推进一段距离，返回是否成功（无路径或找不到实体返回 false）。 */
  move(id: string, distanceDelta: number): boolean;
  emit(type: string, options?: BehaviorEmitOptions): WorldEvent;
}

export interface WorldBehavior {
  readonly id: string;
  step(ctx: BehaviorContext): void;
}
