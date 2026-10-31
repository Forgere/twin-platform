import type { TwinScene } from './index';

/**
 * 场景版本之间的差异：**给版本历史与回滚用的只读视图**。
 *
 * 它不是编辑协议（那是 `ops.ts`）：ops 是"要做什么"，diff 是"已经差在哪"。
 * 两者都按实体 id 对齐，因为场景顺序是契约的一部分——diff 不能因为数组重排
 * 就报告"全变了"。
 */

export interface SceneEntityChange {
  id: string;
  /** 变化的实体顶层字段，按字母序；`transform` 表示位姿变了。 */
  fields: string[];
}

export interface SceneDiff {
  /** 只在 `after` 里出现的实体，按 after 顺序。 */
  added: string[];
  /** 只在 `before` 里出现的实体，按 before 顺序。 */
  removed: string[];
  /** 两边都有但内容不同的实体，按 after 顺序。 */
  changed: SceneEntityChange[];
  /** 场景级字段（`name` / `metadata` / `version` 等）变化，按字母序。 */
  sceneFields: string[];
}

/** 结构化相等：忽略对象键顺序，数组按位置比较，`undefined` 与缺字段等价。 */
export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameValue(item, right[index]));
  }
  if (left && right && typeof left === 'object') {
    const leftKeys = Object.keys(left).filter((key) => (left as Record<string, unknown>)[key] !== undefined);
    const rightKeys = Object.keys(right).filter((key) => (right as Record<string, unknown>)[key] !== undefined);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  }
  // NaN 不是合法场景值（校验会拒），这里不特殊处理。
  return false;
}

/** 两份场景文档是否逐字段相同。 */
export function sameScene(left: TwinScene, right: TwinScene): boolean {
  return sameValue(left, right);
}

const changedFields = (before: Record<string, unknown>, after: Record<string, unknown>): string[] => {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete('id'); // id 是匹配键，不参与"字段变化"。
  return [...keys]
    .filter((key) => !sameValue(before[key], after[key]))
    .sort((left, right) => left.localeCompare(right));
};

export function diffScenes(before: TwinScene, after: TwinScene): SceneDiff {
  const beforeById = new Map(before.entities.map((entity) => [entity.id, entity as unknown as Record<string, unknown>]));
  const afterById = new Map(after.entities.map((entity) => [entity.id, entity as unknown as Record<string, unknown>]));

  const added = after.entities.filter((entity) => !beforeById.has(entity.id)).map((entity) => entity.id);
  const removed = before.entities.filter((entity) => !afterById.has(entity.id)).map((entity) => entity.id);
  const changed: SceneEntityChange[] = [];
  for (const entity of after.entities) {
    const previous = beforeById.get(entity.id);
    if (!previous) continue;
    const fields = changedFields(previous, entity as unknown as Record<string, unknown>);
    if (fields.length > 0) changed.push({ id: entity.id, fields });
  }

  const sceneFields = changedFields(
    before as unknown as Record<string, unknown>,
    after as unknown as Record<string, unknown>,
  ).filter((key) => key !== 'entities');

  return { added, removed, changed, sceneFields };
}
