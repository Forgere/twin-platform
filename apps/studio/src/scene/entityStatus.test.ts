import { describe, expect, test } from 'vitest';
import { ENTITY_STATUS_LABEL, entityStatus } from './entityStatus';

describe('entityStatus：世界 attrs → 状态点三档', () => {
  test('背压优先于一切：排队区的托盘虽然也带 queued，但先亮积压', () => {
    expect(entityStatus({ attrs: { backpressure: true, state: 'carrying-in' } })).toBe('wait');
  });

  test('检测站忙 = 运行，闲 = 空闲', () => {
    expect(entityStatus({ attrs: { busy: true } })).toBe('run');
    expect(entityStatus({ attrs: { busy: false } })).toBe('idle');
  });

  test('堆垛机按任务判：入库/出库是干活，待命是空闲', () => {
    expect(entityStatus({ attrs: { task: 'store' } })).toBe('run');
    expect(entityStatus({ attrs: { task: 'retrieve' } })).toBe('run');
    expect(entityStatus({ attrs: { task: 'idle', state: 'queued' } })).toBe('idle');
  });

  test('卡车只有靠位与途中算干活，门外等着算空闲', () => {
    expect(entityStatus({ attrs: { truckState: 'docked' } })).toBe('run');
    expect(entityStatus({ attrs: { truckState: 'returning' } })).toBe('run');
    expect(entityStatus({ attrs: { truckState: 'away' } })).toBe('idle');
  });

  test('托盘流转态：在途运行、排队待运积压、已上架空闲', () => {
    expect(entityStatus({ attrs: { state: 'carrying-in' } })).toBe('run');
    expect(entityStatus({ attrs: { state: 'conveying' } })).toBe('run');
    expect(entityStatus({ attrs: { state: 'queued' } })).toBe('wait');
    expect(entityStatus({ attrs: { state: 'outbound' } })).toBe('wait');
    expect(entityStatus({ attrs: { state: 'stored' } })).toBe('idle');
  });

  test('没有状态可读就是空闲；非字符串的 attrs 不当状态用', () => {
    expect(entityStatus(undefined)).toBe('idle');
    expect(entityStatus({ kind: 'parcel' })).toBe('idle');
    expect(entityStatus({ attrs: { state: 42 } })).toBe('idle');
    expect(entityStatus({ attrs: { state: '未知状态' } })).toBe('idle');
  });

  test('每个档位都有对外文案，列表点不会渲染出 undefined', () => {
    for (const status of ['run', 'wait', 'idle'] as const) {
      expect(ENTITY_STATUS_LABEL[status]).toBeTruthy();
    }
  });
});
