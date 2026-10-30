import { describe, expect, test } from 'bun:test';
import { canonicalize, canonicalJson, stableHash } from './canonical';

describe('scene-spec canonical JSON', () => {
  test('对象键顺序不影响规范 JSON 与哈希，数组顺序仍然是契约', () => {
    const a = { z: 1, a: [{ y: true, x: null }] };
    const b = { a: [{ x: null, y: true }], z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(stableHash(a)).toBe(stableHash(b));
    expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
  });

  test('拒绝不可序列化或非有限数据，并统一 -0', () => {
    expect(canonicalize(-0)).toBe(0);
    expect(canonicalJson({ omitted: undefined, kept: 1 })).toBe('{"kept":1}');
    expect(() => canonicalize(Number.NaN)).toThrow('非有限数字');
    expect(() => canonicalize({ at: new Date(0) })).toThrow('plain JSON');
  });
});
