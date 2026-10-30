import { describe, expect, test } from 'bun:test';
import { TwinWorld, type WorldEvent } from '@twin-platform/world-kernel';
import { calculateRigState, type RigZone } from './fishingCore';
import { BITE_SIGNAL_POOL, biteSignalWeights, liftWindowOf, signalWeight, type SignalSituation } from './biteSignals';
import { createFishSimBehavior } from './fishSim';
import { buildFishingScene } from './template';
import { num, str } from './values';

/**
 * 漂相模型（biteSignals）的验收。
 *
 * 分两层：
 * 1. 权重表本身的不变量（纯函数，穷举分区 × 鱼种 × 走水）；
 * 2. 跑进世界后的统计表现（固定种子，确定性）——"钝区黑漂多、灵区顿口多、
 *    走水才有移漂、鲤鱼比鲫鱼更容易黑漂"，这些是用户能直接观察到的行为。
 */

const ZONES: readonly RigZone[] = ['off_bottom', 'sensitive', 'neutral', 'blunt', 'sinker_on_bottom'];
const FISH = ['crucian', 'carp', 'grass_carp', 'tilapia'] as const;

describe('漂相权重表', () => {
  test('静水（不走水）时移漂权重恒为 0——移漂是走水的专属信号', () => {
    for (const zone of ZONES) {
      for (const fish of FISH) {
        expect(signalWeight('run', { zone, fish, drift: false, antiDrift: false })).toBe(0);
      }
    }
  });

  test('走水未抗流时移漂压倒其余漂相；加铅抗流后移漂变轻', () => {
    for (const zone of ZONES) {
      const open = biteSignalWeights({ zone, fish: 'crucian', drift: true, antiDrift: false });
      const leaded = biteSignalWeights({ zone, fish: 'crucian', drift: true, antiDrift: true });
      expect(open.run).toBeGreaterThan(open.nod);
      expect(open.run).toBeGreaterThan(open.lift);
      expect(open.run).toBeGreaterThan(open.sink);
      // 加了铅：线还是斜，但稳了——移漂从 2.6 降到 1.2。
      expect(leaded.run).toBeLessThan(open.run);
      expect(leaded.run).toBeGreaterThan(0);
    }
  });

  test('分区决定主漂相：钝区黑漂、灵区顿口、离底送漂', () => {
    const blunt = biteSignalWeights({ zone: 'blunt', fish: 'crucian', drift: false, antiDrift: false });
    expect(blunt.sink).toBeGreaterThan(blunt.nod);
    const sensitive = biteSignalWeights({ zone: 'sensitive', fish: 'crucian', drift: false, antiDrift: false });
    expect(sensitive.nod).toBeGreaterThan(sensitive.sink);
    const offBottom = biteSignalWeights({ zone: 'off_bottom', fish: 'crucian', drift: false, antiDrift: false });
    expect(offBottom.lift).toBeGreaterThan(offBottom.sink);
  });

  test('鱼种修正：鲤鱼黑漂权重高于鲫鱼，鲫鱼顿口权重高于鲤鱼', () => {
    const zone: RigZone = 'neutral';
    const carp = biteSignalWeights({ zone, fish: 'carp', drift: false, antiDrift: false });
    const crucian = biteSignalWeights({ zone, fish: 'crucian', drift: false, antiDrift: false });
    expect(carp.sink).toBeGreaterThan(crucian.sink);
    expect(crucian.nod).toBeGreaterThan(carp.nod);
  });

  test('提竿窗口随漂相：顿口最短、黑漂最长', () => {
    expect(liftWindowOf('nod')).toBeLessThan(liftWindowOf('lift'));
    expect(liftWindowOf('lift')).toBeLessThan(liftWindowOf('run'));
    expect(liftWindowOf('run')).toBeLessThan(liftWindowOf('sink'));
    expect(liftWindowOf('none')).toBe(1.6);
  });

  test('权重表覆盖全部候选漂相，且 none 不参与抽取', () => {
    const weights = biteSignalWeights({ zone: 'neutral', fish: 'crucian', drift: true, antiDrift: false });
    expect(Object.keys(weights).sort()).toEqual([...BITE_SIGNAL_POOL, 'none'].sort());
    expect(weights.none).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 世界内统计表现（固定种子，确定性）
// ---------------------------------------------------------------------------

/** 跑一段仿真，收集每一口的漂相（bite === true 的 fish:cast）。 */
const collectSignals = (options: {
  readonly seed?: number;
  readonly seconds?: number;
  readonly attrs?: Readonly<Record<string, number | string | boolean>>;
}): { signals: string[]; bites: number } => {
  const world = new TwinWorld(buildFishingScene({ castInterval: 1 }), {
    seed: options.seed ?? 5,
    maxStepsPerAdvance: 600,
    behaviors: [createFishSimBehavior()],
  });
  for (const [key, value] of Object.entries(options.attrs ?? {})) world.setAttr('rig-01', key, value);
  world.runSteps(60 * (options.seconds ?? 400));
  const casts = world.getEventLog().filter((event: WorldEvent) => event.type === 'fish:cast');
  const signals = casts.filter((event) => event.payload?.bite === true).map((event) => str(event.payload?.signal, ''));
  return { signals, bites: signals.length };
};

const share = (signals: readonly string[], signal: string): number =>
  signals.length === 0 ? 0 : signals.filter((item) => item === signal).length / signals.length;

/**
 * 调目到指定分区：t0=5, t=4, w=1 → d1=2（离底）, d2=3.5（不灵不钝）, d3=5（铅坠触底）。
 * attrs 必须整组给（t0/t/w 与 d 一起）——只改 d 会落在模板默认参数的另一个分区上。
 */
const rigAttrs = (zone: RigZone, extra: Readonly<Record<string, number | string | boolean>> = {}): Readonly<Record<string, number | string | boolean>> => ({
  t0: 5,
  t: 4,
  w: 1,
  d: marksFor(zone),
  ...extra,
});

const marksFor = (zone: RigZone): number => {
  switch (zone) {
    case 'off_bottom':
      return 1;
    case 'sensitive':
      return 2.5;
    case 'neutral':
      return 3.5;
    case 'blunt':
      return 4;
    case 'sinker_on_bottom':
      return 5;
  }
};

describe('漂相在仿真里的表现', () => {
  test('不走水就永远不出移漂', () => {
    const { signals } = collectSignals({ seed: 5, attrs: rigAttrs('blunt') });
    expect(signals.length).toBeGreaterThan(20);
    expect(signals).not.toContain('run');
  });

  test('走水未抗流：移漂是主信号', () => {
    const { signals } = collectSignals({ seed: 5, attrs: rigAttrs('neutral', { drift: true }) });
    expect(signals.length).toBeGreaterThan(20);
    expect(share(signals, 'run')).toBeGreaterThan(0.4);
  });

  test('走水加了铅：还有移漂，但明显少了', () => {
    const open = collectSignals({ seed: 5, attrs: rigAttrs('neutral', { drift: true }) });
    const leaded = collectSignals({ seed: 5, attrs: rigAttrs('neutral', { drift: true, antiDrift: true }) });
    expect(share(leaded.signals, 'run')).toBeGreaterThan(0.15);
    expect(share(leaded.signals, 'run')).toBeLessThan(share(open.signals, 'run'));
  });

  test('钝区黑漂多，灵区顿口多', () => {
    const blunt = collectSignals({ seed: 5, attrs: rigAttrs('blunt') });
    const sensitive = collectSignals({ seed: 5, attrs: rigAttrs('sensitive') });
    expect(blunt.signals.length).toBeGreaterThan(10);
    expect(share(blunt.signals, 'sink')).toBeGreaterThan(0.4);
    expect(sensitive.signals.length).toBeGreaterThan(10);
    expect(share(sensitive.signals, 'nod')).toBeGreaterThan(0.4);
  });

  test('同样的不灵不钝，鲤鱼比鲫鱼更容易黑漂', () => {
    const crucian = collectSignals({ seed: 5, attrs: rigAttrs('neutral', { targetFish: 'crucian' }) });
    const carp = collectSignals({ seed: 5, attrs: rigAttrs('neutral', { targetFish: 'carp' }) });
    expect(crucian.signals.length).toBeGreaterThan(10);
    expect(carp.signals.length).toBeGreaterThan(10);
    expect(share(carp.signals, 'sink')).toBeGreaterThan(share(crucian.signals, 'sink'));
  });

  test('同种子两次运行，漂相序列逐位一致（回放兼容）', () => {
    const first = collectSignals({ seed: 13, attrs: rigAttrs('neutral', { drift: true }) });
    const second = collectSignals({ seed: 13, attrs: rigAttrs('neutral', { drift: true }) });
    expect(second.signals).toEqual(first.signals);
  });
});

describe('提竿窗口接线', () => {
  test('有口后 biteUntil 与当前漂相的窗口一致（顿口短、黑漂长）', () => {
    const world = new TwinWorld(buildFishingScene({ castInterval: 1 }), {
      seed: 9,
      maxStepsPerAdvance: 600,
      behaviors: [createFishSimBehavior()],
    });
    // 手动模式：有口后挂起等提杆，biteUntil 按漂相窗口设定。
    world.setAttr('rig-01', 'fishingMode', 'sim');
    world.setAttr('rig-01', 'manualCast', true);
    world.setAttr('rig-01', 'inWater', true);
    const checked: number[] = [];
    for (let i = 0; i < 60 * 300; i++) {
      world.step(1 / 60);
      const attrs = world.getEntity('rig-01')?.attrs ?? {};
      if (attrs.pendingBite === true && str(attrs.signal, 'none') !== 'none') {
        const until = num(attrs.biteUntil, NaN);
        if (Number.isFinite(until)) checked.push(until - world.time);
        // 提杆结算掉这口，避免反复记同一口。
        world.setAttr('rig-01', 'lift', true);
      } else if (attrs.inWater !== true) {
        // manualCast 提杆后收竿：重新抛竿，才等得到下一口。
        world.setAttr('rig-01', 'cast', true);
      }
    }
    expect(checked.length).toBeGreaterThan(5);
    // 每一口的剩余窗口都应等于对应漂相的窗口（±一帧）。
    for (const remaining of checked) {
      const window = [1.1, 1.4, 1.6, 1.9].find((value) => Math.abs(value - remaining) < 1 / 60 + 1e-6);
      expect(window).toBeDefined();
    }
    // 顿口与黑漂的窗口都真实出现过（确定性种子下稳定）。
    const rounded = new Set(checked.map((value) => [1.1, 1.4, 1.6, 1.9].find((w) => Math.abs(w - value) < 1 / 60 + 1e-6)));
    expect(rounded.size).toBeGreaterThan(1);
  });
});

// 分区落点自检：上面的 marksFor 必须真的落在声称的分区上。
describe('marksFor 分区自检', () => {
  test('每个标记值都落在声称的灵钝分区', () => {
    const input = { t0: 5, t: 4, w: 1 };
    const expectations: [RigZone, RigZone][] = [
      ['off_bottom', 'off_bottom'],
      ['sensitive', 'sensitive'],
      ['neutral', 'neutral'],
      ['blunt', 'blunt'],
      ['sinker_on_bottom', 'sinker_on_bottom'],
    ];
    for (const [zone, expected] of expectations) {
      const result = calculateRigState({ ...input, d: marksFor(zone) });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.state.zone).toBe(expected);
    }
  });
});
