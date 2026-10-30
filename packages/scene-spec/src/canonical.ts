import type { JsonValue, SceneTrace } from './index';

const isArray = Array.isArray;

/** 把 plain JSON 数据规范化；不支持 undefined、NaN、bigint、类实例等隐式语义。 */
export function canonicalize(value: unknown, path = '$'): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} 含非有限数字，不能写入 trace。`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (isArray(value)) return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} 必须是 plain JSON 对象。`);
    const output: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue; // 与 JSON.stringify 的对象语义一致。
      output[key] = canonicalize(item, `${path}.${key}`);
    }
    return output;
  }
  throw new Error(`${path} 含 ${typeof value}，不能写入 trace。`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** FNV-1a 32 位：稳定、无依赖、跨运行时一致；用于回归指纹，不用于安全签名。 */
export function stableHash(value: unknown): string {
  const text = typeof value === 'string' ? value : canonicalJson(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function traceHash(trace: SceneTrace): string {
  return stableHash(trace);
}
