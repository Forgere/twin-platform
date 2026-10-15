import { writeFileSync } from 'node:fs';
import { TwinWorld } from '@twin-platform/world-kernel';
import { calculateRigState, type TaidiaoInput } from '../src/fishingCore.ts';
import { applyFishingDecision, fishingView } from '../src/environment.ts';
import { createFishSimBehavior, fishingLayout, type FishingLayout } from '../src/fishSim.ts';
import { buildFishingScene } from '../src/template.ts';
import { FISHING_ACTIONS, type FishingActionId } from '../src/actionSpace.ts';
import { BITE_SIGNAL_POOL, biteSignalWeights, liftWindowOf } from '../src/biteSignals.ts';
import { num, str } from '../src/values.ts';
import { CHECKS } from '../evals/checks.ts';

/**
 * 场景审计（audit-scene）—— 借鉴两个项目的审查纪律：
 *
 * - **Anatomy**：一个 audit 脚本"证明没有任何部件互相穿过、每个部件都挂在
 *   该挂的地方"。钓鱼版：证明线组链条自上而下严格有序、整链在水里、饵不离钩、
 *   浮漂插在水面——而且**图上位置就是行为写进世界的位置**（剖面视图同时是
 *   FishSim 的可视化测试）。
 * - **machine-skill**："Look at it like a critic"——渲染后必须读图，至少四轮。
 *   没有浏览器的场合，等价物是 **ASCII 剖面抽检**：把代表性配置画成文本剖面，
 *   人直接读；数字全部来自模型输出，没有一个手写。
 *
 *   bun run packages/plugins-fishing/scripts/audit-scene.ts
 *
 * 输出：控制台摘要 + `evals/audit-report.md`（可复查的审查记录）。
 */

const RIG = 'rig-01';
const SLOT_ENTITIES: readonly (keyof FishingLayout)[] = ['float', 'sinker', 'swivel', 'upperHook', 'lowerHook', 'upperBait', 'lowerBait'];

interface Violation {
  readonly where: string;
  readonly what: string;
}

const violations: Violation[] = [];
const notes: string[] = [];
const fail = (where: string, what: string): void => {
  violations.push({ where, what });
};

// ---------------------------------------------------------------------------
// 1. 布局不变量：参数空间网格扫描
// ---------------------------------------------------------------------------

/** 网格：合法调钓参数 × 水深。浅水兜底路径也要覆盖。 */
const GRID_INPUTS: TaidiaoInput[] = [];
for (const t0 of [3, 4, 5, 6, 8]) {
  for (const t of [0.5, 1, 2, 3]) {
    if (t >= t0) continue;
    const H = t0 - t;
    for (const w of [0.5, 1, 1.5, 2]) {
      for (const d of [0, 0.5, 1, 2, 3, 4, 5, 6]) {
        const input = { t0, t, w, d };
        if (!calculateRigState(input).ok) continue; // 非法的交给 validate 管，不进来
        GRID_INPUTS.push(input);
      }
    }
  }
}

const DEPTHS = [0.5, 1, 1.5, 2, 2.2, 3, 4];

function auditLayoutInvariants(): number {
  let checked = 0;
  for (const input of GRID_INPUTS) {
    const result = calculateRigState(input);
    if (!result.ok) continue;
    for (const depth of DEPTHS) {
      const surfaceY = depth; // 模板约定：水面在 y=depth，水底贴地 y=0
      const layout = fishingLayout(input, result.state, { surfaceY, depth });
      const where = `t0=${input.t0} t=${input.t} w=${input.w} d=${input.d} depth=${depth}`;
      checked += 1;

      // 链序（自上而下严格递减）：漂 → 铅 → 8字环 → 上钩 → 下钩。
      const chain = [layout.float[1], layout.sinker[1], layout.swivel[1], layout.upperHook[1], layout.lowerHook[1]];
      for (let i = 1; i < chain.length; i++) {
        if (!(chain[i - 1]! > chain[i]!)) fail(where, `链序破坏：第 ${i} 个部件没有在下一个之上（${chain.map((y) => y.toFixed(3)).join(' > ')}）`);
      }
      // 上钩在下钩之上（并联子线，不是串联）。
      if (!(layout.upperHook[1] > layout.lowerHook[1])) fail(where, '上钩没有在下钩之上');

      // 整链在水里：铅坠必须没入水面以下；下钩必须在水底以上。
      if (!(layout.sinker[1] < surfaceY - 0.05)) fail(where, `铅坠露出或贴水面向（sinker=${layout.sinker[1].toFixed(3)} >= surface=${surfaceY}）`);
      if (!(layout.lowerHook[1] > surfaceY - depth + 0.01)) fail(where, `下钩穿透水底（lowerHook=${layout.lowerHook[1].toFixed(3)}）`);

      // 饵不离钩：每只饵与它的钩重合（同一挂点）。
      if (Math.abs(layout.lowerBait[1] - layout.lowerHook[1]) > 1e-9) fail(where, '下饵脱离下钩');
      if (Math.abs(layout.upperBait[1] - layout.upperHook[1]) > 1e-9) fail(where, '上饵脱离上钩');

      // 浮漂插在水面：漂身在 surfaceY 附近（露出 d 目 → 漂身上移，但不飞离水面）。
      if (!(layout.float[1] > surfaceY - 0.25 && layout.float[1] < surfaceY + 0.25)) fail(where, `浮漂离开水面（float=${layout.float[1].toFixed(3)}）`);
    }
  }
  notes.push(`布局网格：${GRID_INPUTS.length} 组调钓参数 × ${DEPTHS.length} 种水深 = ${checked} 个布局，全部满足链序 / 没入 / 饵钩重合`);
  return checked;
}

// ---------------------------------------------------------------------------
// 2. 图与行为一致：世界实体 transform === fishingLayout 输出
// ---------------------------------------------------------------------------

function auditViewMatchesWorld(): number {
  let checked = 0;
  for (const input of [
    { t0: 4, t: 2, w: 1, d: 2 },
    { t0: 5, t: 4, w: 1, d: 2.5 },
    { t0: 6, t: 4, w: 1, d: 4 },
    { t0: 8, t: 2, w: 1.5, d: 6 },
  ]) {
    for (const depth of [0.8, 2, 3.5]) {
      const world = new TwinWorld(buildFishingScene({ rig: input, depth, castInterval: 1 }), {
        seed: 1,
        maxStepsPerAdvance: 600,
        behaviors: [createFishSimBehavior()],
      });
      // 首帧（模板初始布局）与推进 90 步后（行为写入）各查一次。
      for (const frame of [0, 90]) {
        if (frame > 0) world.runSteps(frame);
        const view = fishingView(world);
        if (!view) {
          fail(`depth=${depth}`, 'fishingView 读不到钓场');
          continue;
        }
        for (const slot of SLOT_ENTITIES) {
          const entity = world.getEntity(`float-01`) ? world.getEntity(slotEntityId(slot)) : undefined;
          const position = entity?.transform.position;
          const expected = view.layout[slot];
          if (!position) {
            fail(`depth=${depth}`, `布局实体缺失：${slotEntityId(slot)}`);
            continue;
          }
          checked += 1;
          for (let axis = 0; axis < 3; axis++) {
            if (Math.abs(position[axis]! - expected[axis]!) > 1e-9) {
              fail(`depth=${depth} ${slot}`, `图与行为不一致：世界 ${position[axis]} vs 布局 ${expected[axis]}`);
            }
          }
        }
      }
    }
  }
  notes.push(`图与行为一致：${checked} 个实体位置与世界写入逐一相符（首帧 + 推进后）`);
  return checked;
}

const slotEntityId = (slot: keyof FishingLayout): string =>
  ({ float: 'float-01', sinker: 'sinker-01', swivel: 'swivel-01', upperHook: 'hook-upper-01', lowerHook: 'hook-lower-01', upperBait: 'bait-upper-01', lowerBait: 'bait-lower-01' } as const)[slot];

// ---------------------------------------------------------------------------
// 3. 动作落地：每个动作都真的改世界（OBSERVE / NO_CHANGE 合法地不动）
// ---------------------------------------------------------------------------

function auditActionsLand(): void {
  const idle: readonly FishingActionId[] = ['OBSERVE', 'NO_CHANGE'];
  for (const action of FISHING_ACTIONS) {
    const world = new TwinWorld(buildFishingScene({ castInterval: 1 }), {
      seed: 1,
      maxStepsPerAdvance: 600,
      behaviors: [createFishSimBehavior()],
    });
    const before = { ...(world.getEntity(RIG)?.attrs ?? {}) };
    const note = applyFishingDecision(world, { action: action.id, params: defaultParams(action) }, 0);
    const after = world.getEntity(RIG)?.attrs ?? {};
    const changed = Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    if (idle.includes(action.id)) {
      notes.push(`动作 ${action.id}：合法不动（${note}）`);
      continue;
    }
    if (changed.length === 0) fail(`动作 ${action.id}`, '执行后世界没有任何变化——动作是 no-op');
    else notes.push(`动作 ${action.id}：改了 ${changed.join(', ')}（${note}）`);
  }
}

const defaultParams = (action: { readonly id: FishingActionId }): Record<string, number | string> => {
  switch (action.id) {
    case 'ADJUST_FLOAT':
      return { direction: 'blunt', steps: 1 };
    case 'ADD_LEAD':
      return { amount: 'medium' };
    case 'CHANGE_BAIT':
      return { target: 'flavor' };
    case 'CHANGE_LAYER':
      return { direction: 'down', band: 1 };
    case 'REFILL_NEST':
      return { amount: 'normal' };
    case 'REBUILD_RIG':
      return { target: 'hook' };
    case 'CHANGE_SPOT':
      return { urgency: 'now' };
    default:
      return {};
  }
};

// ---------------------------------------------------------------------------
// 4. 漂相不变量（权重表 + 窗口）
// ---------------------------------------------------------------------------

function auditSignalInvariants(): void {
  const zones = ['off_bottom', 'sensitive', 'neutral', 'blunt', 'sinker_on_bottom'] as const;
  const fish = ['crucian', 'carp', 'grass_carp', 'tilapia'] as const;
  for (const zone of zones) {
    for (const species of fish) {
      const calm = biteSignalWeights({ zone, fish: species, drift: false, antiDrift: false });
      if (calm.run !== 0) fail(`漂相 ${zone}/${species}`, '静水出现移漂权重');
      const total = BITE_SIGNAL_POOL.reduce((sum, signal) => sum + calm[signal], 0);
      if (total <= 0) fail(`漂相 ${zone}/${species}`, '权重全零——有口也选不出漂相');
      const wet = biteSignalWeights({ zone, fish: species, drift: true, antiDrift: false });
      if (wet.run <= 0) fail(`漂相 ${zone}/${species}`, '走水没有移漂权重');
    }
  }
  if (!(liftWindowOf('nod') < liftWindowOf('sink'))) fail('漂相窗口', '顿口窗口不比黑漂短');
  notes.push('漂相不变量：静水无移漂、每个局势权重非零、走水必有移漂、顿口窗口 < 黑漂窗口');
}

// ---------------------------------------------------------------------------
// 5. ASCII 剖面抽检（读图审查：数字全部来自模型）
// ---------------------------------------------------------------------------

const ROWS = 26; // 剖面行数（每行约 0.1m @ depth=2.2 基准按实际水深缩放）

function renderProfile(input: TaidiaoInput, depth: number, label: string): string {
  const result = calculateRigState(input);
  if (!result.ok) return `${label}: 参数不合法`;
  const surfaceY = depth;
  const layout = fishingLayout(input, result.state, { surfaceY, depth });
  const parts: [string, number][] = [
    ['浮漂', layout.float[1]],
    ['铅坠', layout.sinker[1]],
    ['8字环', layout.swivel[1]],
    ['上钩', layout.upperHook[1]],
    ['下钩', layout.lowerHook[1]],
  ];
  const marks = str(result.state.zone, '');
  const lines: string[] = [`### ${label}`, '', `调目 t0=${input.t0} / t=${input.t} / w=${input.w}，钓目 d=${input.d}，水深 ${depth}m → 分区 **${marks}**`, '', '```'];
  const rowH = depth / ROWS;
  const cell = (y: number): string => {
    const row = Math.round((surfaceY - y) / rowH);
    if (row < 0 || row >= ROWS) return ' '.repeat(30);
    return ' '.repeat(row * 31) + '│';
  };
  for (let row = 0; row < ROWS; row++) {
    const y = surfaceY - row * rowH;
    let line = row === 0 ? '~'.repeat(30) + ' ← 水面' : row === ROWS - 1 ? '_'.repeat(30) + ' ← 水底' : '';
    for (const [name, partY] of parts) {
      if (Math.abs(partY - y) < rowH / 2) line = line.padEnd(30, ' ') + `  ${name}`;
    }
    lines.push(line);
  }
  // 部件纵序表（图读不清时的数字真相）。
  for (const [name, y] of parts) lines.push(`${name}：y=${y.toFixed(3)}（离底 ${(y).toFixed(3)}m）`);
  lines.push('```', '');
  return lines.join('\n');
}

function auditProfiles(): string {
  return [
    renderProfile({ t0: 4, t: 2, w: 1, d: 2 }, 2.2, '调四钓二（不灵不钝）'),
    renderProfile({ t0: 5, t: 4, w: 1, d: 2.5 }, 2.2, '调五钓二点五（灵区）'),
    renderProfile({ t0: 6, t: 4, w: 1, d: 6 }, 2.2, '钓目拉满（铅坠触底走铅）'),
    renderProfile({ t0: 4, t: 2, w: 1, d: 2 }, 0.8, '浅水调四钓二（兜底路径）'),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 6. evals 汇总
// ---------------------------------------------------------------------------

function auditEvals(): { passed: number; total: number; lines: string[] } {
  const lines: string[] = [];
  let passed = 0;
  let total = 0;
  for (const [id, check] of Object.entries(CHECKS)) {
    total += 1;
    try {
      const result = check();
      if (result.pass) passed += 1;
      lines.push(`| #${id} | ${result.pass ? 'PASS' : 'FAIL'} | ${result.detail} |`);
    } catch (error) {
      lines.push(`| #${id} | ERROR | ${error instanceof Error ? error.message : String(error)} |`);
    }
  }
  return { passed, total, lines };
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const layoutChecks = auditLayoutInvariants();
const viewChecks = auditViewMatchesWorld();
auditActionsLand();
auditSignalInvariants();
const evalsResult = auditEvals();

const report = [
  '# 钓场场景审计报告（audit-scene）',
  '',
  '> 生成：scripts/audit-scene.ts · 确定性（无 Date.now / Math.random），重跑逐字节一致',
  '',
  '## 摘要',
  '',
  `- 布局网格：${layoutChecks} 个布局`,
  `- 图与行为一致：${viewChecks} 个实体位置`,
  `- 动作落地：${FISHING_ACTIONS.length} 个动作（2 个合法不动）`,
  `- 漂相不变量：分区 × 鱼种 × 走水 全覆盖`,
  `- evals：${evalsResult.passed}/${evalsResult.total}`,
  `- **违例：${violations.length}**`,
  '',
  '## 违例清单',
  '',
  ...(violations.length === 0 ? ['（空）——没有任何部件穿过对方、没有部件离开它该在的位置。'] : violations.map((item) => `- \`${item.where}\`：${item.what}`)),
  '',
  '## 检查笔记',
  '',
  ...notes.map((note) => `- ${note}`),
  '',
  '## evals 明细',
  '',
  '| # | 结果 | 实测 |',
  '| --- | --- | --- |',
  ...evalsResult.lines,
  '',
  '## ASCII 剖面抽检（读图审查）',
  '',
  auditProfiles(),
  '## 简化声明（What is simplified）',
  '',
  '- 剖面是 2D 垂直切面：线组画在 x=0 一列，不走水时不画横向位移；走水的斜拉由漂相 / 姿态文案表达。',
  '- 钓组布局是"状态 → 位置"的纯函数，不积分动力学：没有线的质量、没有波的扰动。',
  '- 咬钩 / 中鱼概率是分区查表 × 倍率（装备 / 情况 / 水温 / 漂相权重），不是逐鱼个体行为。',
  '- 提竿窗口按漂相取常数（1.1 ~ 1.9s），不是真实提竿时机分布。',
  '',
].join('\n');

const reportPath = new URL('../evals/audit-report.md', import.meta.url);
writeFileSync(reportPath, report, 'utf-8');

console.log(report.split('\n').slice(0, 20).join('\n'));
console.log('…');
console.log(`报告已写入 ${reportPath.pathname}`);
if (violations.length > 0 || evalsResult.passed !== evalsResult.total) {
  console.log(`审计未通过：违例 ${violations.length}，evals ${evalsResult.passed}/${evalsResult.total}`);
  process.exit(1);
}
console.log('审计通过：布局 / 图行为一致 / 动作落地 / 漂相 / evals 全部干净。');
