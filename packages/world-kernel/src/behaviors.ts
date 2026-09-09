import type { TwinEntity, TwinTransform, TwinValue } from '@twin-platform/scene-schema';
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
  /**
   * 生成一个实体（小货物发生器产出小货物、打包站产出托盘、卡车入场…）。
   *
   * 约束：**id 必须由行为按确定性规则派生**（计数器放在 attrs 里，随快照恢复），
   * 否则回放与方案分叉会生成出不同的世界。本步生成的实体不在 `ctx.entities` 里，
   * 下一步才会出现——所以"生成完立刻读写它"要等下一拍。
   * id 已存在则抛错（这是契约违例，宿主会隔离掉这个行为）。
   */
  spawn(entity: TwinEntity): void;
  /**
   * 移除实体（被打包消耗掉的小货物、被卡车拉走的大货物）。
   *
   * 返回是否真的移除了；不存在返回 false，不抛错——消费端经常在"可能已经没了"
   * 的时序下调用。
   */
  despawn(id: string): boolean;
  emit(type: string, options?: BehaviorEmitOptions): WorldEvent;
}

export interface WorldBehavior {
  readonly id: string;
  step(ctx: BehaviorContext): void;
}
