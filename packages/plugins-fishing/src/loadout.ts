import type { RigZone } from './fishingCore';
import { num, str } from './values';

/**
 * 目标鱼 + 装备（loadout）—— 开钓前的两个决定，纯数据 + 纯函数。
 *
 * 回答三个问题：
 * 1. 钓什么鱼、这种鱼要什么（`TARGET_FISH`）；
 * 2. 这套装备配不配这条鱼（`loadoutChecks()`：人话的警告 / 错误）；
 * 3. 配得不好会怎样（`loadoutEffects()`：给 FishSim 的咬钩 / 中鱼 / 断线倍率）。
 *
 * 数值是"台钓常识的量级"，不是实验室数据：鲫鱼嘴小、钩大就吞不进；鲤鱼劲大、
 * 子线细就切线；子线必须比主线细（断也只断子线，不丢整副线组）。
 * 这些常识正是新手最容易踩的坑，也是向导要替他做的决定。
 *
 * 写进世界的形态是 rig 实体上的**扁平标量 attrs**（见 `LOADOUT_ATTRS`），
 * 老场景没有这些 attrs 时 `loadoutFromAttrs()` 回退到默认（鲫鱼 + 通用鲫组）。
 */

export type FishId = 'crucian' | 'carp' | 'grass_carp' | 'tilapia';
export type BaitId = 'worm' | 'grain' | 'commercial' | 'corn';

export interface FishProfile {
  readonly id: FishId;
  readonly label: string;
  /** 常见个体重（kg），决定拉力。 */
  readonly weightKg: readonly [number, number];
  /** 合适的钩号区间（伊势尼 / 袖钩号数）。 */
  readonly hookRange: readonly [number, number];
  /** 建议子线号区间。 */
  readonly subLineRange: readonly [number, number];
  /** 各饵的吸引力（1 = 正常，>1 更爱吃，<1 不爱吃）。 */
  readonly baitAffinity: Readonly<Record<BaitId, number>>;
  /** 灵钝偏好：同样的分区，不同鱼吃口不一样（鲫鱼口轻偏灵、鲤鱼偏钝稳）。 */
  readonly zoneAffinity: Readonly<Record<RigZone, number>>;
  /** 推荐调钓预设 id（向导第一个推荐）。 */
  readonly presetId: string;
  /** 一句话鱼情，给向导卡片用。 */
  readonly note: string;
  readonly emoji: string;
}

export const TARGET_FISH: readonly FishProfile[] = [
  {
    id: 'crucian',
    label: '鲫鱼',
    weightKg: [0.1, 0.5],
    hookRange: [1, 3],
    subLineRange: [0.4, 0.8],
    baitAffinity: { worm: 1.2, grain: 1, commercial: 1.15, corn: 0.5 },
    zoneAffinity: { off_bottom: 0.8, sensitive: 1.2, neutral: 1.1, blunt: 0.75, sinker_on_bottom: 0.6 },
    presetId: 'diao4-diao2',
    note: '嘴小口轻、警惕性高：小钩细线、调得偏灵，才看得到口。',
    emoji: '🐟',
  },
  {
    id: 'carp',
    label: '鲤鱼',
    weightKg: [1, 5],
    hookRange: [4, 6],
    subLineRange: [1, 1.5],
    baitAffinity: { worm: 0.9, grain: 1.2, commercial: 1.1, corn: 1.25 },
    zoneAffinity: { off_bottom: 0.6, sensitive: 0.85, neutral: 1.1, blunt: 1.2, sinker_on_bottom: 0.9 },
    presetId: 'ping-shui-diao2',
    note: '底层拱食、吃口稳但劲大：钩要结实、线要够粗，调钝一点等黑漂。',
    emoji: '🐠',
  },
  {
    id: 'grass_carp',
    label: '草鱼',
    weightKg: [2, 8],
    hookRange: [5, 7],
    subLineRange: [1.5, 2.5],
    baitAffinity: { worm: 0.6, grain: 1, commercial: 0.85, corn: 1.3 },
    zoneAffinity: { off_bottom: 0.9, sensitive: 0.9, neutral: 1.1, blunt: 1.1, sinker_on_bottom: 0.8 },
    presetId: 'diao5-diao3',
    note: '个大劲足、爱吃玉米和嫩草：细线必切，中鱼后要长竿卸力。',
    emoji: '🐡',
  },
  {
    id: 'tilapia',
    label: '罗非',
    weightKg: [0.3, 1.2],
    hookRange: [3, 5],
    subLineRange: [0.8, 1.2],
    baitAffinity: { worm: 1.3, grain: 0.8, commercial: 1.1, corn: 0.6 },
    zoneAffinity: { off_bottom: 1.1, sensitive: 1.1, neutral: 1, blunt: 0.85, sinker_on_bottom: 0.7 },
    presetId: 'diao3-diao1',
    note: '贪食、常在离底一点的水层抢口：荤饵最好，口多但偷饵也多。',
    emoji: '🐟',
  },
];

export interface BaitProfile {
  readonly id: BaitId;
  readonly label: string;
  /** 相对单饵压目：同一支漂上，这种饵挂一颗大约压几目（以谷物 = 1 为基准）。 */
  readonly relativeWeight: number;
  readonly note: string;
}

export const BAITS: readonly BaitProfile[] = [
  { id: 'worm', label: '蚯蚓', relativeWeight: 0.9, note: '万能荤饵，杂鱼也爱闹' },
  { id: 'grain', label: '谷物颗粒', relativeWeight: 1, note: '素饵，鲤草都吃，耐泡' },
  { id: 'commercial', label: '商品饵（腥香）', relativeWeight: 1.1, note: '雾化诱鱼快，要常补' },
  { id: 'corn', label: '玉米粒', relativeWeight: 1.3, note: '大鱼饵，小鱼吃不进' },
];

/** 一套开钓装备。号数都是国内台钓常用的"号"。 */
export interface Loadout {
  readonly targetFish: FishId;
  /** 竿长（米）。 */
  readonly rodLength: number;
  /** 主线号。 */
  readonly mainLine: number;
  /** 子线号。 */
  readonly subLine: number;
  /** 钩号。 */
  readonly hookSize: number;
  /** 浮漂吃铅量（克）。 */
  readonly floatSize: number;
  readonly bait: BaitId;
}

/** 可选项（向导的下拉 / 分段按钮直接用它）。 */
export const GEAR_OPTIONS = {
  rodLength: [3.6, 4.5, 5.4, 6.3],
  mainLine: [0.8, 1, 1.5, 2, 3, 4],
  subLine: [0.4, 0.6, 0.8, 1, 1.5, 2, 2.5],
  hookSize: [1, 2, 3, 4, 5, 6, 7],
  floatSize: [1, 1.5, 2, 3, 4],
} as const;

/** 写进 rig 实体的 attrs 键（扁平标量，快照 / 回放 / 导出都不用特殊处理）。 */
export const LOADOUT_ATTRS = ['targetFish', 'rodLength', 'mainLine', 'subLine', 'hookSize', 'floatSize', 'bait'] as const;

export function fishById(id: string): FishProfile | undefined {
  return TARGET_FISH.find((fish) => fish.id === id);
}

export function baitById(id: string): BaitProfile | undefined {
  return BAITS.find((bait) => bait.id === id);
}

/** 这条鱼的推荐装备：钩、子线取区间中值附近的档位，主线比子线粗一档以上。 */
export function recommendedLoadout(fishId: FishId): Loadout {
  const fish = fishById(fishId) ?? TARGET_FISH[0]!;
  const hookSize = nearest(GEAR_OPTIONS.hookSize, (fish.hookRange[0] + fish.hookRange[1]) / 2);
  const subLine = nearest(GEAR_OPTIONS.subLine, (fish.subLineRange[0] + fish.subLineRange[1]) / 2);
  const mainLine = GEAR_OPTIONS.mainLine.find((size) => size >= subLine * 1.6) ?? GEAR_OPTIONS.mainLine.at(-1)!;
  const big = fish.weightKg[1] >= 3;
  const bait = (Object.entries(fish.baitAffinity) as [BaitId, number][]).reduce((best, item) => (item[1] > best[1] ? item : best))[0];
  return {
    targetFish: fish.id,
    rodLength: big ? 5.4 : 4.5,
    mainLine,
    subLine,
    hookSize,
    floatSize: big ? 3 : 1.5,
    bait,
  };
}

export const DEFAULT_LOADOUT: Loadout = recommendedLoadout('crucian');

/** 从 rig attrs 读装备；缺的逐项回退默认，老场景不会崩。 */
export function loadoutFromAttrs(attrs: Readonly<Record<string, unknown>> | undefined): Loadout {
  const source = attrs ?? {};
  const fishRaw = str(source.targetFish, DEFAULT_LOADOUT.targetFish);
  const targetFish: FishId = fishById(fishRaw)?.id ?? DEFAULT_LOADOUT.targetFish;
  const base = recommendedLoadout(targetFish);
  const baitRaw = str(source.bait, base.bait);
  return {
    targetFish,
    rodLength: positive(source.rodLength, base.rodLength),
    mainLine: positive(source.mainLine, base.mainLine),
    subLine: positive(source.subLine, base.subLine),
    hookSize: positive(source.hookSize, base.hookSize),
    floatSize: positive(source.floatSize, base.floatSize),
    bait: baitById(baitRaw)?.id ?? base.bait,
  };
}

/** 装备 → attrs 键值对（写世界用）。 */
export function loadoutToAttrs(loadout: Loadout): Record<(typeof LOADOUT_ATTRS)[number], number | string> {
  return {
    targetFish: loadout.targetFish,
    rodLength: loadout.rodLength,
    mainLine: loadout.mainLine,
    subLine: loadout.subLine,
    hookSize: loadout.hookSize,
    floatSize: loadout.floatSize,
    bait: loadout.bait,
  };
}

// ---------------------------------------------------------------------------
// 配伍检查：人话，给向导用
// ---------------------------------------------------------------------------

export type LoadoutCheckLevel = 'ok' | 'warn' | 'error';

export interface LoadoutCheck {
  readonly level: LoadoutCheckLevel;
  readonly part: 'hook' | 'line' | 'rod' | 'float' | 'bait';
  readonly message: string;
}

/**
 * 线的拉力（kg）：台钓尼龙线的经验量级，1 号约 2.2kg，近似线性。
 * 只用来比"够不够"，不用来算真实断点。
 */
export function lineStrengthKg(size: number): number {
  return Math.max(0.3, size * 2.2);
}

/**
 * 装备 vs 目标鱼的配伍检查。`error` 表示"这样钓大概率出事"（向导据此拦一下），
 * `warn` 是"能钓但吃亏"，`ok` 是给新手的正反馈（也说明为什么配得对）。
 */
export function loadoutChecks(loadout: Loadout): LoadoutCheck[] {
  const fish = fishById(loadout.targetFish) ?? TARGET_FISH[0]!;
  const checks: LoadoutCheck[] = [];
  const [hookMin, hookMax] = fish.hookRange;
  const pullKg = fish.weightKg[1];

  if (loadout.subLine >= loadout.mainLine) {
    checks.push({
      level: 'error',
      part: 'line',
      message: `子线 ${loadout.subLine} 号不细于主线 ${loadout.mainLine} 号：切线时会断在主线上，漂和铅一起丢。子线必须比主线细。`,
    });
  }

  if (loadout.hookSize > hookMax + 1) {
    checks.push({ level: 'error', part: 'hook', message: `${loadout.hookSize} 号钩对${fish.label}太大，它根本吞不进，只会碰饵不进口。` });
  } else if (loadout.hookSize > hookMax) {
    checks.push({ level: 'warn', part: 'hook', message: `${loadout.hookSize} 号钩偏大，${fish.label}进口率会下降（建议 ${hookMin}–${hookMax} 号）。` });
  } else if (loadout.hookSize < hookMin - 1) {
    checks.push({ level: 'error', part: 'hook', message: `${loadout.hookSize} 号钩对${fish.label}太小：挂不住，中鱼后容易脱钩或拉直。` });
  } else if (loadout.hookSize < hookMin) {
    checks.push({ level: 'warn', part: 'hook', message: `${loadout.hookSize} 号钩偏小，${fish.label}容易脱钩（建议 ${hookMin}–${hookMax} 号）。` });
  } else {
    checks.push({ level: 'ok', part: 'hook', message: `${loadout.hookSize} 号钩正合${fish.label}的嘴。` });
  }

  const subKg = lineStrengthKg(loadout.subLine);
  if (subKg < pullKg * 0.4) {
    checks.push({ level: 'error', part: 'line', message: `子线 ${loadout.subLine} 号（约 ${round1(subKg)}kg）远扛不住 ${pullKg}kg 的${fish.label}，中了也会切线。` });
  } else if (loadout.subLine < fish.subLineRange[0]) {
    checks.push({ level: 'warn', part: 'line', message: `子线 ${loadout.subLine} 号偏细：口会多一点，但大个体容易切线。` });
  } else if (loadout.subLine > fish.subLineRange[1] + 0.5) {
    checks.push({ level: 'warn', part: 'line', message: `子线 ${loadout.subLine} 号偏粗：${fish.label}会警觉，口变少。` });
  } else if (loadout.subLine < loadout.mainLine) {
    checks.push({ level: 'ok', part: 'line', message: `主线 ${loadout.mainLine} / 子线 ${loadout.subLine}：粗细搭配合理。` });
  }

  if (fish.weightKg[1] >= 3 && loadout.rodLength < 4.5) {
    checks.push({ level: 'warn', part: 'rod', message: `${loadout.rodLength}m 竿遛${fish.label}卸力不够，建议 4.5m 以上。` });
  }

  if (fish.weightKg[1] <= 0.5 && loadout.floatSize >= 3) {
    checks.push({ level: 'warn', part: 'float', message: `${loadout.floatSize}g 大漂对${fish.label}的轻口反应迟钝，看不出口。` });
  } else if (fish.weightKg[1] >= 3 && loadout.floatSize <= 1) {
    checks.push({ level: 'warn', part: 'float', message: `${loadout.floatSize}g 小漂带不动大钩大饵，抛竿不稳。` });
  }

  const affinity = fish.baitAffinity[loadout.bait];
  const bait = baitById(loadout.bait);
  if (affinity < 0.7) {
    checks.push({ level: 'warn', part: 'bait', message: `${fish.label}不太吃${bait?.label ?? loadout.bait}，口会很少。` });
  } else if (affinity >= 1.15) {
    checks.push({ level: 'ok', part: 'bait', message: `${bait?.label ?? loadout.bait}是${fish.label}爱吃的饵。` });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// 仿真倍率：给 FishSim 用
// ---------------------------------------------------------------------------

export interface LoadoutEffects {
  /** 咬钩率倍率（饵、钩大小、线粗细的综合）。 */
  readonly biteMul: number;
  /** 中鱼率倍率（钩合不合口、漂灵不灵）。 */
  readonly hookMul: number;
  /** 中鱼后切线的概率（0~1）。 */
  readonly breakChance: number;
  /** 各灵钝分区的鱼种偏好倍率（乘在 biteProbability 上）。 */
  readonly zoneBite: Readonly<Record<RigZone, number>>;
}

/**
 * 装备对鱼口的影响。纯函数、无随机——随机仍由 FishSim 的 ctx.rng 决定，
 * 这里只给倍率，保证回放一致。
 */
export function loadoutEffects(loadout: Loadout): LoadoutEffects {
  const fish = fishById(loadout.targetFish) ?? TARGET_FISH[0]!;
  const [hookMin, hookMax] = fish.hookRange;

  let biteMul = fish.baitAffinity[loadout.bait];
  let hookMul = 1;

  // 钩大：进口难（咬少、中得也少）；钩小：脱钩多。
  if (loadout.hookSize > hookMax) {
    const over = loadout.hookSize - hookMax;
    biteMul *= Math.max(0.3, 1 - 0.25 * over);
    hookMul *= Math.max(0.4, 1 - 0.2 * over);
  } else if (loadout.hookSize < hookMin) {
    hookMul *= Math.max(0.4, 1 - 0.22 * (hookMin - loadout.hookSize));
  }

  // 子线粗：警觉，口少；细：口略多。
  const [subMin, subMax] = fish.subLineRange;
  if (loadout.subLine > subMax) biteMul *= Math.max(0.5, 1 - 0.2 * (loadout.subLine - subMax));
  else if (loadout.subLine < subMin) biteMul *= 1.08;

  // 漂与鱼的匹配：大漂钓小鱼看不清口，中鱼率降；小漂钓大鱼抛投不稳。
  if (fish.weightKg[1] <= 0.5 && loadout.floatSize >= 3) hookMul *= 0.8;
  if (fish.weightKg[1] >= 3 && loadout.floatSize <= 1) biteMul *= 0.9;

  // 断线：子线拉力 vs 鱼的有效拉力（水阻 + 竿身弹性把瞬时冲击大约减半）；长竿卸力更多。
  // 子线比主线粗时照样会断（只是断在主线上，断得更惨）。
  const pullKg = ((fish.weightKg[0] + fish.weightKg[1]) / 2) * 0.5;
  const ratio = lineStrengthKg(Math.min(loadout.subLine, loadout.mainLine)) / pullKg;
  const rodRelief = Math.min(1.25, 0.8 + (loadout.rodLength - 3.6) * 0.15);
  const breakChance = clamp01(0.45 - 0.25 * ratio * rodRelief);

  return {
    biteMul: round3(biteMul),
    hookMul: round3(hookMul),
    breakChance: round3(breakChance),
    zoneBite: fish.zoneAffinity,
  };
}

// ---------------------------------------------------------------------------
// 模拟测量：没有真实漂的时候，按装备给一组"像真的"调目
// ---------------------------------------------------------------------------

export interface EstimatedMarks {
  readonly t0: number;
  readonly t: number;
  readonly w: number;
}

/**
 * 在数字钓场里"模拟"调漂测量：按装备估一组 t0 / t / w。
 *
 * 规则（量级正确即可）：漂越小，同样的钩饵压下去的目数越多；钩号越大越重。
 * 结果按半目取整——真实读漂也只读到半目。
 */
export function estimateMarks(loadout: Loadout, t0 = 7): EstimatedMarks {
  const floatScale = 2 / loadout.floatSize;
  const doubleHook = halfMark(Math.min(t0 - 0.5, Math.max(1, 0.35 * loadout.hookSize * floatScale + 1)));
  const bait = baitById(loadout.bait)?.relativeWeight ?? 1;
  const w = halfMark(Math.max(0.5, 0.25 * loadout.hookSize * bait * floatScale + 0.3));
  return { t0, t: t0 - doubleHook, w };
}

// ---------------------------------------------------------------------------

function nearest(options: readonly number[], value: number): number {
  return options.reduce((best, item) => (Math.abs(item - value) < Math.abs(best - value) ? item : best));
}

function positive(value: unknown, fallback: number): number {
  const parsed = num(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);
const round1 = (value: number): number => Math.round(value * 10) / 10;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const halfMark = (value: number): number => Math.round(value * 2) / 2;
