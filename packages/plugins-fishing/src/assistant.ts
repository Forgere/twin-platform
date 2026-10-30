import type { FishingActionId } from './actionSpace';
import type { PondConditions } from './conditions';
import { fishById, loadoutChecks, lineStrengthKg, recommendedLoadout, type Loadout } from './loadout';
import type { FishingIntent, FishingState } from './state';

/**
 * 钓鱼助手（assistant）—— 垂钓过程中随时可问的"规则解答"。
 *
 * 与开钓向导的分工：向导把人从 0 带到第一竿；助手陪着钓，遇到情况随时问。
 * 用户表达情况有两条路，都落到同一个封闭的 `SituationId`：
 * - 点选（优先，零负担）：`SITUATIONS` 直接做成按钮；
 * - 说话 / 打字（情况复杂时）：`matchSituation()` 用关键词归类，归不了类就
 *   坦白"没听懂"，让用户点选——不猜。
 *
 * 助手的回答 = **规则**（本文件：为什么、怎么做、一个可一键执行的动作）
 *            + **判断者**（ruleJudge / Jev，走 decision-core，带置信度与校准）。
 * 两者并列展示；判断者只认识 intent，所以用 `stateForSituation()` 把
 * "用户说的情况"翻译成判断者能读的状态。
 */

export type SituationId =
  | 'no_bite'
  | 'bite_no_catch'
  | 'drift'
  | 'small_fish'
  | 'line_break'
  | 'float_unclear'
  | 'cold'
  | 'how_bottom'
  | 'when_strike';

export interface SituationDef {
  readonly id: SituationId;
  readonly label: string;
  readonly emoji: string;
  /** 'problem'：钓况问题（会给动作）；'howto'：规则问答（只讲道理）。 */
  readonly kind: 'problem' | 'howto';
  /** 语音 / 文字归类的关键词（命中越多越可信）。 */
  readonly keywords: readonly string[];
}

export const SITUATIONS: readonly SituationDef[] = [
  { id: 'no_bite', label: '半天没口', emoji: '😶', kind: 'problem', keywords: ['没口', '不动', '没鱼', '没反应', '不吃', '空等', '一动不动', '没动静'] },
  { id: 'bite_no_catch', label: '有口打不中', emoji: '😤', kind: 'problem', keywords: ['打不中', '空竿', '提竿没', '中不了', '没中', '有口', '抽空', '打空'] },
  { id: 'drift', label: '走水漂跑', emoji: '🌊', kind: 'problem', keywords: ['走水', '漂跑', '漂走', '水流', '风大', '起风', '漂歪', '移漂'] },
  { id: 'small_fish', label: '小鱼闹窝', emoji: '🐟', kind: 'problem', keywords: ['小鱼', '闹窝', '偷饵', '饵没了', '乱动', '碎口', '点个不停'] },
  { id: 'line_break', label: '切线跑鱼', emoji: '💥', kind: 'problem', keywords: ['切线', '断线', '跑鱼', '线断', '脱钩', '拉断', '跑了'] },
  { id: 'float_unclear', label: '看不懂漂', emoji: '🤔', kind: 'howto', keywords: ['看不懂', '漂相', '什么口', '顿口', '黑漂', '送漂', '漂怎么'] },
  { id: 'cold', label: '降温变天', emoji: '🥶', kind: 'problem', keywords: ['降温', '变天', '冷', '下雨', '水温', '天冷', '气压'] },
  { id: 'how_bottom', label: '怎么找底', emoji: '📏', kind: 'howto', keywords: ['找底', '到底', '钓底', '水深', '多深', '调漂'] },
  { id: 'when_strike', label: '何时提竿', emoji: '🎣', kind: 'howto', keywords: ['提竿', '什么时候', '扬竿', '抽竿', '时机'] },
];

export function situationById(id: string): SituationDef | undefined {
  return SITUATIONS.find((item) => item.id === id);
}

export interface SituationMatch {
  readonly situation?: SituationDef;
  /** 0~1：命中关键词的相对强度。0 表示没听懂。 */
  readonly confidence: number;
  /** 命中的关键词（给用户看"我是怎么理解你的"）。 */
  readonly hits: readonly string[];
}

/**
 * 语音 / 文字 → 情况。关键词归类，纯函数。
 *
 * 没命中就返回空，UI 据此请用户点选；平分时取列表里靠前的（问题类排在前面，
 * 比规则问答更紧急）。
 */
export function matchSituation(text: string): SituationMatch {
  const normalized = text.replace(/\s+/g, '');
  if (normalized === '') return { confidence: 0, hits: [] };
  let best: { situation: SituationDef; hits: string[] } | undefined;
  for (const situation of SITUATIONS) {
    const hits = situation.keywords.filter((keyword) => normalized.includes(keyword));
    if (hits.length > 0 && (!best || hits.length > best.hits.length)) best = { situation, hits };
  }
  if (!best) return { confidence: 0, hits: [] };
  return { situation: best.situation, confidence: Math.min(1, 0.5 + 0.25 * best.hits.length), hits: best.hits };
}

const INTENT_OF: Partial<Record<SituationId, FishingIntent>> = {
  no_bite: 'no_bite',
  bite_no_catch: 'bite_no_catch',
  small_fish: 'bite_no_catch',
  cold: 'no_bite',
};

/**
 * 用户说的情况 → 判断者能读的状态。用户亲口说的比统计出来的更可信
 * （尤其开钓头几竿、统计还没攒够时），所以直接覆盖 intent / drift。
 */
export function stateForSituation(state: FishingState, situation: SituationId): FishingState {
  if (situation === 'drift') return { ...state, drift: true, intent: 'drift' };
  const intent = INTENT_OF[situation];
  return intent ? { ...state, intent } : state;
}

export interface AdviceAction {
  readonly action: FishingActionId;
  readonly params: Readonly<Record<string, number | string>>;
  /** 按钮上的字。 */
  readonly label: string;
}

export interface Advice {
  readonly situation: SituationId;
  readonly title: string;
  /** 结合"你现在的钓组 / 装备 / 情况"的诊断，一条一句。 */
  readonly diagnosis: readonly string[];
  /** 通用规则（讲道理，新手能学到东西）。 */
  readonly rule: string;
  /** 建议先做的一步（可一键执行）；规则问答类没有。 */
  readonly action?: AdviceAction;
}

const ZONE_TEXT: Readonly<Record<string, string>> = {
  off_bottom: '双饵离底',
  sensitive: '偏灵',
  neutral: '不灵不钝',
  blunt: '偏钝',
  sinker_on_bottom: '铅坠到底（最钝）',
};

/**
 * 规则解答。纯函数：输入当前状态（钓组 / 装备 / 情况），输出诊断 + 规则 + 一步动作。
 */
export function adviseSituation(
  situation: SituationId,
  state: FishingState,
  loadout: Loadout,
  conditions: PondConditions,
): Advice {
  const fish = fishById(loadout.targetFish) ?? fishById('crucian')!;
  const zone = state.rig.zone;
  const zoneText = '钓组现在' + (ZONE_TEXT[zone] ?? zone) + '（钓 ' + state.rig.d + ' 目，调 ' + state.rig.t + ' 目）';
  const obs = state.observation;
  const gearIssues = loadoutChecks(loadout).filter((check) => check.level !== 'ok');

  switch (situation) {
    case 'no_bite': {
      const diagnosis = [zoneText];
      if (zone === 'off_bottom') {
        diagnosis.push('双饵都没到底——底钓的鱼在底上找食，饵悬着它看不见。');
        return {
          situation,
          title: '没口：饵没到底',
          diagnosis,
          rule: '先确认饵在鱼的嘴边：底钓至少要让下饵到底。上推浮漂（钓目加大）直到下饵触底。',
          action: { action: 'ADJUST_FLOAT', params: { direction: 'blunt', steps: 2 }, label: '上推浮漂 2 目（找底）' },
        };
      }
      const baitLove = fish.baitAffinity[loadout.bait];
      if (baitLove < 1) {
        diagnosis.push(fish.label + '对现在的饵兴趣一般。');
        return {
          situation,
          title: '没口：饵不对' + fish.label + '的胃口',
          diagnosis,
          rule: '到底了还没口，先怀疑饵和窝：换目标鱼爱吃的饵，比反复调漂有效。',
          action: { action: 'CHANGE_BAIT', params: { target: 'flavor' }, label: '换成' + fish.label + '爱吃的饵' },
        };
      }
      if (conditions.waterTemperature < 12) diagnosis.push('水温 ' + conditions.waterTemperature + '℃，鱼不爱动，口本来就少。');
      diagnosis.push('已抛 ' + (obs.bites + obs.emptyHooks) + ' 次有效口记录；窝可能散了。');
      return {
        situation,
        title: '没口：先把鱼留在窝里',
        diagnosis,
        rule: '饵到底、饵也对，还没口：多半是窝里没鱼。补一次窝，再观察 3~5 竿，不要同时改两样东西。',
        action: { action: 'REFILL_NEST', params: { amount: 'normal' }, label: '补一次窝' },
      };
    }

    case 'bite_no_catch': {
      const diagnosis = [zoneText, '有口 ' + obs.bites + ' 次，中鱼 ' + obs.catches + ' 次，空竿 ' + obs.emptyHooks + ' 次。'];
      if (loadout.hookSize > fish.hookRange[1]) {
        diagnosis.push(loadout.hookSize + ' 号钩对' + fish.label + '偏大，吞不进。');
        return {
          situation,
          title: '有口不中：钩太大',
          diagnosis,
          rule: '漂动了却总打空，先看钩是不是比鱼嘴大——鱼只能啄饵，吞不进钩。',
          action: { action: 'REBUILD_RIG', params: { target: 'hook' }, label: '换' + recommendedLoadout(fish.id).hookSize + ' 号钩' },
        };
      }
      if (zone === 'sensitive' || zone === 'neutral' || zone === 'off_bottom') {
        diagnosis.push('钓得偏灵：鱼还没把饵吸进嘴，漂就先动了，提早了。');
        return {
          situation,
          title: '有口不中：太灵，调钝一点',
          diagnosis,
          rule: '灵 = 信号早但假口多；钝 = 信号晚但口口实。空竿多就往钝调：上推浮漂 1 目。',
          action: { action: 'ADJUST_FLOAT', params: { direction: 'blunt', steps: 1 }, label: '上推浮漂 1 目（调钝）' },
        };
      }
      diagnosis.push('钓组已经偏钝，还打不中，多半是饵太硬 / 太大，鱼吸不进。');
      return {
        situation,
        title: '有口不中：饵的状态不对',
        diagnosis,
        rule: '钝了还空竿，就别再调钝——换软一点、小一点的饵，让鱼一吸就进嘴。',
        action: { action: 'CHANGE_BAIT', params: { target: 'state' }, label: '换饵（软 / 小）' },
      };
    }

    case 'drift': {
      const diagnosis = [zoneText];
      if (conditions.antiDrift) {
        diagnosis.push('已经加过铅了，水还是拉漂。');
        return {
          situation,
          title: '走水：加铅也压不住',
          diagnosis,
          rule: '加铅后仍走漂，说明这里水流太急：换到回水湾或下风口，比继续加重更好。',
          action: { action: 'CHANGE_SPOT', params: { urgency: 'now' }, label: '换钓位' },
        };
      }
      diagnosis.push('走水时主线被拉斜，漂的信号是假的；饵也会被拖着走。');
      return {
        situation,
        title: '走水：加铅压住',
        diagnosis,
        rule: '走水先稳住钓组：加铅让线组"钉"在底上（钓组会变钝，这是代价），稳了再谈灵钝。',
        action: { action: 'ADD_LEAD', params: { amount: 'medium' }, label: '加铅抗流' },
      };
    }

    case 'small_fish': {
      const diagnosis = [zoneText, '口多空竿多、饵很快没了——典型的小鱼闹窝。'];
      if (loadout.hookSize <= fish.hookRange[0] + 1 && fish.hookRange[1] > loadout.hookSize) {
        diagnosis.push('钩小，小鱼也吞得进。');
        return {
          situation,
          title: '小鱼闹窝：加大钩、调钝',
          diagnosis,
          rule: '小鱼嘴小、力气小：换大一号钩、饵搓大一点、调钝，把小鱼的碎口过滤掉。',
          action: { action: 'ADJUST_FLOAT', params: { direction: 'blunt', steps: 1 }, label: '上推浮漂 1 目（调钝）' },
        };
      }
      return {
        situation,
        title: '小鱼闹窝：换个钓位',
        diagnosis,
        rule: '钩已经不小了还闹，说明窝里全是小鱼：换钓位，别在这里跟它们耗。',
        action: { action: 'CHANGE_SPOT', params: { urgency: 'now' }, label: '换钓位' },
      };
    }

    case 'line_break': {
      const subKg = Math.round(lineStrengthKg(loadout.subLine) * 10) / 10;
      const diagnosis = [
        '子线 ' + loadout.subLine + ' 号（约 ' + subKg + 'kg），主线 ' + loadout.mainLine + ' 号；' + fish.label + '常见 ' + fish.weightKg[0] + '–' + fish.weightKg[1] + 'kg。',
      ];
      if (loadout.subLine >= loadout.mainLine) diagnosis.push('子线不比主线细：断在主线上，整副线组都丢了。');
      const recommended = recommendedLoadout(fish.id);
      return {
        situation,
        title: '切线：线扛不住这条鱼',
        diagnosis,
        rule: '中鱼后别硬拔：竿要立起来卸力。子线号数要跟目标鱼匹配，且永远比主线细一档以上。',
        action: {
          action: 'REBUILD_RIG',
          params: { target: 'line' },
          label: '换线（主 ' + recommended.mainLine + ' / 子 ' + recommended.subLine + '）',
        },
      };
    }

    case 'cold': {
      const diagnosis = [zoneText, '水温 ' + conditions.waterTemperature + '℃。'];
      return {
        situation,
        title: '降温：鱼口变轻，调灵一点',
        diagnosis,
        rule: '天冷鱼吃口轻、动作小：下推浮漂 1 目调灵，饵换小换软，别指望黑漂。',
        action: { action: 'ADJUST_FLOAT', params: { direction: 'sensitive', steps: 1 }, label: '下推浮漂 1 目（调灵）' },
      };
    }

    case 'float_unclear':
      return {
        situation,
        title: '看漂：哪些是口',
        diagnosis: [zoneText, ...gearIssues.slice(0, 1).map((check) => '装备提示：' + check.message)],
        rule:
          '顿口：漂有力地往下一顿 1 目左右——最标准的口，立刻提竿。送漂：漂往上顶——鱼把饵吸起来了，顶到最高点提竿。' +
          '黑漂：整支没入——鲤鱼常见，稳稳提竿。小幅乱点、来回晃：多是小鱼碰线或水流，不要提。',
      };

    case 'how_bottom':
      return {
        situation,
        title: '找底：让饵刚好到底',
        diagnosis: [zoneText],
        rule:
          '双钩挂饵后，把漂往上推一点抛一竿，看漂露出几目：露出比调目多，说明饵已经躺底；' +
          '露出少了，说明饵还悬着。反复微调，直到露出目数 = 你要的钓目。',
      };

    case 'when_strike':
      return {
        situation,
        title: '提竿时机',
        diagnosis: [zoneText],
        rule:
          '只在"干净"的信号上提：顿 1 目以上、上顶、黑漂。提竿用手腕抖一下即可，不要大臂抡。' +
          (zone === 'sensitive' ? '你现在偏灵，信号会很多，等顿得有力再提。' : zone === 'blunt' ? '你现在偏钝，信号少但实，见动作就提。' : ''),
      };
  }
}
