import { describe, expect, test } from 'vitest';
import { rawPartId } from './partId';

const hit = (name: string, partId?: unknown, instanceId?: number) => ({
  object: { name, userData: { partId } },
  instanceId,
});

describe('rawPartId', () => {
  test('优先展示 mesh.name 原始值', () => {
    expect(rawPartId(hit('IMPELLER-MAIN', 'mapped-id', 3))).toBe('IMPELLER-MAIN');
  });

  test('未命名 mesh 退回 userData.partId，再退回 instanceId', () => {
    expect(rawPartId(hit('', 'VALVE_0012', 3))).toBe('VALVE_0012');
    expect(rawPartId(hit('', undefined, 3))).toBe('3');
  });

  test('没有任何原始标识时不伪造部件号', () => {
    expect(rawPartId(hit(''))).toBeUndefined();
  });
});
