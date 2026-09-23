import type { ActionDescriptor } from '@twin-platform/decision-core';

/**
 * 台钓动作空间：封闭枚举、可逆优先。
 *
 * 判断者（规则或 Jev）只能从这里挑一个动作。不可逆动作显式标 true 的
 * reversible = false，策略层据此更保守。
 */
export type FishingActionId =
  | 'NO_CHANGE'
  | 'OBSERVE'
  | 'ADJUST_FLOAT'
  | 'ADD_LEAD'
  | 'CHANGE_BAIT'
  | 'CHANGE_LAYER'
  | 'REFILL_NEST'
  | 'REBUILD_RIG'
  | 'CHANGE_SPOT';

export const FISHING_ACTIONS: readonly ActionDescriptor<FishingActionId>[] = [
  { id: 'NO_CHANGE', label: '保持现状', reversible: true, params: [] },
  {
    id: 'OBSERVE',
    label: '继续观察',
    reversible: true,
    params: [{ name: 'casts', kind: 'number', min: 1, max: 20, step: 1 }],
  },
  {
    id: 'ADJUST_FLOAT',
    label: '调整浮漂',
    reversible: true,
    params: [
      { name: 'direction', kind: 'enum', options: ['sensitive', 'blunt'] },
      { name: 'steps', kind: 'number', min: 0.5, max: 2, step: 0.5 },
    ],
  },
  {
    id: 'ADD_LEAD',
    label: '加铅抗流',
    reversible: true,
    params: [{ name: 'amount', kind: 'enum', options: ['light', 'medium', 'heavy'] }],
  },
  {
    id: 'CHANGE_BAIT',
    label: '换饵',
    reversible: true,
    params: [{ name: 'target', kind: 'enum', options: ['flavor', 'state', 'size'] }],
  },
  {
    id: 'CHANGE_LAYER',
    label: '改钓层',
    reversible: true,
    params: [
      { name: 'direction', kind: 'enum', options: ['up', 'down'] },
      { name: 'band', kind: 'number', min: 0.5, max: 2, step: 0.5 },
    ],
  },
  {
    id: 'REFILL_NEST',
    label: '补窝',
    reversible: true,
    params: [{ name: 'amount', kind: 'enum', options: ['light', 'normal', 'heavy'] }],
  },
  {
    id: 'REBUILD_RIG',
    label: '改钓组',
    reversible: false,
    params: [{ name: 'target', kind: 'enum', options: ['hook', 'line', 'float'] }],
  },
  {
    id: 'CHANGE_SPOT',
    label: '换钓位',
    reversible: false,
    params: [{ name: 'urgency', kind: 'enum', options: ['now', 'later'] }],
  },
];

export const FISHING_ACTION_IDS: readonly FishingActionId[] = FISHING_ACTIONS.map((item) => item.id);
