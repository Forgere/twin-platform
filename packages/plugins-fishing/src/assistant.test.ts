import { describe, expect, test } from 'bun:test';
import { adviseSituation, matchSituation, SITUATIONS, stateForSituation } from './assistant';
import { conditionsOf } from './conditions';
import { calculateRigState } from './fishingCore';
import { recommendedLoadout } from './loadout';
import { toFishingState } from './state';
import { FISHING_ACTION_IDS } from './actionSpace';

/**
 * 钓鱼助手回归：
 * - 口语归类：常见说法都能归到对的情况，听不懂就坦白（不猜）；
 * - 每种情况在各种钓组状态下都给得出回答，问题类必带合法动作；
 * - 回答随状态变化（同一句"没口"，饵离底和饵到底时的建议不一样）。
 */

const rig = (d: number) => {
  const result = calculateRigState({ t0: 6, t: 4, w: 1, d });
  if (!result.ok) throw new Error('bad rig');
  return result.state;
};

const calm = conditionsOf({});

describe('口语归类', () => {
  test.each([
    ['钓了半天一点动静都没有，没口', 'no_bite'],
    ['漂动了好几次，提竿都是空竿', 'bite_no_catch'],
    ['起风了漂一直往右跑', 'drift'],
    ['饵一下就没了，好像是小鱼在偷饵', 'small_fish'],
    ['刚中了条大的，线断了', 'line_break'],
    ['什么时候提竿啊', 'when_strike'],
  ])('%s → %s', (text, expected) => {
    expect(matchSituation(text).situation?.id).toBe(expected as never);
  });

  test('听不懂就返回空、置信度 0', () => {
    expect(matchSituation('今天天气真好').situation).toBeUndefined();
    expect(matchSituation('   ').confidence).toBe(0);
  });
});

describe('规则解答', () => {
  test('每种情况 × 每个分区都有回答；问题类带动作空间内的动作', () => {
    for (const situation of SITUATIONS) {
      for (const d of [0, 2.5, 3.5, 5, 7]) {
        const advice = adviseSituation(situation.id, toFishingState(rig(d)), recommendedLoadout('crucian'), calm);
        expect(advice.title.length).toBeGreaterThan(0);
        expect(advice.rule.length).toBeGreaterThan(0);
        if (situation.kind === 'problem') expect(FISHING_ACTION_IDS).toContain(advice.action!.action);
        else expect(advice.action).toBeUndefined();
      }
    }
  });

  test('同一句"没口"：饵离底 → 找底；到底了且饵不对 → 换饵', () => {
    const offBottom = adviseSituation('no_bite', toFishingState(rig(0)), recommendedLoadout('crucian'), calm);
    expect(offBottom.action?.action).toBe('ADJUST_FLOAT');
    const wrongBait = adviseSituation('no_bite', toFishingState(rig(3.5)), { ...recommendedLoadout('crucian'), bait: 'corn' }, calm);
    expect(wrongBait.action?.action).toBe('CHANGE_BAIT');
  });

  test('走水：没加铅先加铅，加过还跑就换钓位', () => {
    const state = toFishingState(rig(3.5));
    expect(adviseSituation('drift', state, recommendedLoadout('carp'), { ...calm, drift: true }).action?.action).toBe('ADD_LEAD');
    expect(adviseSituation('drift', state, recommendedLoadout('carp'), { ...calm, drift: true, antiDrift: true }).action?.action).toBe(
      'CHANGE_SPOT',
    );
  });

  test('有口不中且钩太大 → 换钩优先于调漂', () => {
    const advice = adviseSituation('bite_no_catch', toFishingState(rig(3.5)), { ...recommendedLoadout('crucian'), hookSize: 6 }, calm);
    expect(advice.action?.action).toBe('REBUILD_RIG');
  });

  test('stateForSituation：用户说的情况覆盖 intent / drift，交给判断者', () => {
    const base = toFishingState(rig(3.5));
    expect(stateForSituation(base, 'drift')).toMatchObject({ drift: true, intent: 'drift' });
    expect(stateForSituation(base, 'bite_no_catch').intent).toBe('bite_no_catch');
    expect(stateForSituation(base, 'how_bottom')).toBe(base);
  });
});
