import { describe, expect, test } from 'bun:test';
import type { TwinScene } from '@twin-platform/scene-schema';
import { ReplayController, worldFingerprint } from '@twin-platform/replay-core';
import { createMemoryStorage } from '@twin-platform/storage-memory';
import { TwinWorld } from '@twin-platform/world-kernel';
import { CsvFrameSource, parseCsv, splitCsvLine } from './index';

const scene: TwinScene = {
  version: 1,
  id: 'csv-line',
  name: 'CSV 回放产线',
  entities: [
    {
      id: 'cargo-01',
      kind: 'parcel',
      transform: { position: [0, 1, 0] },
      capabilities: ['move'],
      motion: { points: [[0, 1, 0], [10, 1, 0]], speed: 1, loop: 'clamp' },
    },
  ],
};

const STEP = 1 / 60;

describe('splitCsvLine', () => {
  test('支持引号包裹、引号内逗号与 "" 转义', () => {
    expect(splitCsvLine('1,a,b', ',')).toEqual(['1', 'a', 'b']);
    expect(splitCsvLine('1,"a,b",c', ',')).toEqual(['1', 'a,b', 'c']);
    expect(splitCsvLine('1,"say ""hi""",c', ',')).toEqual(['1', 'say "hi"', 'c']);
    expect(splitCsvLine('1;a;b', ';')).toEqual(['1', 'a', 'b']);
  });
});

describe('parseCsv', () => {
  test('按时间合并同帧，其余列进 attrs', () => {
    const csv = ['t,id,x,y,z,heading,batch', '0.5,cargo-01,1,1,0,0.2,A1', '0.5,cargo-02,2,1,0,0,B2', '1,cargo-01,3,1,0,0.4,A1'].join('\n');
    const { frames, issues, rows } = parseCsv(csv);

    expect(issues).toEqual([]);
    expect(rows).toBe(3);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.sourceTime).toBe(0.5);
    expect(frames[0]?.entities).toHaveLength(2);
    expect(frames[0]?.entities[0]).toMatchObject({ id: 'cargo-01', signal: { kind: 'pose', frame: 'local', position: [1, 1, 0], heading: 0.2 } });
    expect(frames[0]?.entities[0]?.attrs).toEqual({ batch: 'A1' });
  });

  test('四种信号都能解析，缺列的行记进 issues 而不是静默丢', () => {
    // 用数组拼行，避免手数逗号：列序是 t,id,signal,x,y,z,progress,tEnter,tExit
    const csv = [
      ['t', 'id', 'signal', 'x', 'y', 'z', 'progress', 'tEnter', 'tExit'],
      [0, 'a', 'pose', 1, 2, 3, '', '', ''],
      [1, 'b', 'progress', '', '', '', 0.4, '', ''],
      [2, 'c', 'entry', '', '', '', '', 1, ''],
      [3, 'd', 'span', '', '', '', '', 1, 4],
      [4, 'e', 'progress', '', '', '', '', '', ''],
      ['', 'f', 'pose', 1, 1, 1, '', '', ''],
    ]
      .map((cells) => cells.join(','))
      .join('\n');
    const { frames, issues, rows } = parseCsv(csv);

    expect(rows).toBe(4);
    expect(issues).toHaveLength(2);
    expect(issues[1]?.message).toMatch(/缺少可解析的时间列/);
    expect(frames.map((frame) => frame.entities[0]?.signal?.kind)).toEqual(['pose', 'progress', 'entry', 'span']);
  });

  test('省略 signal 时按出现的列推断', () => {
    const { frames } = parseCsv(['t,id,progress', '1,a,0.25'].join('\n'));
    expect(frames[0]?.entities[0]?.signal).toEqual({ kind: 'progress', progress: 0.25 });
  });

  test('时间相同、实体相同，后出现的胜出', () => {
    const { frames } = parseCsv(['t,id,x,y,z', '1,a,1,0,0', '1,a,9,0,0'].join('\n'));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.entities).toHaveLength(1);
    expect(frames[0]?.entities[0]?.signal).toMatchObject({ position: [9, 0, 0] });
  });

  test('解析结果只取决于文件内容，重复解析完全一致', () => {
    const csv = ['t,id,x,y,z', '0,a,1,0,0', '0.5,b,2,0,0', '1,a,3,0,0'].join('\n');
    expect(parseCsv(csv).frames).toEqual(parseCsv(csv).frames);
  });
});

describe('CsvFrameSource', () => {
  test('feedTo 只向前推进，rewind 后可完整重喂', () => {
    const { source } = CsvFrameSource.fromCsv(['t,id,x,y,z', '0.1,a,1,0,0', '0.2,a,2,0,0', '0.3,a,3,0,0'].join('\n'));
    const world = new TwinWorld(scene, { mode: 'external' });

    source.feedTo(world, 0.2);
    expect(source.fedCount).toBe(2);
    source.feedTo(world, 0.2);
    expect(source.fedCount).toBe(2);
    source.rewind();
    expect(source.fedCount).toBe(0);
    source.feedTo(world, 1);
    expect(source.fedCount).toBe(3);
    expect(source.duration).toBeCloseTo(0.3, 9);
  });

  test('接入 ReplayController：外部回放与 seek 后重算结果一致', async () => {
    const storage = createMemoryStorage();
    const csv = Array.from({ length: 30 }, (_, index) => `${((index + 1) * 0.1).toFixed(1)},cargo-01,${(index + 1) * 0.3},1,0`).join('\n');
    const { source } = CsvFrameSource.fromCsv(['t,id,x,y,z', csv].join('\n'));

    const world = new TwinWorld(scene, { seed: 5, mode: 'external', maxStepsPerAdvance: 600 });
    const controller = new ReplayController({ world, storage, source });
    await storage.snapshots.put('csv-line', world.snapshot());

    controller.play(1);
    for (let i = 0; i < 180; i += 1) controller.advance(STEP);
    const atThree = worldFingerprint(world);
    expect(world.getEntity('cargo-01')?.transform.position[0]).toBeGreaterThan(0);

    await controller.seek(1);
    await controller.seek(3);
    expect(worldFingerprint(world)).toBe(atThree);
  });
});
