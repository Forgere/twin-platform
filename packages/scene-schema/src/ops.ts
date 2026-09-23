/**
 * 场景编辑操作（ops）：**布局改动的结构化表达**。
 *
 * 为什么不是"改完整份 JSON 再存一份"：
 * 1. 改一个设备的位置，整份场景可能上百 KB，每次拖一下就复制一整份是浪费，
 *    而且历史里全是重复内容，diff 看不出到底改了什么；
 * 2. 要支持"谁在什么时候把 A 从 (0,0) 挪到 (1,1)"这类审计 / 回滚 / diff，
 *    需要的就是**动作**，不是动作之后的结果快照；
 * 3. AI 生成布局与手动拖拽是同一个问题的两种输入，共用同一套 op 之后，
 *    存储、校验、回滚只需要实现一次。
 *
 * 设计约束（与 `index.ts` 的三条硬规则一致）：
 * 1. 纯 TypeScript、纯函数——`applySceneOps` 不改入参，返回结构共享的新场景；
 * 2. 每条 op 自带 `before`（应用前的值），状态对不上就拒绝：
 *    "你基于的是旧状态"必须当场暴露，而不是安静地覆盖别人的改动。
 *    阶段 K 会把它升级成服务端乐观锁（`baseVersion` 冲突回 409）。
 * 3. 应用结果必须仍然通过 `validateTwinScene`——编辑永远不能把场景改坏。
 *
 * 循环依赖说明：与 `io.ts` 一样，从 `./index` 引入类型与校验函数，但只在函数体内
 * 调用运行时绑定（`validateTwinScene`），顶层不执行，ESM 循环引用是安全的。
 */

import {
  validateTwinScene,
  type SceneValidationIssue,
  type TwinEntity,
  type TwinScene,
  type TwinTransform,
  type TwinVector3,
} from './index';

/** 改一个实体的位姿——当前阶段唯一的编辑动作（增删实体等随各自的 UI 一起加）。 */
export interface SetTransformOp {
  readonly type: 'setTransform';
  readonly entityId: string;
  /** 应用前该实体的位姿；与实际不符即拒绝（乐观校验）。 */
  readonly before: TwinTransform;
  /** 应用后的新位姿。 */
  readonly after: TwinTransform;
}

export type SceneOp = SetTransformOp;

/** op 应用失败：实体不存在、基于旧状态、或者结果非法。`issues` 给 UI 逐条展示。 */
export class SceneOpError extends Error {
  readonly issues: SceneValidationIssue[];

  constructor(issues: SceneValidationIssue[]) {
    super(issues.map((issue) => `${issue.path} ${issue.message}`).join('; '));
    this.name = 'SceneOpError';
    this.issues = issues;
  }
}

const vector = (value: TwinVector3): TwinVector3 => [value[0], value[1], value[2]];

const sameVector = (a: TwinVector3 | undefined, b: TwinVector3 | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

/** 位姿逐字段相等（缺失的 rotation/scale 视为相等）。UI 拿它判断"有没有改动"。 */
export function sameTransform(a: TwinTransform, b: TwinTransform): boolean {
  return sameVector(a.position, b.position) && sameVector(a.rotation, b.rotation) && sameVector(a.scale, b.scale);
}

/**
 * 复制位姿并切断与调用方的数组别名。
 *
 * 拖拽预览时调用方常复用同一个数组反复写；op 要长期保存（阶段 K 落库），
 * 必须自己持有数据，否则预览一变历史就跟着变。
 */
function copyTransform(value: TwinTransform): TwinTransform {
  const out: TwinTransform = { position: vector(value.position) };
  if (value.rotation) out.rotation = vector(value.rotation);
  if (value.scale) out.scale = vector(value.scale);
  return out;
}

/**
 * 应用一组编辑 ops，返回**新场景**（入参不动，未被改到的实体沿用原引用）。
 *
 * 结构共享是刻意的：百实体场景拖一下只换一个实体对象与一条 `entities` 数组，
 * 内核那边 `world.scene` 的对象引用保持不变（它在构造时被赋给 readonly 字段），
 * 只需要替换 `entities` 数组——所有持有 `world.scene` 的地方自动看到新布局。
 *
 * @throws {SceneOpError} 实体不在场景声明里 / `before` 对不上 / 结果没通过校验。
 */
export function applySceneOps(scene: TwinScene, ops: readonly SceneOp[]): TwinScene {
  if (ops.length === 0) return scene;

  const byId = new Map<string, TwinEntity>(scene.entities.map((entity) => [entity.id, entity]));
  const replacements = new Map<string, TwinEntity>();

  for (const op of ops) {
    if (op.type !== 'setTransform') {
      throw new SceneOpError([{ path: '$', message: `未知操作 ${String((op as { type?: string }).type)}。` }]);
    }
    const declared = byId.get(op.entityId);
    if (!declared) {
      throw new SceneOpError([
        {
          path: `$.entities[?id=${op.entityId}]`,
          message: '实体不在场景声明里（运行时生成的实体没有布局可改）。',
        },
      ]);
    }
    // 同一批 op 里可能连着改同一个实体：以**上一条改完的结果**为基准来校验 before。
    const current = replacements.get(op.entityId) ?? declared;
    if (!sameTransform(current.transform, op.before)) {
      throw new SceneOpError([
        {
          path: `$.entities[?id=${op.entityId}].transform`,
          message: '当前位姿与这条编辑记录的 before 不一致——你基于的是旧状态，放弃这次编辑。',
        },
      ]);
    }
    replacements.set(op.entityId, { ...current, transform: copyTransform(op.after) });
  }

  const entities = scene.entities.map((entity) => replacements.get(entity.id) ?? entity);
  const next: TwinScene = { ...scene, entities };
  const issues = validateTwinScene(next);
  if (issues.length > 0) throw new SceneOpError(issues);
  return next;
}
