import type { TwinScene } from '@twin-platform/scene-schema';

/**
 * 演示场景：把 TwinSceneController 里原先写死的三个盒子搬到版本化场景 JSON 里。
 *
 * 这份数据以后会来自 `scene_versions` 表或插件生成；现在先作为单一真相，
 * 渲染层只消费它，不再自己维护一份设备列表。
 */
export const demoScene: TwinScene = {
  version: 1,
  id: 'demo-line',
  name: '物流产线概览',
  entities: [
    {
      id: 'infeed-01',
      kind: 'transport',
      transform: { position: [-4, 0.6, 0] },
      capabilities: ['move'],
      visual: { kind: 'box', color: '#22c55e', size: [2.7, 0.7, 1.6] },
      config: { label: '入料输送线' },
    },
    {
      id: 'inspection-01',
      kind: 'inspect',
      transform: { position: [0, 0.8, 0] },
      capabilities: ['inspect'],
      visual: { kind: 'box', color: '#38bdf8', size: [2.7, 1.6, 1.6] },
      config: { label: '视觉检测站' },
    },
    {
      id: 'buffer-01',
      kind: 'buffer',
      transform: { position: [4, 1, 0] },
      capabilities: ['store'],
      visual: { kind: 'box', color: '#f59e0b', size: [2.2, 2, 1.8] },
      config: { label: '缓存货架' },
    },
    {
      // 由内核推动的物料：沿产线循环，用来肉眼确认内核在跑。
      id: 'cargo-01',
      kind: 'parcel',
      transform: { position: [-4, 1.15, 0] },
      capabilities: ['move'],
      visual: { kind: 'box', color: '#f97316', size: [0.6, 0.6, 0.6] },
      motion: { points: [[-5.2, 1.15, 0], [5.2, 1.15, 0]], speed: 1.6, loop: 'repeat', cornerRadius: 0 },
      config: { label: '在制物料' },
    },
  ],
};

export const entityLabel = (label: unknown, fallback: string): string => (typeof label === 'string' && label.length > 0 ? label : fallback);
