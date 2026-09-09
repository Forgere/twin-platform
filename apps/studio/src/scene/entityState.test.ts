import { describe, expect, test } from 'vitest';
import { describeEntityState } from './entityState';

/**
 * 检视面板那几行"人话"的单元测试。
 *
 * 面板本身要挂 WebGL 才跑得起来，所以把翻译逻辑单独抽成纯函数——
 * 这样"点中托盘能不能看到它在第几层第几列"就有测试兜底，而不是靠肉眼看。
 */
describe('describeEntityState', () => {
  test('托盘：状态、货位、入架序号与时刻', () => {
    const lines = describeEntityState({
      kind: 'pallet',
      attrs: { state: 'stored', slot: '0:1:2', seq: 7, storedAt: 123.45 },
      config: { carrier: 'stacker-a' },
    });
    expect(lines).toEqual([
      '状态：已上架',
      '货位：第 2 层 · 第 3 列 · 近侧',
      '入架序号：#7',
      '入架时刻：123.5s',
      '归属：stacker-a',
    ]);
  });

  test('托盘：远侧货位与在途状态', () => {
    const lines = describeEntityState({
      kind: 'pallet',
      attrs: { state: 'carrying-out', slot: '1:0:0' },
    });
    expect(lines[0]).toBe('状态：出库中（货叉上）');
    expect(lines[1]).toBe('货位：第 1 层 · 第 1 列 · 远侧');
    expect(lines.some((line) => line.startsWith('入架序号'))).toBe(false);
  });

  test('托盘：还在队列里时没有货位', () => {
    const lines = describeEntityState({ kind: 'pallet', attrs: { state: 'queued', order: 2 } });
    expect(lines).toEqual(['状态：入库队列中']);
  });

  test('货架：库位占用与对应堆垛机', () => {
    const lines = describeEntityState({
      kind: 'asrs',
      attrs: { used: 3, capacity: 15 },
      config: { craneId: 'stacker-a' },
    });
    expect(lines).toEqual(['库位占用：3 / 15', '对应堆垛机：stacker-a']);
  });

  test('堆垛机：当前任务、库存与下一个出库', () => {
    const lines = describeEntityState({
      kind: 'stacker',
      attrs: { task: 'retrieve', stock: 5, nextOut: 'asrs-8-pallet-2' },
    });
    expect(lines).toEqual(['当前任务：出库（取货）', '巷道库存：5 块托盘', '下一个出库：asrs-8-pallet-2']);
  });

  test('其它类型没有可展示的状态', () => {
    expect(describeEntityState({ kind: 'transport', attrs: {} })).toEqual([]);
  });
});
