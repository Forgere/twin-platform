/**
 * "当前选择"卡片的**唯一取数入口**。
 *
 * 检视面板渲染它，工具与 AI 也调它——"这个实体现在什么状态、能不能改布局"
 * 这个问题只允许有一个答案来源，否则人看到的和模型看到的迟早长成两套东西。
 *
 * 纯函数：只读世界，不碰 DOM / Three，所以面板、测试、工具、AI 都能直接调（有测试）。
 * 返回值一律是**副本**，调用方改它不会写回世界。
 */

import type { TwinTransform, TwinValue, TwinVector3 } from '@twin-platform/scene-schema';
import type { PoseEditability, TwinWorld } from '@twin-platform/world-kernel';
import { entityLabel } from './demoScene';
import { describeEntityState } from './entityState';

export interface SelectionCard {
  id: string;
  /** 显示名（声明里的 config.label，没有就退回 id）。 */
  label: string;
  kind: string;
  /** 实时状态"人话"行（世界 attrs 经 entityState.ts 翻译），面板逐行显示。 */
  stateLines: string[];
  /** 原始 attrs / status：人话是给眼睛的，这两样是给工具与 AI 判断用的。 */
  attrs: Record<string, TwinValue>;
  status?: string;
  capabilities: readonly string[];
  /** 场景声明里的位姿（编辑输入框绑的就是它）；undefined = 不在声明里（运行时生成）。 */
  declared?: TwinTransform;
  /** 此刻的运行时位姿。 */
  runtime: TwinTransform;
  /** 由路径驱动（声明了 motion）。 */
  hasMotion: boolean;
  /** 能不能改布局 + 内核给的原因，别让调用方自己猜。 */
  editability: PoseEditability;
  /** 渲染来源（模型溯源）：只有渲染层答得上来，工具 / AI 不传就没有。 */
  codePath?: string;
}

/** rotation / scale 是可选字段：没写就别硬塞 `undefined` 进去（调用方的相等判断会踩）。 */
const copyTransform = (transform: TwinTransform): TwinTransform => ({
  ...transform,
  position: [...transform.position] as TwinVector3,
  ...(transform.rotation ? { rotation: [...transform.rotation] as TwinVector3 } : {}),
  ...(transform.scale ? { scale: [...transform.scale] as TwinVector3 } : {}),
});

/**
 * 组一张"当前选择"卡片。
 *
 * @param world  只读世界
 * @param id     实体 id；undefined 或查不到 → undefined（面板按"没选中"渲染）
 * @param codePath 渲染来源，渲染层可传，工具 / AI 可省
 */
export function selectionCard(world: TwinWorld, id: string | undefined, codePath?: string): SelectionCard | undefined {
  if (!id) return undefined;
  const state = world.getEntity(id);
  if (!state) return undefined;
  const declaredEntity = world.scene.entities.find((entity) => entity.id === id);
  return {
    id,
    label: entityLabel(state.config?.label ?? declaredEntity?.config?.label, id),
    kind: state.kind,
    stateLines: describeEntityState(state),
    attrs: { ...state.attrs },
    status: state.status,
    capabilities: [...state.capabilities],
    declared: declaredEntity ? copyTransform(declaredEntity.transform) : undefined,
    runtime: copyTransform(state.transform),
    hasMotion: state.motion !== undefined,
    editability: world.poseEditability(id),
    codePath,
  };
}
