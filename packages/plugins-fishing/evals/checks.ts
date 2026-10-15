import { TwinWorld, type WorldEvent } from '@twin-platform/world-kernel';
import { calculateRigState, type RigZone } from '../src/fishingCore';
import { applyFishingDecision } from '../src/environment';
import { createFishSimBehavior, fishingModeOf } from '../src/fishSim';
import { conditionMultipliers, type PondConditions } from '../src/conditions';
import { loadoutEffects, loadoutFromAttrs, recommendedLoadout, TARGET_FISH, type FishId } from '../src/loadout';
import { buildFishingScene } from '../src/template';
import { biteSignalWeights, liftWindowOf } from '../src/biteSignals';
import { ruleJudge } from '../src/ruleJudge';
import { presetById } from '../src/presets';
import { toFishingState } from '../src/state';
import { wizardAdvance, wizardRigInput, wizardStart, type WizardInput } from '../src/wizard';
import { num, str } from '../src/values';

/**
 * evals 的可执行检查——每个函数对应 evals.json 里的一条。
 *
 * 纪律（借鉴 machine-skill 的 evals + Anatomy 的 audit）：
 * - 统计类断言用**固定种子 + 同种子分段对比**，比的是方向，不是绝对概率；
 * - 每条 eval 的 detail 里给出关键数字，人看一眼就知道模型在说什么；
 * - 全部确定性：没有 Date.now / Math.random，重跑结果一致。
 */

export interface EvalResult {
  readonly id: number;
  readonly pass: boolean;
  readonly detail: string;
}

const RIG = 'rig-01';

interface PondOptions {
  readonly seed?: number;
  readonly seconds?: number;
  readonly rig?: Readonly<Record<string, number | string | boolean>>;
  readonly attrs?: Readonly<Record<string, number | string | boolean>>;
}

/** 建一个钓场世界；rig 是初始调钓参数，attrs 是运行中可写的情况 / 装备。 */
const pond = (options: PondOptions = {}): TwinWorld => {
  const world = new TwinWorld(buildFishingScene({ castInterval: 1, rig: options.rig ?? { t0: 5, t: 4, w: 1, d: 3.5 } }), {
    seed: options.seed ?? 5,
    maxStepsPerAdvance: 600,
    behaviors: [createFishSimBehavior()],
  });
  for (const [key, value] of Object.entries(options.attrs ?? {})) world.setAttr(RIG, key, value);
  return world;
};

const run = (world: TwinWorld, seconds: number): Record<string, unknown> => {
  world.runSteps(Math.round(seconds / world.stepSize));
  return { ...(world.getEntity(RIG)?.attrs ?? {}) };
};

const rate = (attrs: Readonly<Record<string, unknown>>, key: string): number =>
  Number(attrs[key] ?? 0) / Math.max(1, Number(attrs.casts ?? 0));

/** 同种子两段对比：第一段记录基线，apply 动作后再跑一段，比较增量。 */
const beforeAfter = (
  options: PondOptions,
  seconds: number,
  apply: (world: TwinWorld) => void,
): { before: Record<string, unknown>; after: Record<string, unknown> } => {
  const world = pond(options);
  run(world, seconds);
  const before = { ...(world.getEntity(RIG)?.attrs ?? {}) };
  apply(world);
  run(world, seconds);
  const after = { ...(world.getEntity(RIG)?.attrs ?? {}) };
  return { before, after };
};

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** 事件日志里从 from 开始的每一口漂相（bite === true 的 fish:cast）。 */
const signalsSince = (world: TwinWorld, from: number): string[] =>
  world
    .getEventLog()
    .slice(from)
    .filter((event: WorldEvent) => event.type === 'fish:cast' && event.payload?.bite === true)
    .map((event) => str(event.payload?.signal, 'none'));

const shareOf = (signals: readonly string[], signal: string): number =>
  signals.length === 0 ? 0 : signals.filter((item) => item === signal).length / signals.length;

// ---------------------------------------------------------------------------

const evalPresetNeutral = (): EvalResult => {
  const preset = presetById('diao4-diao2');
  if (!preset) return { id: 1, pass: false, detail: '预设 diao4-diao2 不存在' };
  // 向导实测路径：t0=4（第1步）→ t=2（第2步，双钩压2目）→ w=1（第3步）→ 预设给 d=2。
  const input = { t0: 4, t: preset.t === 4 ? 2 : preset.t, w: preset.w, d: preset.d };
  const result = calculateRigState(input);
  const zone: RigZone | undefined = result.ok ? result.state.zone : undefined;

  const classic = pond({ rig: { t0: 4, t: 2, w: 1, d: 2 }, seconds: 400 });
  const classicAttrs = run(classic, 400);
  const leaded = pond({ rig: { t0: 2, t: 0, w: 1, d: 2 }, seconds: 400 });
  const leadedAttrs = run(leaded, 400);

  const pass =
    zone === 'neutral' &&
    rate(classicAttrs, 'bites') > rate(leadedAttrs, 'bites') &&
    rate(classicAttrs, 'catches') > rate(leadedAttrs, 'catches');
  return {
    id: 1,
    pass,
    detail: `调四钓二（t0=4,t=2,w=1,d=2）落 ${zone}；咬钩 ${pct(rate(classicAttrs, 'bites'))} vs 走铅 ${pct(rate(leadedAttrs, 'bites'))}，中鱼 ${pct(rate(classicAttrs, 'catches'))} vs ${pct(rate(leadedAttrs, 'catches'))}`,
  };
};

const evalBiteNoCatch = (): EvalResult => {
  // Judge 侧：灵区有口不中应该往钝。
  const rigResult = calculateRigState({ t0: 5, t: 4, w: 1, d: 2.5 });
  if (!rigResult.ok) return { id: 2, pass: false, detail: '测试钓组参数不合法' };
  const judge = ruleJudge.judge(
    toFishingState(rigResult.state, { intent: 'bite_no_catch', observation: { bites: 5, catches: 1, emptyHooks: 4 } }),
  );
  const judgeOk = judge.action === 'ADJUST_FLOAT' && judge.params['direction'] === 'blunt';

  // 仿真侧：同种子两段，第二段执行"上推1目×2"（2.5 → 4.5，sensitive → blunt）。
  const { before, after } = beforeAfter({ rig: { t0: 5, t: 4, w: 1, d: 2.5 } }, 200, (world) => {
    applyFishingDecision(world, { action: 'ADJUST_FLOAT', params: { direction: 'blunt', steps: 1 } }, world.time);
    applyFishingDecision(world, { action: 'ADJUST_FLOAT', params: { direction: 'blunt', steps: 1 } }, world.time);
  });
  const castDelta = Math.max(1, Number(after.casts ?? 0) - Number(before.casts ?? 0));
  const afterCatch = (Number(after.catches ?? 0) - Number(before.catches ?? 0)) / castDelta;
  const afterBite = (Number(after.bites ?? 0) - Number(before.bites ?? 0)) / castDelta;
  const beforeEmpty = Number(before.emptyHooks ?? 0) / Math.max(1, Number(before.bites ?? 0));
  const afterEmpty = Number(after.emptyHooks ?? 0) / Math.max(1, Number(after.bites ?? 0));

  const pass = judgeOk && afterCatch > 0 && afterBite > 0 && afterEmpty < beforeEmpty;
  return {
    id: 2,
    pass,
    detail: `Judge: ${judge.action}/${String(judge.params['direction'])}；后段中鱼率 ${pct(afterCatch)}、咬钩 ${pct(afterBite)}；空竿率 ${pct(beforeEmpty)} → ${pct(afterEmpty)}`,
  };
};

const evalDriftLead = (): EvalResult => {
  const base: PondConditions = { drift: false, waterTemperature: 20, smallFish: false, antiDrift: false, nestUntil: 0 };
  const open = conditionMultipliers({ ...base, drift: true }, 0);
  const leaded = conditionMultipliers({ ...base, drift: true, antiDrift: true }, 0);
  const multiplierOk = open.bite < leaded.bite && open.hook < leaded.hook;

  // 同种子两段：第一段裸走水，第二段加轻铅抗流。各自收集漂相。
  const world = pond({ rig: { t0: 5, t: 4, w: 1, d: 3.5 }, attrs: { drift: true } });
  run(world, 200);
  const openSignals = signalsSince(world, 0);
  const zoneBefore = str(world.getEntity(RIG)?.attrs.zone, '');
  const mark = world.getEventLog().length;
  applyFishingDecision(world, { action: 'ADD_LEAD', params: { amount: 'light' } }, world.time);
  const antiDrift = world.getEntity(RIG)?.attrs.antiDrift === true;
  run(world, 200);
  const leadedSignals = signalsSince(world, mark);
  const zoneAfter = str(world.getEntity(RIG)?.attrs.zone, '');

  // 抗流的收益：信号从"糊"（移漂为主）变回真实的口；倍率恢复；antiDrift 落地。
  // 抗流的代价同样要被断言：加铅会把钓组推钝（分区改变）——不是免费的午餐。
  const runShareOpen = shareOf(openSignals, 'run');
  const runShareLeaded = shareOf(leadedSignals, 'run');
  const pass = multiplierOk && antiDrift && runShareLeaded < runShareOpen && zoneAfter !== zoneBefore;
  return {
    id: 3,
    pass,
    detail: `倍率 bite ${open.bite} → ${leaded.bite}、hook ${open.hook} → ${leaded.hook}；移漂占比 ${pct(runShareOpen)} → ${pct(runShareLeaded)}；分区 ${zoneBefore} → ${zoneAfter}（加铅的代价：钓组变钝）`,
  };
};

const evalSmallFish = (): EvalResult => {
  const base: PondConditions = { drift: false, waterTemperature: 20, smallFish: false, antiDrift: false, nestUntil: 0 };
  const small = conditionMultipliers({ ...base, smallFish: true }, 0);
  const multiplierOk = small.bite > 1 && small.hook < 0.5;

  const calm = run(pond(), 400);
  const noisy = pond({ attrs: { smallFish: true } });
  const busy = run(noisy, 400);
  const emptyRate = (attrs: Record<string, unknown>): number => Number(attrs.emptyHooks) / Math.max(1, Number(attrs.bites));
  const simOk = emptyRate(busy) > emptyRate(calm) + 0.2;

  // 换钓位落地：smallFish / drift 清零、窝作废。
  const spot = pond({ attrs: { smallFish: true, drift: true, nestUntil: 999 } });
  applyFishingDecision(spot, { action: 'CHANGE_SPOT', params: { urgency: 'now' } }, 0);
  const attrs = spot.getEntity(RIG)?.attrs ?? {};
  const spotOk = attrs.smallFish === false && attrs.drift === false && num(attrs.nestUntil, -1) === 0;

  return {
    id: 4,
    pass: multiplierOk && simOk && spotOk,
    detail: `闹窝 bite ×${small.bite} / hook ×${small.hook}；空竿率 ${pct(emptyRate(calm))} → ${pct(emptyRate(busy))}；换位后 smallFish=${String(attrs.smallFish)} drift=${String(attrs.drift)}`,
  };
};

const evalRefillNest = (): EvalResult => {
  const { before, after } = beforeAfter({ rig: { t0: 5, t: 4, w: 1, d: 3.5 } }, 150, (world) => {
    applyFishingDecision(world, { action: 'REFILL_NEST', params: { amount: 'normal' } }, world.time);
  });
  const nestUntil = num(after.nestUntil, 0);
  const castDelta = Math.max(1, Number(after.casts ?? 0) - Number(before.casts ?? 0));
  const biteDelta = (Number(after.bites ?? 0) - Number(before.bites ?? 0)) / castDelta;
  const beforeRate = Number(before.bites ?? 0) / Math.max(1, Number(before.casts ?? 0));
  const pass = nestUntil > beforeRate * 0 + 90 - 1e-9 && nestUntil < 150 + 90 + 1e-9 && biteDelta > beforeRate;
  return {
    id: 5,
    pass,
    detail: `nestUntil=${nestUntil.toFixed(1)}（now+90s）；咬钩率 ${pct(beforeRate)} → ${pct(biteDelta)}`,
  };
};

const evalChangeBait = (): EvalResult => {
  const world = pond({ attrs: { targetFish: 'crucian', bait: 'corn' } });
  applyFishingDecision(world, { action: 'CHANGE_BAIT', params: { target: 'flavor' } }, 0);
  const bait = str(world.getEntity(RIG)?.attrs.bait, '');
  const fish = TARGET_FISH.find((item) => item.id === 'crucian')!;
  const best = (Object.entries(fish.baitAffinity) as [string, number][]).sort((a, b) => b[1] - a[1])[0]![0];
  const affinities = [0.5, 1, 1.15, 1.2].map((affinity) => loadoutEffects({ ...recommendedLoadout('crucian'), bait: baitById(affinity) }).biteMul);
  const monotone = affinities.every((value, index) => index === 0 || value >= affinities[index - 1]!);
  return {
    id: 6,
    pass: bait === best && monotone,
    detail: `换饵 → ${bait}（鲫鱼最爱：${best}）；biteMul 随亲和力单调：${affinities.join(' / ')}`,
  };
};

const baitById = (affinity: number): 'worm' | 'grain' | 'commercial' | 'corn' =>
  ({ 0.5: 'corn', 1: 'grain', 1.15: 'commercial', 1.2: 'worm' } as const)[affinity];

const evalSignals = (): EvalResult => {
  const windows = [liftWindowOf('nod'), liftWindowOf('lift'), liftWindowOf('run'), liftWindowOf('sink')];
  const windowOk = windows[0]! < windows[1]! && windows[1]! < windows[2]! && windows[2]! < windows[3]!;
  const noRun = biteSignalWeights({ zone: 'neutral', fish: 'crucian', drift: false, antiDrift: false }).run === 0;
  const blunt = biteSignalWeights({ zone: 'blunt', fish: 'crucian', drift: false, antiDrift: false });
  const sensitive = biteSignalWeights({ zone: 'sensitive', fish: 'crucian', drift: false, antiDrift: false });
  const drifting = biteSignalWeights({ zone: 'neutral', fish: 'crucian', drift: true, antiDrift: false });
  const pass =
    windowOk &&
    noRun &&
    blunt.sink / (blunt.nod + blunt.lift + blunt.sink) > 0.4 &&
    sensitive.nod / (sensitive.nod + sensitive.lift + sensitive.sink) > 0.4 &&
    drifting.run / (drifting.nod + drifting.lift + drifting.sink + drifting.run) > 0.4;
  return {
    id: 7,
    pass,
    detail: `窗口 ${windows.join(' < ')}s；钝区黑漂占比 ${pct(blunt.sink / (blunt.nod + blunt.lift + blunt.sink))}、灵区顿口占比 ${pct(sensitive.nod / (sensitive.nod + sensitive.lift + sensitive.sink))}、走水移漂占比 ${pct(drifting.run / (drifting.nod + drifting.lift + drifting.sink + drifting.run))}`,
  };
};

const fingerprint = (world: TwinWorld): string =>
  JSON.stringify({
    events: world.getEventLog().map((event) => event.type + ':' + JSON.stringify(event.payload ?? {})),
    attrs: world.getEntity(RIG)?.attrs ?? {},
  });

const evalDeterminism = (): EvalResult => {
  const first = pond({ rig: { t0: 5, t: 4, w: 1, d: 3.5 }, attrs: { drift: true } });
  const second = pond({ rig: { t0: 5, t: 4, w: 1, d: 3.5 }, attrs: { drift: true } });
  run(first, 240);
  run(second, 240);
  const pass = fingerprint(first) === fingerprint(second);
  return { id: 8, pass, detail: pass ? '同种子两次运行事件流与 attrs 逐位一致' : '两次运行不一致——确定性被破坏' };
};

const evalRealMode = (): EvalResult => {
  const world = pond({ attrs: { fishingMode: 'real' } });
  const attrs = run(world, 240);
  const mode = fishingModeOf(world.getEntity(RIG)?.attrs);
  // signal 缺省即 none（attrs 里没有这个键 = 没有信号）——契约见 conditionsOf / str 的兜底。
  const pass =
    mode === 'real' &&
    num(attrs.casts, -1) === 0 &&
    num(attrs.bites, -1) === 0 &&
    str(attrs.signal, 'none') === 'none';
  // 姿态照摆：布局实体仍然在动（钓组随调钓变化）。
  const y = (id: string): number => world.getEntity(id)?.transform.position[1] ?? NaN;
  const postureOk = Number.isFinite(y('float-01')) && y('float-01') > y('sinker-01');
  return {
    id: 9,
    pass: pass && postureOk,
    detail: `real 模式：casts=${String(attrs.casts)} bites=${String(attrs.bites)} signal=${String(attrs.signal ?? 'none(缺省)')}；钓组姿态仍刷新（浮漂 ${y('float-01').toFixed(2)} > 铅坠 ${y('sinker-01').toFixed(2)}）`,
  };
};

const evalWizard = (): EvalResult => {
  const inputs: WizardInput[] = [
    { kind: 'fish', fishId: 'crucian' },
    { kind: 'gear', loadout: recommendedLoadout('crucian') },
    { kind: 't0', value: 4 },
    { kind: 't', value: 2 },
    { kind: 'w', value: 1 },
    { kind: 'preset', presetId: 'diao4-diao2' },
    { kind: 'confirm' },
  ];
  let state = wizardStart();
  for (const input of inputs) state = wizardAdvance(state, input).state;
  const rigInput = wizardRigInput(state);
  const legal = rigInput ? calculateRigState(rigInput).ok : false;
  return {
    id: 10,
    pass: state.step === 'done' && legal === true,
    detail: `向导七步 → ${state.step}；产出 ${JSON.stringify(rigInput)}，calculateRigState ${legal ? '合法' : '拒收'}`,
  };
};

/** id → 检查函数。evals.json 里有几条，这里就必须有几条。 */
export const CHECKS: Readonly<Record<number, () => EvalResult>> = {
  1: evalPresetNeutral,
  2: evalBiteNoCatch,
  3: evalDriftLead,
  4: evalSmallFish,
  5: evalRefillNest,
  6: evalChangeBait,
  7: evalSignals,
  8: evalDeterminism,
  9: evalRealMode,
  10: evalWizard,
};
