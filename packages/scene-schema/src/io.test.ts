import { describe, expect, test } from 'bun:test';
import { TWIN_SCENE_VERSION, type TwinScene } from './index';
import {
  inspectSceneDocument,
  parseSceneDocument,
  roundTripIssues,
  sceneFileName,
  sceneSummary,
  serializeSceneDocument,
} from './io';

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
    {
      id: 'belt-02',
      kind: 'transport',
      transform: { position: [8, 0.8, 0] },
      capabilities: ['move'],
    },
    {
      id: 'stacker-01',
      kind: 'stacker',
      transform: { position: [4, 0, 5] },
      capabilities: ['lift'],
    },
  ],
};

/** v0 老场景：没有 version、位置是对象、用 type 表示类型、缺 capabilities。 */
const legacy = {
  name: '老产线',
  entities: [
    { id: 7, type: 'transport', position: { x: 1, y: 2, z: 3 } },
    { id: 'belt-x', type: 'inspect', position: [4, 0, 0] },
  ],
};

describe('parseSceneDocument', () => {
  test('解析当前版本的场景文件', () => {
    const result = parseSceneDocument(JSON.stringify(scene));
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.fromVersion).toBe(TWIN_SCENE_VERSION);
    expect(result.scene?.entities).toHaveLength(3);
  });

  test('自动迁移无版本号的 v0 老场景', () => {
    const result = parseSceneDocument(JSON.stringify(legacy));
    expect(result.ok).toBe(true);
    expect(result.fromVersion).toBe(0);
    expect(result.applied.length).toBe(1);
    // 迁移把数字 id 变成字符串、type 变成 kind、{x,y,z} 变成元组。
    expect(result.scene?.entities[0]?.id).toBe('7');
    expect(result.scene?.entities[0]?.kind).toBe('transport');
    expect(result.scene?.entities[0]?.transform.position).toEqual([1, 2, 3]);
    expect(result.scene?.entities[0]?.capabilities).toEqual([]);
    expect(result.scene?.version).toBe(TWIN_SCENE_VERSION);
  });

  test('拒绝高于内核版本的场景，不猜', () => {
    const result = parseSceneDocument(JSON.stringify({ ...scene, version: 99 }));
    expect(result.ok).toBe(false);
    expect(result.scene).toBeUndefined();
    expect(result.issues[0]?.path).toBe('$.version');
    expect(result.issues[0]?.message).toContain('高于');
  });

  test('非法 JSON 转成问题，不抛异常', () => {
    const result = parseSceneDocument('{ 这不是 json');
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain('不是合法 JSON');
  });

  test('空内容与数组都给出可读提示', () => {
    expect(parseSceneDocument('   ').issues[0]?.message).toContain('内容为空');
    expect(parseSceneDocument('[]').issues[0]?.message).toContain('JSON 对象');
    expect(parseSceneDocument('null').issues[0]?.message).toContain('JSON 对象');
  });

  test('结构问题一次性报全，而不是撞到第一个就停', () => {
    const broken = {
      version: 1,
      id: '',
      entities: [
        { id: 'a', kind: 'belt', transform: { position: [0, 0] }, capabilities: [] },
        { id: 'a', kind: '', transform: { position: [0, 0, 0] }, capabilities: 'x' },
      ],
    };
    const result = parseSceneDocument(JSON.stringify(broken));
    expect(result.ok).toBe(false);
    // id 为空、id 重复、kind 为空、position 维度不对、capabilities 类型不对 → 至少 4 条。
    expect(result.issues.length).toBeGreaterThanOrEqual(4);
  });

  test('成功时给出摘要：类型分布 / 动体数 / 绑定数 / 包围盒', () => {
    const result = parseSceneDocument(JSON.stringify(scene));
    const summary = result.summary!;
    expect(summary.entities).toBe(3);
    expect(summary.kinds[0]).toEqual({ kind: 'transport', count: 2 });
    expect(summary.moving).toBe(1);
    expect(summary.bound).toBe(1);
    expect(summary.bounds?.min).toEqual([0, 0, 0]);
    expect(summary.bounds?.max).toEqual([8, 0.8, 5]);
  });
});

describe('serializeSceneDocument', () => {
  test('导出后再导入完全等价（往返幂等）', () => {
    const text = serializeSceneDocument(scene);
    const result = parseSceneDocument(text);
    expect(result.ok).toBe(true);
    expect(result.scene).toEqual(scene);
  });

  test('version 顶到最前，便于人工 diff', () => {
    const text = serializeSceneDocument(scene);
    expect(text.indexOf('"version"')).toBeLessThan(text.indexOf('"id"'));
    expect(text.trimEnd().endsWith('}')).toBe(true);
  });

  test('indent=0 压缩成一行', () => {
    const text = serializeSceneDocument(scene, { indent: 0, trailingNewline: false });
    expect(text.includes('\n')).toBe(false);
    expect(parseSceneDocument(text).ok).toBe(true);
  });

  test('roundTripIssues 对干净场景为空', () => {
    expect(roundTripIssues(scene)).toEqual([]);
  });

  test('roundTripIssues 能抓出 undefined 字段这类脏数据', () => {
    const dirty = {
      ...scene,
      entities: [{ ...scene.entities[0]!, transform: { position: [0, 0, 0], rotation: undefined } }],
    } as TwinScene;
    // undefined 会被 stringify 丢掉，仍然可往返——这条用来钉住"不该误报"。
    expect(roundTripIssues(dirty)).toEqual([]);

    const broken = { ...scene, entities: [{ ...scene.entities[0]!, transform: undefined }] } as unknown as TwinScene;
    expect(roundTripIssues(broken).length).toBeGreaterThan(0);
  });

  test('sceneFileName 给出可下载的名字', () => {
    expect(sceneFileName(scene)).toBe(`line-a-v${TWIN_SCENE_VERSION}.twin.json`);
    expect(sceneFileName({ ...scene, id: '车间 A/B' })).toBe(`车间-A-B-v1.twin.json`);
  });
});

describe('inspectSceneDocument', () => {
  test('当前版本直接放行', () => {
    expect(inspectSceneDocument(JSON.stringify(scene)).ok).toBe(true);
  });

  test('老版本需要显式迁移，因此这里拒绝（服务端接口语义）', () => {
    const result = inspectSceneDocument(JSON.stringify(legacy));
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain('需要版本');
  });
});

describe('sceneSummary', () => {
  test('空场景不产生包围盒', () => {
    const summary = sceneSummary({ version: 1, id: 'x', name: 'x', entities: [] });
    expect(summary.entities).toBe(0);
    expect(summary.bounds).toBeUndefined();
  });

  test('按数量降序、同数量按类型名升序', () => {
    const mixed: TwinScene = {
      ...scene,
      entities: [
        { id: 'a', kind: 'zzz', transform: { position: [0, 0, 0] }, capabilities: [] },
        { id: 'b', kind: 'aaa', transform: { position: [0, 0, 0] }, capabilities: [] },
        { id: 'c', kind: 'aaa', transform: { position: [0, 0, 0] }, capabilities: [] },
      ],
    };
    expect(sceneSummary(mixed).kinds.map((item) => item.kind)).toEqual(['aaa', 'zzz']);
  });
});
