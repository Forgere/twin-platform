/**
 * 实体实时状态的"人话"翻译。
 *
 * 从世界读到的 attrs 是给机器看的（`state: 'carrying-in'`、`slot: '0:1:2'`），
 * 检视面板要的是给人看的（"入库中（货叉上）"、"第 2 层 · 第 3 列 · 近侧"）。
 * 这里只做翻译，不碰世界、不碰 Three，所以能单独测——
 * 面板本身要挂 WebGL 才能跑，逻辑放在这里才验证得了。
 */

/** 只依赖实体的这三样，因此世界状态和场景声明都能传进来。 */
export interface EntityStateLike {
  kind: string;
  attrs?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

const PALLET_STATES: Record<string, string> = {
  queued: '入库队列中',
  'carrying-in': '入库中（货叉上）',
  stored: '已上架',
  'carrying-out': '出库中（货叉上）',
  outbound: '出库待运',
};

const CRANE_TASKS: Record<string, string> = {
  store: '入库（放货）',
  retrieve: '出库（取货）',
  idle: '待命',
};

const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

/** 货位键是字符串（`0:1:2`），取出的"层/列"要当数字算，否则永远显示第 1 层。 */
const part = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function describeEntityState(state: EntityStateLike): string[] {
  const attrs = state.attrs ?? {};
  const config = state.config ?? {};
  const lines: string[] = [];

  if (state.kind === 'pallet') {
    lines.push(`状态：${PALLET_STATES[str(attrs.state)] ?? '未入系统'}`);
    const slot = str(attrs.slot);
    const parts = slot.split(':');
    if (parts.length === 3) {
      lines.push(`货位：第 ${part(parts[1]) + 1} 层 · 第 ${part(parts[2]) + 1} 列 · ${parts[0] === '1' ? '远侧' : '近侧'}`);
    }
    if (attrs.seq !== undefined) lines.push(`入架序号：#${num(attrs.seq)}`);
    if (attrs.storedAt !== undefined) lines.push(`入架时刻：${num(attrs.storedAt).toFixed(1)}s`);
    if (str(config.carrier)) lines.push(`归属：${str(config.carrier)}`);
    return lines;
  }

  if (state.kind === 'asrs') {
    lines.push(`库位占用：${num(attrs.used)} / ${num(attrs.capacity)}`);
    if (str(config.craneId)) lines.push(`对应堆垛机：${str(config.craneId)}`);
    return lines;
  }

  if (state.kind === 'stacker') {
    lines.push(`当前任务：${CRANE_TASKS[str(attrs.task, 'idle')] ?? '—'}`);
    lines.push(`巷道库存：${num(attrs.stock)} 块托盘`);
    lines.push(`下一个出库：${str(attrs.nextOut) || '（空）'}`);
    return lines;
  }

  return lines;
}
