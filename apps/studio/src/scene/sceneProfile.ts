/**
 * 场景画像（scene profile）—— 右侧检视区"按场景长什么样"的唯一决定点。
 *
 * 不同场景要的编辑器完全不同：物流产线看指标 / 方案对比 / 外部数据，
 * 钓场看钓组参数 / 剖面 / 决策记录。以前是一张大标签表再按插件零散地
 * 过滤，钓场里会冒出"方案对比""数据"这种用不上的页，物流里也可能出现
 * 钓组页。现在由画像一次决定整组标签（顺序即优先级）。
 *
 * 右侧检视区是**编辑器**（改参数、看剖面、查记录）；开钓向导与钓鱼助手属于
 * "应用本身"，浮在画布上，不占检视区的页。
 */

export type SceneProfile = 'fishing' | 'logistics' | 'generic';

export type InspectorTab =
  | 'rig'
  | 'sandbox'
  | 'entity'
  | 'metrics'
  | 'compare'
  | 'data'
  | 'scene'
  | 'events'
  | 'decision'
  | 'plugins';

export interface TabDef {
  readonly id: InspectorTab;
  readonly icon: string;
  readonly label: string;
}

const TAB_DEFS: Readonly<Record<InspectorTab, TabDef>> = {
  rig: { id: 'rig', icon: '🎣', label: '钓组' },
  sandbox: { id: 'sandbox', icon: '🌊', label: '剖面' },
  entity: { id: 'entity', icon: '🧩', label: '实体' },
  metrics: { id: 'metrics', icon: '📊', label: '指标' },
  compare: { id: 'compare', icon: '⚖️', label: '对比' },
  data: { id: 'data', icon: '📡', label: '数据' },
  scene: { id: 'scene', icon: '🗂️', label: '场景' },
  events: { id: 'events', icon: '📜', label: '事件' },
  decision: { id: 'decision', icon: '🎯', label: '决策' },
  plugins: { id: 'plugins', icon: '🔌', label: '插件' },
};

const PROFILE_TABS: Readonly<Record<SceneProfile, readonly InspectorTab[]>> = {
  fishing: ['rig', 'sandbox', 'decision', 'entity', 'events', 'scene', 'plugins'],
  logistics: ['entity', 'metrics', 'compare', 'data', 'events', 'scene', 'plugins'],
  generic: ['entity', 'events', 'data', 'scene', 'plugins'],
};

/**
 * 判定场景画像：世界里有钓组实体（rig-01）就是钓场——看场景内容而不只看插件，
 * 否则开着钓鱼插件导入一个物流布局，也会冒出钓组页。
 */
export function sceneProfileOf(input: { readonly hasRig: boolean; readonly plugins: readonly string[] }): SceneProfile {
  if (input.hasRig && input.plugins.includes('fishing')) return 'fishing';
  if (input.plugins.includes('logistics')) return 'logistics';
  return 'generic';
}

/** 画像下的标签组；决策页只在插件确实贡献了决策域时出现。 */
export function inspectorTabs(profile: SceneProfile, hasDecisions: boolean): TabDef[] {
  return PROFILE_TABS[profile]
    .filter((id) => id !== 'decision' || hasDecisions)
    .map((id) => TAB_DEFS[id]);
}

/** 画像的落地页：钓场先看钓组，其余先看实体。 */
export function defaultTab(profile: SceneProfile): InspectorTab {
  return profile === 'fishing' ? 'rig' : 'entity';
}
