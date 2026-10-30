import type { TwinPlugin } from '@twin-platform/plugin-sdk';
import type { TwinScene } from '@twin-platform/scene-schema';
import { buildCenterScene, logisticsPlugin } from '@twin-platform/plugins-logistics';
import { buildFishingScene, fishingPlugin } from '@twin-platform/plugins-fishing';

/**
 * Studio 的插件目录。
 *
 * 这里是"可切换的插件集"的唯一来源：StudioSession 只接收一个 TwinPlugin 数组，
 * 不再认识具体某个插件。加一个新孪生插件 = 往这里加一条，不改会话代码。
 *
 * 两类插件：
 * - 领域包（有 buildScene）：能独立提供默认场景，同一时刻只选一个；
 * - 能力插件（无 buildScene）：行为 / 指标 / 决策域 / 面板，可多选叠加。
 */

export const CENTER_PARAMS = { produceInterval: 6, maxWip: 10, highWater: 8, aisles: 2, externalLanes: 4 } as const;

export interface PluginEntry {
  readonly id: string;
  readonly label: string;
  readonly plugin: TwinPlugin;
  /** 领域包才提供：默认场景。用于区分"领域包"与"可叠加的能力插件"。 */
  readonly buildScene?: () => TwinScene;
}

export const PLUGIN_CATALOG: readonly PluginEntry[] = [
  {
    id: 'logistics',
    label: '物流（输送线 · 工厂 · 立库）',
    plugin: logisticsPlugin,
    buildScene: () => buildCenterScene(CENTER_PARAMS),
  },
  {
    id: 'fishing',
    label: '台钓（漂语）',
    plugin: fishingPlugin,
    buildScene: () => buildFishingScene({}),
  },
];

export const DEFAULT_PLUGIN_IDS: readonly string[] = ['logistics'];

export function entryFor(id: string): PluginEntry | undefined {
  return PLUGIN_CATALOG.find((entry) => entry.id === id);
}

/** 把 id 列表解析成插件数组；未知 id 被忽略（不报错，防止旧配置把页面卡死）。 */
export function resolvePlugins(ids: readonly string[]): TwinPlugin[] {
  const plugins: TwinPlugin[] = [];
  for (const id of ids) {
    const entry = entryFor(id);
    if (entry) plugins.push(entry.plugin);
  }
  return plugins;
}

/** 默认场景：取所选领域包里第一个能提供场景的；都没有则回落到物流。 */
export function sceneForPlugins(ids: readonly string[]): TwinScene {
  for (const id of ids) {
    const entry = entryFor(id);
    if (entry?.buildScene) return entry.buildScene();
  }
  const fallback = entryFor('logistics');
  if (!fallback?.buildScene) throw new Error('没有可用的默认场景。');
  return fallback.buildScene();
}
