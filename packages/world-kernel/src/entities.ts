import type { TwinEntity, TwinTransform, TwinValue, TwinVector3, TwinVisualBinding } from '@twin-platform/scene-schema';
import type { EntityDataSource } from './external';
import type { TwinPath } from './path';

/**
 * 实体的运行时状态。
 *
 * 与 `TwinEntity` 的区别：场景里的实体是"配置"（不可变、可版本化），
 * 运行时状态是"此刻的世界"（可变、可快照、可回放）。
 */

export interface EntityMotionState {
  path: TwinPath;
  /** 沿路径的弧长（米）。 */
  distance: number;
  speed: number;
  loop: 'clamp' | 'repeat';
}

export interface WorldEntityState {
  readonly id: string;
  readonly kind: string;
  readonly capabilities: readonly string[];
  /**
   * 外观声明。内核不解释它，但必须**随状态一起留着**：
   * 运行时生成的实体（发生器产出的小货物、卡车…）没有场景声明可查，
   * 渲染层只能靠它决定画多大、什么颜色。
   */
  readonly visual?: TwinVisualBinding;
  /**
   * 实体声明原件。场景里声明的实体可以从 scene 重建，运行时生成的只能靠它——
   * 快照要把它带上，否则 `restore()` 之后生成出来的货物会变成
   * "没有 capabilities / visual 的野实体"。
   */
  readonly declaration?: TwinEntity;
  /**
   * 场景声明的原始变换。外部 `pose` 信号使用 `frame: "local"` 时以它为原点，
   * 而不是用当前实时变换——否则每一帧都会把上一帧的结果当原点，越跑越飘。
   */
  readonly baseTransform: TwinTransform;
  transform: TwinTransform;
  attrs: Record<string, TwinValue>;
  config: Record<string, unknown>;
  status?: string;
  motion?: EntityMotionState;
  dataSource: EntityDataSource;
}

/** 深拷一份外观声明，避免运行时状态和场景对象互相串改。 */
function cloneVisual(visual: TwinVisualBinding | undefined): TwinVisualBinding | undefined {
  if (!visual) return undefined;
  return {
    ...visual,
    size: visual.size ? ([...visual.size] as TwinVector3) : undefined,
  };
}

export function createEntityState(
  entity: TwinEntity,
  buildMotion: (entity: TwinEntity) => EntityMotionState | undefined,
): WorldEntityState {
  return {
    id: entity.id,
    kind: entity.kind,
    capabilities: [...entity.capabilities],
    visual: cloneVisual(entity.visual),
    declaration: entity,
    baseTransform: { ...entity.transform, position: [...entity.transform.position] as TwinEntity['transform']['position'] },
    transform: { ...entity.transform, position: [...entity.transform.position] as TwinEntity['transform']['position'] },
    attrs: { ...(entity.attrs ?? {}) },
    config: (entity.config ?? {}) as Record<string, unknown>,
    status: undefined,
    motion: buildMotion(entity),
    dataSource: 'sim',
  };
}

export function cloneEntityState(state: WorldEntityState): WorldEntityState {
  return {
    id: state.id,
    kind: state.kind,
    capabilities: [...state.capabilities],
    visual: cloneVisual(state.visual),
    declaration: state.declaration,
    baseTransform: { ...state.baseTransform, position: [...state.baseTransform.position] },
    transform: { ...state.transform, position: [...state.transform.position] },
    attrs: { ...state.attrs },
    config: structuredClone(state.config),
    status: state.status,
    motion: state.motion ? { ...state.motion, distance: state.motion.distance } : undefined,
    dataSource: state.dataSource,
  };
}

/** 快照里的实体：只存可序列化且能重建世界的字段，路径由场景重建。 */
export interface WorldSnapshotEntity {
  id: string;
  kind: string;
  transform: TwinTransform;
  attrs: Record<string, TwinValue>;
  status?: string;
  dataSource: EntityDataSource;
  motionDistance?: number;
  /**
   * 完整声明——只有**运行时生成**的实体才有（场景里声明的实体可以从 scene 重建）。
   * 带上它，`restore()` 才能把生成出来的实体按原样重建（能力、外观、配置、路径）。
   */
  declaration?: TwinEntity;
}

/**
 * @param includeDeclaration 运行时生成的实体要带上声明，否则恢复后就成了"野实体"。
 */
export function toSnapshotEntity(state: WorldEntityState, includeDeclaration = false): WorldSnapshotEntity {
  const record: WorldSnapshotEntity = {
    id: state.id,
    kind: state.kind,
    transform: { ...state.transform, position: [...state.transform.position] },
    attrs: { ...state.attrs },
    status: state.status,
    dataSource: state.dataSource,
    motionDistance: state.motion?.distance,
  };
  if (includeDeclaration && state.declaration) record.declaration = structuredClone(state.declaration);
  return record;
}
