/**
 * 状态指纹。
 *
 * 稳定序列化（对象键排序）+ FNV-1a。不用 crypto：必须是同步、纯函数、
 * 同进程同结果，这样它才能进回放与方案对比的确定性测试。
 */

function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stable(record[key])).join(',') + '}';
}

export function stableStringify(value: unknown): string {
  return stable(value);
}

export function hashState(state: unknown): string {
  const text = stable(state);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
