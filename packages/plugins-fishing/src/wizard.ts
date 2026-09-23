import { calculateRigState, type RigIssue, type RigState, type TaidiaoInput } from './fishingCore';
import { fishById, loadoutChecks, recommendedLoadout, type FishId, type Loadout } from './loadout';
import { presetById, TAIDIAO_PRESETS, type TaidiaoPreset } from './presets';

/**
 * 开钓向导 —— 从零开始的引导状态机（纯函数，无 UI）。
 *
 * 七步：
 *   choose_fish   选目标鱼（决定推荐装备、推荐调法、鱼对灵钝的偏好）
 *   choose_gear   配装备（竿 / 线 / 钩 / 漂 / 饵）；配伍 error 要用户明确坚持才放行
 *   measure_t0    半水不挂钩，读无钩调目
 *   measure_t     挂双钩，读带钩调目（必须 < t0）
 *   measure_w     单钩挂单饵，读单饵压目
 *   choose_preset 选一组调钓预设（本质是选目标钓目）
 *   find_bottom   上下推漂微调钓目，看灵钝分区落点，确认后写入钓组
 *
 * 每一步都复用 `calculateRigState()` 的校验——向导与引擎对"参数合法"的
 * 认知是同一份代码，不会出现"向导放行、引擎拒收"。
 */

export type WizardStep =
  | 'choose_fish'
  | 'choose_gear'
  | 'measure_t0'
  | 'measure_t'
  | 'measure_w'
  | 'choose_preset'
  | 'find_bottom'
  | 'done';

/** 步骤顺序（UI 画进度条、`back` 回退都按它）。 */
export const WIZARD_STEPS: readonly WizardStep[] = [
  'choose_fish',
  'choose_gear',
  'measure_t0',
  'measure_t',
  'measure_w',
  'choose_preset',
  'find_bottom',
  'done',
];

export interface WizardState {
  readonly step: WizardStep;
  /** 选好的装备（含目标鱼）。choose_fish 之后才有。 */
  readonly loadout?: Loadout;
  readonly t0?: number;
  readonly t?: number;
  readonly w?: number;
  /** 选中的预设 id（记录来源，不参与计算）。 */
  readonly presetId?: string;
  /** find_bottom 阶段的当前钓目。 */
  readonly d?: number;
}

export type WizardInput =
  | { readonly kind: 'fish'; readonly fishId: FishId }
  /** force：配伍有 error 时用户坚持要用（向导只拦一次，不替人做最终决定）。 */
  | { readonly kind: 'gear'; readonly loadout: Loadout; readonly force?: boolean }
  | { readonly kind: 'back' }
  | { readonly kind: 't0'; readonly value: number }
  | { readonly kind: 't'; readonly value: number }
  | { readonly kind: 'w'; readonly value: number }
  | { readonly kind: 'preset'; readonly presetId: string }
  | { readonly kind: 'adjust'; readonly delta: number }
  | { readonly kind: 'confirm' };

export interface WizardAdvance {
  readonly ok: boolean;
  readonly state: WizardState;
  /** 本步输入不合法时的人话原因（不抛异常——用户输入不是程序错误）。 */
  readonly issue?: string;
}

export const wizardStart = (): WizardState => ({ step: 'choose_fish' });

/** 已测量的参数合成钓组输入；任一步未完成则返回 undefined。 */
export function wizardRigInput(state: WizardState): TaidiaoInput | undefined {
  if (state.t0 === undefined || state.t === undefined || state.w === undefined) return undefined;
  return { t0: state.t0, t: state.t, w: state.w, d: state.d ?? 0 };
}

/** 当前钓组状态（find_bottom 阶段给剖面联动用）；参数还没齐或组合非法返回 undefined。 */
export function wizardRigState(state: WizardState): RigState | undefined {
  const input = wizardRigInput(state);
  if (!input) return undefined;
  const result = calculateRigState(input);
  return result.ok ? result.state : undefined;
}

/**
 * 推荐预设：选了目标鱼就按鱼（鲫鱼调四钓二、鲤鱼调平水钓二…）；
 * 否则按已测的 w 找单饵压目最接近的组合；都没有就给调四钓二。
 */
export function wizardSuggestPreset(state: WizardState): TaidiaoPreset {
  const fishPreset = state.loadout ? presetById(fishById(state.loadout.targetFish)?.presetId ?? '') : undefined;
  if (fishPreset) return fishPreset;
  const fallback = presetById('diao4-diao2')!;
  const w = state.w;
  if (w === undefined) return fallback;
  let best = fallback;
  let bestGap = Infinity;
  for (const preset of TAIDIAO_PRESETS) {
    const gap = Math.abs(preset.w - w);
    if (gap < bestGap) {
      best = preset;
      bestGap = gap;
    }
  }
  return best;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

/** 回到上一步：已填的值保留（回来改一个数不必重填全部），done 不可回退。 */
function stepBack(state: WizardState): WizardAdvance {
  const index = WIZARD_STEPS.indexOf(state.step);
  if (index <= 0 || state.step === 'done') return { ok: false, state, issue: '已经是第一步了。' };
  return { ok: true, state: { ...state, step: WIZARD_STEPS[index - 1]! } };
}

export function wizardAdvance(state: WizardState, input: WizardInput): WizardAdvance {
  if (input.kind === 'back') return stepBack(state);
  switch (state.step) {
    case 'choose_fish': {
      if (input.kind !== 'fish') return { ok: false, state, issue: '先选今天要钓的鱼。' };
      if (!fishById(input.fishId)) return { ok: false, state, issue: `没有这种目标鱼：${input.fishId}。` };
      // 换鱼就换一整套推荐装备；同一条鱼回来重选则保留用户改过的装备。
      const loadout = state.loadout?.targetFish === input.fishId ? state.loadout : recommendedLoadout(input.fishId);
      return { ok: true, state: { ...state, step: 'choose_gear', loadout } };
    }

    case 'choose_gear': {
      if (input.kind !== 'gear') return { ok: false, state, issue: '先确认装备。' };
      if (input.loadout.targetFish !== state.loadout?.targetFish) {
        return { ok: false, state, issue: '装备的目标鱼与上一步选的不一致，请回上一步重选。' };
      }
      const errors = loadoutChecks(input.loadout).filter((check) => check.level === 'error');
      if (errors.length > 0 && input.force !== true) {
        return {
          ok: false,
          state: { ...state, loadout: input.loadout },
          issue: errors.map((check) => check.message).join(' ') + ' 确定要这样钓，再点一次"坚持使用"。',
        };
      }
      return { ok: true, state: { ...state, step: 'measure_t0', loadout: input.loadout } };
    }

    case 'measure_t0': {
      if (input.kind !== 't0') return { ok: false, state, issue: '当前在测无钩调目。' };
      if (!finite(input.value) || input.value <= 0) {
        return { ok: false, state, issue: '无钩调目必须是大于 0 的目数。' };
      }
      return { ok: true, state: { ...state, step: 'measure_t', t0: input.value } };
    }

    case 'measure_t': {
      if (input.kind !== 't') return { ok: false, state, issue: '当前在测带钩调目。' };
      if (!finite(input.value) || input.value < 0) {
        return { ok: false, state, issue: '带钩调目不能是负数。' };
      }
      if (input.value >= (state.t0 ?? 0)) {
        return { ok: false, state, issue: '带钩调目必须小于无钩调目——钩是有重量的，挂上钩漂会沉下去几目。' };
      }
      return { ok: true, state: { ...state, step: 'measure_w', t: input.value } };
    }

    case 'measure_w': {
      if (input.kind !== 'w') return { ok: false, state, issue: '当前在测单饵压目。' };
      if (!finite(input.value) || input.value <= 0) {
        return { ok: false, state, issue: '单饵压目必须大于 0——饵不压漂尾说明饵太轻或没挂上。' };
      }
      return { ok: true, state: { ...state, step: 'choose_preset', w: input.value } };
    }

    case 'choose_preset': {
      if (input.kind !== 'preset') return { ok: false, state, issue: '先选一组调钓预设。' };
      const preset = presetById(input.presetId);
      if (!preset) return { ok: false, state, issue: `没有预设 ${input.presetId}。` };
      // 预设本质是选目标钓目：t/w 用实测值，d 取预设目标。
      return { ok: true, state: { ...state, step: 'find_bottom', presetId: preset.id, d: preset.d } };
    }

    case 'find_bottom': {
      const input0 = wizardRigInput(state);
      if (!input0) return { ok: false, state, issue: '测量参数不完整。' };
      if (input.kind === 'adjust') {
        const d = Math.max(0, (state.d ?? 0) + input.delta);
        const result = calculateRigState({ ...input0, d });
        if (!result.ok) {
          return { ok: false, state, issue: result.issues.map((item: RigIssue) => item.message).join(' ') };
        }
        return { ok: true, state: { ...state, d } };
      }
      if (input.kind === 'confirm') {
        const result = calculateRigState(input0);
        if (!result.ok) {
          return { ok: false, state, issue: result.issues.map((item: RigIssue) => item.message).join(' ') };
        }
        return { ok: true, state: { ...state, step: 'done' } };
      }
      return { ok: false, state, issue: '当前在找底定钓目。' };
    }

    case 'done':
      return { ok: false, state, issue: '向导已完成，可重新开始。' };
  }
}
