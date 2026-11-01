import type { SceneAuditCheck } from '@twin-platform/scene-audit';
import type { JsonObject } from '@twin-platform/scene-spec';
import type { TwinWorld } from '@twin-platform/world-kernel';

/** 内置检查的构造签名：条目给 params，注册表还一个真检查（subject 是运行中的世界）。 */
export type BuiltInInvariant = (params: JsonObject) => SceneAuditCheck<TwinWorld>;

type Num = (value: unknown, fallback: number) => number;

const num: Num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

const str = (value: unknown, fallback: string): string => (typeof value === 'string' && value ? value : fallback);

/** 按 entityId 分类型计数：`parcel:enter` / `parcel:exit` 的配对关系只能这样读。 */
function countsByEntity(
  world: TwinWorld,
  types: readonly string[],
): Map<string, Record<string, number>> {
  const table = new Map<string, Record<string, number>>();
  for (const event of world.getEventLog()) {
    if (!event.entityId || !types.includes(event.type)) continue;
    const row = table.get(event.entityId) ?? {};
    row[event.type] = (row[event.type] ?? 0) + 1;
    table.set(event.entityId, row);
  }
  return table;
}

/**
 * 环线包裹的进出配对。
 *
 * 输送线是闭环：包裹绕完一圈会先 `parcel:exit` 再 `parcel:enter`，开局额外补一次 enter。
 * 所以"还在环上"的包裹必然 exits = enters − 1。把绕圈当成出货是最典型的口径造假——
 * 数 `parcel:exit` 当吞吐量的看板就栽在这里。
 */
const lineLoop: BuiltInInvariant = (params) => {
  const enterType = str(params.enterType, 'parcel:enter');
  const exitType = str(params.exitType, 'parcel:exit');
  return {
    id: 'logistics.line.loop',
    description: `每个包裹的 ${exitType} 次数必须等于 ${enterType} 次数减一（仍在环上，绕圈不算出货）`,
    check(world) {
      const table = countsByEntity(world, [enterType, exitType]);
      const violations = [];
      const notes: string[] = [];
      for (const [id, row] of table) {
        const enters = row[enterType] ?? 0;
        const exits = row[exitType] ?? 0;
        notes.push(`${id}: enter=${enters} exit=${exits}`);
        if (exits === enters - 1) continue;
        violations.push({
          where: id,
          message:
            exits > enters
              ? `包裹离开了环线却没有重新进入：exit=${exits} > enter-1=${enters - 1}，货物凭空消失。`
              : `exit=${exits} 不等于 enter-1=${enters - 1}：${enters - 1 - exits} 次绕圈没有被记账，不能按 exit 数算吞吐。`,
        });
      }
      return { violations, notes };
    },
  };
};

/**
 * 包裹位姿连续：既不能跑出路径之外，也不能停在环线当摆设。
 *
 * 只验"还在路径上"是恒真的（运动由内核按弧长插值），真正会坏的是
 * `loop=clamp`（走到头就停）被当成循环线，或弧长越界——两者都让"绕圈"的口径失效。
 */
const lineNoTeleport: BuiltInInvariant = (params) => {
  const kind = str(params.kind, 'parcel');
  const tolerance = num(params.tolerance, 1e-6);
  return {
    id: 'logistics.line.no-teleport',
    description: `${kind} 沿闭环路径连续运动：弧长有界且必须 repeat 循环`,
    check(world) {
      const violations = [];
      const notes: string[] = [];
      for (const entity of world.listEntities()) {
        if (entity.kind !== kind || !entity.motion) continue;
        const { distance, speed, loop, path } = entity.motion;
        const total = path.length;
        if (loop !== 'repeat') {
          violations.push({
            where: entity.id,
            message: `路径循环方式为 ${loop}，走到头就停住；环线必须 repeat，否则绕圈口径不成立。`,
          });
        }
        if (distance < -tolerance || (total > 0 && distance > total + tolerance)) {
          violations.push({
            where: entity.id,
            message: `弧长 ${distance.toFixed(3)} 落在路径长度 ${total.toFixed(3)} 之外，包裹凭空出现在路径外。`,
          });
        }
        notes.push(`${entity.id}: distance=${distance.toFixed(3)}/${total.toFixed(3)} loop=${loop}`);
      }
      return { violations, notes };
    },
  };
};

/**
 * 确定性断言：观察窗内没有任何事件，且随机源没被消耗。
 *
 * hello 这类"空场景"以前挂的是占位断言，跑出来 0 条不变量——
 * 换成这条之后，任何偷偷引入 `Math.random()` / 挂钟的行为都会立刻红。
 */
const deterministicQuiet: BuiltInInvariant = (params) => {
  const maxEvents = Math.trunc(num(params.maxEvents, 0));
  return {
    id: 'scene.deterministic.quiet',
    description: `观察窗内事件数不超过 ${maxEvents}，且 rng 未被推进（种子保持原值）`,
    check(world) {
      const events = world.getEventLog();
      const snapshot = world.snapshot();
      const violations = [];
      if (events.length > maxEvents) {
        violations.push({
          where: 'events',
          message: `事件 ${events.length} 条，超过上限 ${maxEvents}：本场景不应有任何行为被激活。`,
        });
      }
      if (snapshot.seed !== undefined && snapshot.rngState !== undefined && snapshot.rngState !== snapshot.seed) {
        violations.push({
          where: 'rng',
          message: `随机源被推进到 ${snapshot.rngState}（种子 ${snapshot.seed}）：有行为消耗了随机，重跑不再可复现。`,
        });
      }
      return {
        violations,
        notes: [`事件 ${events.length} 条`, `rngState=${String(snapshot.rngState ?? '-')} seed=${String(snapshot.seed ?? '-')}`],
      };
    },
  };
};

/**
 * 从领域插件借来的内置检查（惰性 import，避免 scene-cli 静态硬绑插件）。
 *
 * 关键约束：**只注册引用，绝不复制实现**。`logistics.center.flow` / `conservation`
 * 的规则已经写在 `plugins-logistics/src/invariants.ts`，Studio 审计面板与 CI 走的
 * 正是那两个对象；这里若再抄一份，两个口径迟早分叉。loader 每次取的都是同一份导出。
 */
// 动态 import 例外（plugin loading，与 loadCliPlugin 一致）：none 插件的包不静态拖入 plugins-logistics。
const PLUGIN_BACKED: Readonly<Record<string, () => Promise<SceneAuditCheck<TwinWorld>>>> = {
  'logistics.center.flow': async () => (await import('@twin-platform/plugins-logistics')).centerFlowInvariant,
  'logistics.center.conservation': async () => (await import('@twin-platform/plugins-logistics')).centerConservationInvariant,
};

/** 已注册的内置检查。id 就是 scene package 的 `invariants.json` 里 `check` 字段的取值。 */
export const BUILTIN_INVARIANTS: Readonly<Record<string, BuiltInInvariant>> = {
  'logistics.line.loop': lineLoop,
  'logistics.line.no-teleport': lineNoTeleport,
  'scene.deterministic.quiet': deterministicQuiet,
};

export const BUILTIN_INVARIANT_IDS: readonly string[] = [...Object.keys(BUILTIN_INVARIANTS), ...Object.keys(PLUGIN_BACKED)];

export interface ResolvedPackageInvariants {
  readonly checks: readonly SceneAuditCheck<TwinWorld>[];
  /** 登记条目的结构问题（缺 id / check 不是对象…）：解析就报错，不静默丢弃。 */
  readonly errors: readonly string[];
}

/** 未知 id / 查不到函数的条目会变成一条必然 fail 的检查——沿用 runEvalCases 的"缺函数即失败"。 */
function failingCheck(id: string, description: string, reason: string): SceneAuditCheck<TwinWorld> {
  return {
    id,
    description,
    check: () => ({ violations: [{ message: reason }] }),
  };
}

/**
 * 把 `invariants.json` 的登记条目解析成可执行检查。
 *
 * 没有 `check` 字段的条目保持"登记式"语义（只声明以后该验什么，不执行），
 * 这既兼容 logistics-center 已有的两条，也让"写了 check 就一定会被跑"成为硬约束。
 */
export async function resolvePackageInvariants(raw: readonly unknown[]): Promise<ResolvedPackageInvariants> {
  const checks: SceneAuditCheck<TwinWorld>[] = [];
  const errors: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`invariants[${index}] 必须是对象`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    if (!id) {
      errors.push(`invariants[${index}] 缺少 id`);
      continue;
    }
    const declared = record.check;
    if (declared === undefined) continue; // 纯登记，不执行
    if (typeof declared !== 'string') {
      errors.push(`invariants[${index}]（${id}）的 check 必须是内置检查 id 字符串`);
      continue;
    }
    const params = record.params;
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
      errors.push(`invariants[${index}]（${id}）的 params 必须是对象`);
      continue;
    }
    const description = typeof record.description === 'string' ? record.description : undefined;
    // 两条来源：本地构造器（line / quiet），或从插件惰性借来的现成检查（center.*）。
    const build = BUILTIN_INVARIANTS[declared];
    const borrow = PLUGIN_BACKED[declared];
    if (build) {
      const built = build((params ?? {}) as JsonObject);
      checks.push({ ...built, id, description: description ?? built.description });
      continue;
    }
    if (borrow) {
      const borrowed = await borrow();
      checks.push({ ...borrowed, id, description: description ?? borrowed.description });
      continue;
    }
    checks.push(
      failingCheck(
        id,
        description ?? id,
        `check="${declared}" 不是已注册的内置检查（可用：${BUILTIN_INVARIANT_IDS.join(' / ')}）；未执行的断言不算通过。`,
      ),
    );
  }
  return { checks, errors };
}
