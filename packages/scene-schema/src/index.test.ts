import { describe, expect, test } from 'bun:test';
import { isTwinScene, migrateTwinScene, SCENE_MIGRATIONS, TWIN_SCENE_VERSION, validateTwinScene } from './index';
import type { TwinScene } from './index';

const scene: TwinScene = {
  version: 1,
  id: 'line-a',
  name: '产线 A',
  entities: [
    {
      id: 'belt-01',
      kind: 'transport',
      transform: { position: [0, 0.8, 0] },
      capabilities: ['move'],
      motion: { points: [[0, 0.8, 0], [8, 0.8, 0]], speed: 1.2 },
      dataBindings: [{ source: 'mes', signal: 'progress' }],
    },
  ],
};

describe('validateTwinScene', () => {
  test('接受合法场景', () => {
    expect(validateTwinScene(scene)).toEqual([]);
    expect(isTwinScene(scene)).toBe(true);
  });

  test('拒绝重复 id、错误版本与非法 motion', () => {
    const broken = {
      ...scene,
      entities: [
        { ...scene.entities[0] },
        { id: 'belt-01', kind: 'transport', transform: { position: [0, 0, 0] }, capabilities: [] },
        { id: 'bad', kind: 'transport', transform: { position: [0, 0, 0] }, capabilities: [], motion: { points: [[0, 0, 0]], speed: -1 } },
      ],
    };
    const issues = validateTwinScene(broken);
    expect(issues.some((issue) => issue.path === '$.entities[1].id')).toBe(true);
    expect(issues.some((issue) => issue.path === '$.entities[2].motion.points')).toBe(true);
    expect(issues.some((issue) => issue.path === '$.entities[2].motion.speed')).toBe(true);
  });
});

describe('migrateTwinScene', () => {
  test('v0 场景补齐 version / capabilities，type→kind，{x,y,z}→元组', () => {
    const legacy = {
      name: '老产线',
      entities: [{ id: 'belt', type: 'transport', position: { x: 1, y: 2, z: 3 } }],
    };
    const result = migrateTwinScene(legacy);

    expect(result.fromVersion).toBe(0);
    expect(result.applied).toHaveLength(1);
    expect(result.scene.version).toBe(TWIN_SCENE_VERSION);
    expect(result.scene.id).toBe('老产线');
    expect(result.scene.entities[0]?.kind).toBe('transport');
    expect(result.scene.entities[0]?.transform.position).toEqual([1, 2, 3]);
    expect(result.scene.entities[0]?.capabilities).toEqual([]);
    expect(validateTwinScene(result.scene)).toEqual([]);
  });

  test('已是当前版本时原样返回，不重复迁移', () => {
    const result = migrateTwinScene(scene);
    expect(result.fromVersion).toBe(1);
    expect(result.applied).toEqual([]);
    expect(result.scene).toEqual(scene);
  });

  test('高于内核版本的场景直接失败，不做猜测', () => {
    expect(() => migrateTwinScene({ ...scene, version: 99 })).toThrow(/高于/);
  });

  test('迁移链覆盖到当前版本', () => {
    let version = 0;
    while (version < TWIN_SCENE_VERSION) {
      const step = SCENE_MIGRATIONS.find((item) => item.from === version);
      expect(step).toBeDefined();
      version = step?.to ?? version + 1;
    }
    expect(version).toBe(TWIN_SCENE_VERSION);
  });
});
