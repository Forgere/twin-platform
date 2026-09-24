import { describe, expect, test } from 'vitest';
import { defaultTab, inspectorTabs, sceneProfileOf } from './sceneProfile';

describe('场景画像决定右侧检视区', () => {
  test('钓场：只有一个钓鱼页「钓组」，排第一，没有物流专属页', () => {
    const profile = sceneProfileOf({ hasRig: true, plugins: ['fishing'] });
    expect(profile).toBe('fishing');
    const ids = inspectorTabs(profile).map((tab) => tab.id);
    expect(ids[0]).toBe('rig');
    expect(ids).toEqual(['rig', 'entity', 'events', 'scene', 'plugins']);
    expect(ids).not.toContain('metrics');
    expect(ids).not.toContain('compare');
    expect(defaultTab(profile)).toBe('rig');
  });

  test('开着钓鱼插件但场景里没有钓组（导入的物流布局）→ 不出现钓组页', () => {
    const profile = sceneProfileOf({ hasRig: false, plugins: ['fishing', 'logistics'] });
    expect(profile).toBe('logistics');
    expect(inspectorTabs(profile).map((tab) => tab.id)).not.toContain('rig');
  });

  test('没有已知插件 → 通用画像，落地页是实体', () => {
    const profile = sceneProfileOf({ hasRig: false, plugins: [] });
    expect(profile).toBe('generic');
    expect(defaultTab(profile)).toBe('entity');
  });
});
