import { describe, expect, test } from 'bun:test';
import { parseSceneDocument, serializeSceneDocument } from './io';
import { applySceneOps, sameTransform, SceneOpError, type SceneOp } from './ops';
import type { TwinScene } from './index';

const makeScene = (): TwinScene => ({
  version: 1,
  id: 'line-a',
  name: '产线 A',
  entities: [
    { id: 'rack-01', kind: 'asrs', transform: { position: [4, 0, 6] }, capabilities: ['store'] },
    { id: 'belt-01', kind: 'transport', transform: { position: [0, 0.8, 0], rotation: [0, 1.5707963, 0] }, capabilities: ['move'] },
  ],
});

const pos = (scene: TwinScene, id: string): number[] => scene.entities.find((entity) => entity.id === id)!.transform.position;

describe('applySceneOps', () => {
  test('改位置：返回新场景，原场景不动', () => {
    const scene = makeScene();
    const next = applySceneOps(scene, [
      { type: 'setTransform', entityId: 'rack-01', before: { position: [4, 0, 6] }, after: { position: [9, 0, -2] } },
    ]);

    expect(pos(next, 'rack-01')).toEqual([9, 0, -2]);
    expect(pos(scene, 'rack-01')).toEqual([4, 0, 6]); // 纯函数：入参不能被改
    expect(next).not.toBe(scene);
    expect(next.entities).not.toBe(scene.entities);
  });

  test('结构共享：没被改到的实体沿用原引用', () => {
    const scene = makeScene();
    const beltBefore = scene.entities[1];
    const next = applySceneOps(scene, [
      { type: 'setTransform', entityId: 'rack-01', before: { position: [4, 0, 6] }, after: { position: [1, 0, 1] } },
    ]);

    expect(next.entities[1]).toBe(beltBefore); // 同一个对象，不是拷贝
    expect(next.entities[0]).not.toBe(scene.entities[0]);
    expect(next.id).toBe(scene.id);
    expect(next.name).toBe(scene.name);
  });

  test('before 对不上就拒绝：基于旧状态的编辑不能安静覆盖', () => {
    const scene = makeScene();
    const run = (): TwinScene =>
      applySceneOps(scene, [{ type: 'setTransform', entityId: 'rack-01', before: { position: [0, 0, 0] }, after: { position: [1, 0, 1] } }]);

    expect(run).toThrow(SceneOpError);
    expect(run).toThrow(/旧状态/);
    expect(pos(scene, 'rack-01')).toEqual([4, 0, 6]);
  });

  test('场景声明里没有的实体拒绝编辑', () => {
    const scene = makeScene();
    expect(() =>
      applySceneOps(scene, [{ type: 'setTransform', entityId: 'ghost', before: { position: [0, 0, 0] }, after: { position: [1, 0, 0] } }]),
    ).toThrow(SceneOpError);
  });

  test('结果必须仍然合法：位置写成 NaN 会被整场景校验挡下', () => {
    const scene = makeScene();
    expect(() =>
      applySceneOps(scene, [
        {
          type: 'setTransform',
          entityId: 'rack-01',
          before: { position: [4, 0, 6] },
          after: { position: [Number.NaN, 0, 0] as unknown as [number, number, number] },
        },
      ]),
    ).toThrow(SceneOpError);
  });

  test('同一批里连着改同一个实体：以前一条的结果作为后一条的 before', () => {
    const scene = makeScene();
    const next = applySceneOps(scene, [
      { type: 'setTransform', entityId: 'rack-01', before: { position: [4, 0, 6] }, after: { position: [5, 0, 6] } },
      { type: 'setTransform', entityId: 'rack-01', before: { position: [5, 0, 6] }, after: { position: [6, 0, 6] } },
    ]);

    expect(pos(next, 'rack-01')).toEqual([6, 0, 6]);
  });

  test('空 op 返回原场景本身（不产生无谓的新对象）', () => {
    const scene = makeScene();
    expect(applySceneOps(scene, [])).toBe(scene);
  });

  test('编辑结果能原样序列化再解析（导出的文件依然是合法场景）', () => {
    const scene = makeScene();
    const ops: SceneOp[] = [
      { type: 'setTransform', entityId: 'belt-01', before: { position: [0, 0.8, 0], rotation: [0, 1.5707963, 0] }, after: { position: [3, 0.8, 2], rotation: [0, 0, 0] } },
    ];
    const parsed = parseSceneDocument(serializeSceneDocument(applySceneOps(scene, ops)));

    expect(parsed.ok).toBe(true);
    expect(pos(parsed.scene!, 'belt-01')).toEqual([3, 0.8, 2]);
    expect(parsed.scene!.entities[1].transform.rotation).toEqual([0, 0, 0]);
  });

  test('op 保存的是自己的数组：预览继续改原数组不会污染已提交的编辑', () => {
    const scene = makeScene();
    const preview = [9, 9, 9] as [number, number, number];
    const next = applySceneOps(scene, [
      { type: 'setTransform', entityId: 'rack-01', before: { position: [4, 0, 6] }, after: { position: preview } },
    ]);

    preview[0] = -1; // 预览复用同一个数组继续动
    expect(pos(next, 'rack-01')).toEqual([9, 9, 9]);
  });
});

describe('sameTransform', () => {
  test('缺失的 rotation / scale 互相视为相等', () => {
    expect(sameTransform({ position: [1, 2, 3] }, { position: [1, 2, 3] })).toBe(true);
    expect(sameTransform({ position: [1, 2, 3] }, { position: [1, 2, 3], rotation: [0, 0, 0] })).toBe(false);
    expect(sameTransform({ position: [1, 2, 3] }, { position: [1, 2, 3.0000001] })).toBe(false);
  });
});
