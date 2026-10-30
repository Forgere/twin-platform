import { runAudit, type SceneAuditCheck } from '@twin-platform/scene-audit';
import type { AuditReport, AuditStatus } from '@twin-platform/scene-spec';
import type { TwinWorld, WorldEvent } from '@twin-platform/world-kernel';

/**
 * 审计面板的取数层：把 `runAudit` 的报告翻译成"能点、能回放"的证据。
 *
 * 边界很清楚：
 * - 判定归 `scene-audit`（和 `bun run scene audit` 同一个执行器、同一组不变量），
 *   这里不重算守恒、不自己判通过；
 * - 不变量里的 `where` 是自由文本（领域包不该认识 Studio），所以"定位"这一步
 *   要靠**事件日志**去反推实体与时序，推不出来就老实留空，不编一个位置。
 *
 * 纯函数：不读挂钟、不改世界、不写信号。审计是只读检查，不能有副作用。
 */

/** 一条违例能指回的画面位置：哪个实体、哪一刻。 */
export interface AuditTarget {
  /** 世界里可选中 / 可取景的实体；对不上实体时缺省。 */
  readonly entityId?: string;
  /** 仿真时刻（秒）。点定位是 `controller.seek(at)`，恢复快照后重算，不插值。 */
  readonly at?: number;
  /** 凭什么定位到这里——把这句摆在按钮旁边，审计才不是黑箱。 */
  readonly evidence: string;
}

export interface AuditFinding {
  readonly message: string;
  readonly where?: string;
  readonly target?: AuditTarget;
}

export interface AuditCheckView {
  readonly id: string;
  readonly description: string;
  readonly status: AuditStatus;
  readonly findings: readonly AuditFinding[];
  readonly notes: readonly string[];
}

/**
 * 一条能在**画面上标出来**的违例：除了定位，还带 check 与严重度。
 *
 * 三维轮廓 / 时间轴标记 / 巡演都只读它——视觉层不该自己去报告里翻结构。
 */
export interface SceneAuditSpot extends AuditTarget {
  readonly checkId: string;
  readonly check: string;
  readonly message: string;
  readonly severity: 'fail' | 'error';
}

export interface SceneAuditView {
  readonly passed: boolean;
  readonly sceneId: string;
  /** 证据窗口：判断只覆盖这一段，报告必须说清它覆盖了哪一段。 */
  readonly evidence: { readonly from: number; readonly to: number; readonly events: number };
  /** 窗口从 t=0 开始吗；否则累计口径的不变量会把“没看到”报成“不符合”。 */
  readonly windowComplete: boolean;
  /** 审计自己的局限：窗口不足、报告自带的警告。不掩盖，摆到面板顶上。 */
  readonly warnings: readonly string[];
  /** 窗口内最后一条事件的定位：通过时也能“去看现场”，面板不会是一块死板子。 */
  readonly latest?: AuditTarget;
  readonly counts: { readonly pass: number; readonly fail: number; readonly error: number };
  readonly checks: readonly AuditCheckView[];
  /** 和 CLI 逐字节同一份结构：复制出去就能 `bun run scene report`。 */
  readonly report: AuditReport;
}

/** 复合口径的 `where`（守恒类不变量用的是账本名，不是事件名）。 */
const EVENT_GROUPS: Readonly<Record<string, readonly string[]>> = {
  goods: ['goods:produced', 'goods:packed'],
  pallets: ['goods:packed', 'asrs:store', 'asrs:retrieve', 'goods:shipped'],
};

/** 倒着扫：审计要看的是"最后一次把它打破的时刻"，不是第一条。 */
function lastMatching(events: readonly WorldEvent[], match: (event: WorldEvent) => boolean): WorldEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && match(event)) return event;
  }
  return undefined;
}

const seconds = (value: number): string => `${value.toFixed(2)}s`;

/**
 * `where` → 定位目标。
 *
 * 三级降级，每一级都要求**证据存在**才返回：
 * 1. `where` 是实体 id（场景声明的或运行时生成的）→ 该实体 + 它最后一次事件；
 * 2. `where` 是事件类型或账本名 → 该类事件最后一条（含 entityId 时连实体一起给）；
 * 3. 都对不上 → 不给目标。缺失本身不是位置，硬凑一个只会让人点到错的地方。
 */
function targetFor(world: TwinWorld, events: readonly WorldEvent[], where: string | undefined): AuditTarget | undefined {
  if (!where) return undefined;

  const isEntity = world.getEntity(where) !== undefined || world.scene.entities.some((entity) => entity.id === where);
  if (isEntity) {
    const event = lastMatching(events, (item) => item.entityId === where);
    if (!event) return { entityId: where, evidence: '实体还在场，观察窗内没有它的事件' };
    return { entityId: where, at: event.occurredAt, evidence: `实体 ${where} 最后一次 ${event.type} @ t=${seconds(event.occurredAt)}` };
  }

  const types = EVENT_GROUPS[where] ?? [where];
  const event = lastMatching(events, (item) => types.includes(item.type));
  if (!event) return undefined;
  return {
    entityId: event.entityId,
    at: event.occurredAt,
    evidence: `最后一次 ${event.type} @ t=${seconds(event.occurredAt)}${event.entityId ? ` · ${event.entityId}` : ''}`,
  };
}

/** 窗口内最后一条事件：审计的"现场"就是它，通过时也能回去看一眼。 */
function latestTarget(events: readonly WorldEvent[]): AuditTarget | undefined {
  const event = events[events.length - 1];
  if (!event) return undefined;
  return {
    entityId: event.entityId,
    at: event.occurredAt,
    evidence: `最后一条事件 ${event.type} @ t=${seconds(event.occurredAt)}${event.entityId ? ` · ${event.entityId}` : ''}`,
  };
}

/**
 * 对当前世界跑一遍不变量。
 *
 * `world.getEventLog()` 是有界内存日志：长跑之后头部会被丢。所以报告里的
 * `evidence.from` 取日志第一条的仿真时刻，而不是 0——窗口就是窗口，不假装看过全程。
 */
export function auditScene(world: TwinWorld, checks: readonly SceneAuditCheck<TwinWorld>[]): SceneAuditView {
  const events = world.getEventLog();
  const from = events[0]?.occurredAt ?? 0;
  /**
   * 窗口是不是从 t=0 开始的。
   *
   * 回放回跳会截断旧时间线，长跑还会撞上内存日志容量上限；两种情况下
   * 累计口径（守恒、全链路事件）会把“这段窗口里没看到”读成“不存在”，
   * 报出一条假红灯。审计不该只会在两种错误之间选：
   * 它必须能说“我这段证据不够判”，而不是装成看过了全程。
   */
  const windowComplete = from <= world.stepSize;
  const windowWarning = `证据窗口从 t=${seconds(from)} 开始，不覆盖全程（回放回跳截断了旧时间线，或撞上内存日志容量上限）。累计口径的不变量（守恒 / 全链路）在这段窗口里可能误报：先看窗口，再判死。`;
  const report = runAudit({
    sceneId: world.scene.id,
    subject: world,
    checks,
    metrics: { time: world.time, entities: world.listEntities().length, events: events.length },
    warnings: windowComplete ? [] : [windowWarning],
  });
  const warnings = [...report.warnings];

  const counts = { pass: 0, fail: 0, error: 0 };
  const checksView: AuditCheckView[] = report.checks.map((check) => {
    counts[check.status] += 1;
    return {
      id: check.id,
      description: check.description,
      status: check.status,
      notes: [...check.notes],
      findings: check.violations.map((violation) => ({
        message: violation.message,
        where: violation.where,
        target: targetFor(world, events, violation.where),
      })),
    };
  });

  return {
    passed: report.passed,
    sceneId: report.sceneId,
    evidence: { from: events[0]?.occurredAt ?? 0, to: world.time, events: events.length },
    windowComplete,
    warnings,
    latest: latestTarget(events),
    counts,
    checks: checksView,
    report,
  };
}

/**
 * 报告 → 画面上的标记：每条有证据的违例浓缩成一个“点”。
 *
 * 三条规矩：
 * 1. **只对有 target 的违例出点**。定位不出来的违例在面板里说清楚就够了，
 *    在画面上随便找个地方插旗就是骗人；
 * 2. **去重**：同一 check 打到同一实体同一时刻只出一面旗，不然一台坏设备会被
 *    五面一模一样的旗淹掉；
 * 3. **按时刻升序**：巡演与轴标记按时间顺序走，跳来跳去的顺序没法讲清一件事。
 *
 * 纯函数，和 `auditScene` 一样不改世界、不读挂钟。
 */
export function auditSpots(view: SceneAuditView): readonly SceneAuditSpot[] {
  const spots: SceneAuditSpot[] = [];
  const seen = new Set<string>();
  for (const check of view.checks) {
    if (check.status === 'pass') continue;
    for (const finding of check.findings) {
      const target = finding.target;
      if (!target) continue;
      const key = `${check.id}@${target.entityId ?? '-'}:${target.at ?? '-'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      spots.push({
        entityId: target.entityId,
        at: target.at,
        evidence: target.evidence,
        checkId: check.id,
        check: check.description,
        message: finding.message,
        severity: check.status === 'error' ? 'error' : 'fail',
      });
    }
  }
  spots.sort((left, right) => (left.at ?? Number.POSITIVE_INFINITY) - (right.at ?? Number.POSITIVE_INFINITY));
  return spots;
}

/**
 * 违例里的实体：三维该给哪些对象套上报警轮廓。
 *
 * 没有 entityId 的违例（例如“缺 goods:packed 这一环”）不进这张表——
 * 它没法在画面上指出“哪里”，对应的就是“缺失本身不是位置”。
 */
export function auditedEntityIds(view: SceneAuditView): readonly string[] {
  const ids = new Set<string>();
  for (const spot of auditSpots(view)) if (spot.entityId) ids.add(spot.entityId);
  return [...ids];
}
