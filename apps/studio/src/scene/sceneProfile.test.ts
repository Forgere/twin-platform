import { describe, expect, test } from 'vitest';
import type { StudioPresentation } from '@twin-platform/studio-sdk';
import { defaultTab, inspectorTabs, sceneProfileOf } from './sceneProfile';

const presentation: StudioPresentation = {
  pluginId: 'example', matches: () => true,
  inspector: {
    defaultTab: 'custom', label: '领域 / 面板',
    tabs: [
      { id: 'custom', icon: '◆', label: '领域页' },
      { id: 'entity', icon: '🧩', label: '实体' },
    ],
  },
};

describe('场景画像消费展示插件数据', () => {
  test('领域插件拥有自己的页面顺序、默认页和文案', () => {
    const profile = sceneProfileOf({ plugins: ['example'], presentation });
    expect(profile.id).toBe('example');
    expect(inspectorTabs(profile).map((tab) => tab.id)).toEqual(['custom', 'entity']);
    expect(defaultTab(profile)).toBe('custom');
    expect(profile.label).toBe('领域 / 面板');
  });

  test('没有匹配的展示插件时沿用物流画像', () => {
    const profile = sceneProfileOf({ plugins: ['example', 'logistics'] });
    expect(profile.id).toBe('logistics');
    expect(inspectorTabs(profile).map((tab) => tab.id)).toEqual([
      'entity', 'audit', 'metrics', 'compare', 'data', 'events', 'scene', 'plugins',
    ]);
    // 工厂示例落地在审计页：打开就看“契不契”，而不是先看模型。
    expect(defaultTab(profile)).toBe('audit');
  });

  test('没有已知插件时使用通用画像', () => {
    const profile = sceneProfileOf({ plugins: [] });
    expect(profile.id).toBe('generic');
    expect(defaultTab(profile)).toBe('entity');
  });
});
