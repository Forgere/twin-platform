import { describe, expect, test } from 'bun:test';
import { EventLog } from './events';

const logWith = (count: number): EventLog => {
  const log = new EventLog();
  for (let i = 0; i < count; i += 1) log.append({ type: `tick:${i + 1}` }, (i + 1) * 0.1);
  return log;
};

describe('EventLog.resetTo（回放分叉）', () => {
  test('只丢快照之后的事件，快照之前的历史留在内存日志里', () => {
    const log = logWith(6);
    log.resetTo(4);
    // 回跳是分叉，但 1..3 仍然属于新时间线的历史：累计口径的不变量要看得到它们。
    expect(log.all().map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(log.nextSequence).toBe(4);
  });

  test('回到起点（sequence 1）才整段清空', () => {
    const log = logWith(3);
    log.resetTo(1);
    expect(log.all()).toEqual([]);
    expect(log.nextSequence).toBe(1);
  });

  test('截断后续事件后重新编号，不与旧时间线撞号', () => {
    const log = logWith(3);
    log.resetTo(3);
    const next = log.append({ type: 'after' }, 0.4);
    expect(next.sequence).toBe(3);
    expect(log.all().map((event) => event.type)).toEqual(['tick:1', 'tick:2', 'after']);
  });

  test('非法 sequence 直接抛错，不静默污染游标', () => {
    const log = logWith(2);
    expect(() => log.resetTo(0)).toThrow(/sequence/);
    expect(() => log.resetTo(1.5)).toThrow(/sequence/);
  });
});
