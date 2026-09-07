import type { TwinWorld, WorldEvent } from '@twin-platform/world-kernel';

/**
 * 确定性指纹——把"这次跑出来的结果"压成一个可比较的字符串。
 *
 * 回放可不可信，不能靠肉眼看画面：同种子、同输入两次运行必须逐位一致。
 * 所以每个涉及时间轴的改动都要比对指纹，而不是"看起来对"。
 */

/** FNV-1a（32 位）。稳定、无依赖、跨运行时一致。 */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 固定小数位：浮点末位差异不该算作"结果不同"，但 1e-6 以上的差异必须被抓住。 */
const fix = (value: number | undefined): string => (value === undefined ? '' : value.toFixed(6));

/**
 * 世界状态指纹：时间、步数、每个实体的位姿 / 状态 / 属性 / 路径弧长。
 *
 * 不写实体顺序而按 id 排序——`restore()` 用 Map 重建，插入顺序可能变，
 * 但"世界长什么样"不该受 Map 内部顺序影响。
 */
export function worldFingerprint(world: TwinWorld): string {
  const parts: string[] = [`t=${fix(world.time)}`, `n=${world.stepCount}`];
  const entities = [...world.listEntities()].sort((a, b) => a.id.localeCompare(b.id));
  for (const entity of entities) {
    const position = entity.transform.position.map(fix).join(',');
    const rotation = (entity.transform.rotation ?? []).map(fix).join(',');
    const attrs = Object.keys(entity.attrs)
      .sort()
      .map((key) => `${key}=${String(entity.attrs[key])}`)
      .join(';');
    parts.push(`${entity.id}|${position}|${rotation}|${entity.status ?? ''}|${entity.dataSource}|${fix(entity.motion?.distance)}|${attrs}`);
  }
  return fnv1a(parts.join('\n'));
}

/** 事件流指纹：sequence + 类型 + 实体 + 仿真时间，顺序敏感。 */
export function eventFingerprint(events: readonly WorldEvent[]): string {
  return fnv1a(
    events.map((event) => `${event.sequence}@${fix(event.occurredAt)}:${event.type}:${event.entityId ?? ''}`).join('\n'),
  );
}
