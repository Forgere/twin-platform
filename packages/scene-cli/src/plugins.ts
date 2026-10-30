import { PluginHost, type TwinPlugin } from '@twin-platform/plugin-sdk';
import type { SceneAuditCheck } from '@twin-platform/scene-audit';
import type { TwinScene } from '@twin-platform/scene-schema';
import type { TwinWorld, WorldBehavior } from '@twin-platform/world-kernel';

/**
 * CLI 侧的参考插件登记表。
 *
 * 这里刻意只登记**参考实现**：外部插件 / 外部 runtime 只要能给出
 * `behaviors + checks + scene`，就能按同样的形状接进来，CLI 与它们没有耦合。
 * 插件锁（id + version）会进 trace，因此"用哪套插件跑的"是证据的一部分。
 */

export interface CliPlugin {
  readonly id: string;
  readonly version: string;
  behaviors(): readonly WorldBehavior[];
  checksForScene(scene: TwinScene): readonly SceneAuditCheck<TwinWorld>[];
  buildScene?(template: string, params?: Readonly<Record<string, unknown>>): TwinScene;
}

const noChecks: readonly SceneAuditCheck<TwinWorld>[] = [];

const nonePlugin: CliPlugin = {
  id: 'none',
  version: '0.0.0',
  behaviors: () => [],
  checksForScene: () => noChecks,
};

/** 经 PluginHost 激活：manifest 校验、能力过滤与故障隔离都用插件 SDK 的同一套规则。 */
const activate = (plugin: TwinPlugin): readonly WorldBehavior[] => {
  const host = new PluginHost();
  host.install(plugin);
  return host.behaviors;
};

const isFishingPond = (scene: TwinScene): boolean => scene.entities.some((entity) => entity.id === 'rig-01');

export async function loadCliPlugin(id: string): Promise<CliPlugin> {
  switch (id) {
    case 'none':
      return nonePlugin;
    case 'logistics': {
      const mod = await import('@twin-platform/plugins-logistics');
      return {
        id: 'logistics',
        version: mod.logisticsPlugin.manifest.version,
        behaviors: () => activate(mod.logisticsPlugin),
        // 闭环不变量只对真的装了"发生器 / 打包站 / 立库 / 卡车"的中心场景成立；
        // 规则只在 plugins-logistics 里写一份，Studio 审计面板用的是同一个函数。
        checksForScene: (scene) => mod.runtimeInvariantsFor(scene),
        buildScene: (template, params) => {
          const options = (params ?? {}) as never;
          if (template === 'factory') return mod.buildFactoryScene(options);
          if (template === 'line') return mod.buildLineScene(options);
          return mod.buildCenterScene(options);
        },
      };
    }
    case 'fishing': {
      const mod = await import('@twin-platform/plugins-fishing');
      return {
        id: 'fishing',
        version: mod.fishingPlugin.manifest.version,
        behaviors: () => activate(mod.fishingPlugin),
        checksForScene: (scene) => (isFishingPond(scene) ? [mod.fishingRigInvariant] : noChecks),
        buildScene: (_template, params) => mod.buildFishingScene((params ?? {}) as never),
      };
    }
    default:
      throw new Error(`未知插件 ${id}；可用：none / logistics / fishing。`);
  }
}

export const CLI_PLUGIN_IDS: readonly string[] = ['none', 'logistics', 'fishing'];

/** `logistics.center` → { plugin: 'logistics', template: 'center' }；只给插件名时用默认模板。 */
export function parseTemplateSpec(spec: string): { plugin: string; template: string } {
  const [plugin, template] = spec.split('.');
  if (!plugin) throw new Error('--template 形如 logistics.center 或 fishing.pond。');
  return { plugin, template: template ?? '' };
}
