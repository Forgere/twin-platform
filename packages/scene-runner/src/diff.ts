import { canonicalize, traceHash, type JsonValue, type SceneTrace, type TraceDiff, type TraceDivergence } from '@twin-platform/scene-spec';

const pointerPart = (part: string): string => part.replaceAll('~', '~0').replaceAll('/', '~1');
const kind = (value: JsonValue | undefined): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

/** 深度优先、键排序的 JSON diff；pointer 遵循 RFC 6901，可直接定位首个分歧。 */
export function firstJsonDivergence(baseline: unknown, current: unknown): TraceDivergence | undefined {
  const walk = (a: JsonValue | undefined, b: JsonValue | undefined, pointer: string): TraceDivergence | undefined => {
    if (Object.is(a, b)) return undefined;
    if (a === undefined || b === undefined) return { pointer: pointer || '/', reason: 'missing', baseline: a, current: b };
    if (kind(a) !== kind(b)) return { pointer: pointer || '/', reason: 'type', baseline: a, current: b };
    if (Array.isArray(a) && Array.isArray(b)) {
      const shared = Math.min(a.length, b.length);
      for (let index = 0; index < shared; index += 1) {
        const divergence = walk(a[index], b[index], `${pointer}/${index}`);
        if (divergence) return divergence;
      }
      if (a.length !== b.length) {
        return { pointer: `${pointer}/${shared}`, reason: 'missing', baseline: a[shared], current: b[shared] };
      }
      return undefined;
    }
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      const left = a as { [key: string]: JsonValue };
      const right = b as { [key: string]: JsonValue };
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      for (const key of keys) {
        const divergence = walk(left[key], right[key], `${pointer}/${pointerPart(key)}`);
        if (divergence) return divergence;
      }
      return undefined;
    }
    return { pointer: pointer || '/', reason: 'value', baseline: a, current: b };
  };
  return walk(canonicalize(baseline), canonicalize(current), '');
}

/** 先比较语义内容，再比较派生哈希：不能让 /eventHash 遮住真正的 /events/N。 */
const TRACE_DIFF_ORDER = [
  'formatVersion', 'sceneId', 'seed', 'step', 'steps', 'plugins', 'actions', 'events', 'finalState',
  'sceneHash', 'eventHash', 'stateHash',
] as const;

export function diffTrace(baseline: SceneTrace, current: SceneTrace): TraceDiff {
  let firstDivergence: TraceDivergence | undefined;
  for (const key of TRACE_DIFF_ORDER) {
    const nested = firstJsonDivergence(baseline[key], current[key]);
    if (!nested) continue;
    firstDivergence = {
      ...nested,
      pointer: `/${key}${nested.pointer === '/' ? '' : nested.pointer}`,
    };
    break;
  }
  return {
    identical: firstDivergence === undefined,
    baselineHash: traceHash(baseline),
    currentHash: traceHash(current),
    firstDivergence,
  };
}
