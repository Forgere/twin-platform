/**
 * 实体运行态的三档归一：给检视面板列表行的微型状态点用。
 *
 * 只翻译世界已经写进 attrs 的事实，不自己造指标：
 * - `backpressure`：transfer.ts 在分流台被占、物料被拦在排队区时打的原 boolean；
 * - `state`：asrs.ts 的托盘流转态（queued / carrying-in / stored / carrying-out / outbound）、
 *   输送段的 conveying；
 * - `task`：asrs.ts 给堆垛机写的当前任务（store / retrieve / idle）；
 * - `truckState`：truck.ts 的卡车循环（docked / departing / away / returning）；
 * - `busy`：检测站忙闲。
 * 读不到任何一项就是"空闲"，不是"未知"——面板上不许出现猜出来的颜色。
 */

export type EntityStatus = 'run' | 'wait' | 'idle';

/** 状态点的中文说明：hover 与读屏都取这里，避免各处自己写一套。 */
export const ENTITY_STATUS_LABEL: Record<EntityStatus, string> = {
  run: '运行中',
  wait: '积压等待',
  idle: '空闲',
};

/** 料箱/托盘类实体的流转态：在途 = 运行，排队/待运 = 积压，落位 = 空闲。 */
const MOVING_STATES: Record<string, true> = { 'carrying-in': true, 'carrying-out': true, conveying: true };
const BACKLOG_STATES: Record<string, true> = { queued: true, outbound: true };

/** 卡车：靠位装车与途中都算在干活，门外等下一趟才是歇着。 */
const TRUCK_MOVING: Record<string, true> = { docked: true, departing: true, returning: true };

interface EntityAttrsLike {
  kind?: string;
  attrs?: Record<string, unknown>;
}

/** attrs 里的值是 unknown：取字符串要先把非字符串挡掉，三处读法保持一致。 */
const text = (attrs: Record<string, unknown>, key: string): string => {
  const value = attrs[key];
  return typeof value === 'string' ? value : '';
};

/**
 * 归一优先级：背压 > 忙 > 在途 > 流转态 > 空闲。
 *
 * 背压排第一：排队区里的托盘同时带着 `state: 'queued'`，两处说法一致，
 * 但分流台被占时上游整条带子都会积压，先把这个最刺眼的信号亮出来。
 */
export function entityStatus(entity: EntityAttrsLike | undefined): EntityStatus {
  const attrs = entity?.attrs;
  if (!attrs) return 'idle';

  if (attrs.backpressure === true) return 'wait';
  if (attrs.busy === true) return 'run';

  const task = text(attrs, 'task');
  if (task === 'store' || task === 'retrieve') return 'run';
  if (task === 'idle') return 'idle';

  const truckState = text(attrs, 'truckState');
  if (truckState) return TRUCK_MOVING[truckState] === true ? 'run' : 'idle';

  const state = text(attrs, 'state');
  if (MOVING_STATES[state] === true) return 'run';
  if (BACKLOG_STATES[state] === true) return 'wait';
  return 'idle';
}
