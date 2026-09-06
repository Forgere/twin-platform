import type { TwinEntity, TwinTransform, TwinValue } from '@twin-platform/scene-schema';
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

export function createEntityState(
  entity: TwinEntity,
  buildMotion: (entity: TwinEntity) => EntityMotionState | undefined,
): WorldEntityState {
  return {
    id: entity.id,
    kind: entity.kind,
    capabilities: [...entity.capabilities],
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
}

export function toSnapshotEntity(state: WorldEntityState): WorldSnapshotEntity {
  return {
    id: state.id,
    kind: state.kind,
    transform: { ...state.transform, position: [...state.transform.position] },
    attrs: { ...state.attrs },
    status: state.status,
    dataSource: state.dataSource,
    motionDistance: state.motion?.distance,
  };
}
