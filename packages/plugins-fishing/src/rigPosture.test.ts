import { describe, expect, test } from 'bun:test';
import { calculateRigState } from './fishingCore';
import {
  RIG_LINKS,
  rigPosture,
  subLineBend,
  type FloatSignal,
  type RigPartId,
} from './rigPosture';

/**
 * 线组姿态的回归测试。
 *
 * 分两块：
 * - **拓扑**：这是"纠正连接关系"的验收——主线穿过漂座一路到 8 字环，上下钩是
 *   8 字环分出的两条并联子线，上钩下钩之间**没有线**；
 * - **状态**：五档灵钝（未到底 / 灵 / 不灵不钝 / 钝 / 铅坠触底）下每个部件该
 *   悬的悬、该触底的触底、该弯的子线弯。
 */

/** t0=4 t=2 w=1 → H=2、hw=1；d1=0、d2=2（不灵不钝）、d3=4（铅坠触底）。 */
const rigAt = (d: number) => {
  const result = calculateRigState({ t0: 4, t: 2, w: 1, d });
  if (!result.ok) throw new Error('测试用的调钓参数不合法');
  return result.state;
};

const partOf = (posture: ReturnType<typeof rigPosture>, part: RigPartId) =>
  posture.parts.find((item) => item.part === part)!;

describe('线组拓扑', () => {
  test('五段线：三段主线 + 两段子线', () => {
    expect(RIG_LINKS).toHaveLength(5);
    expect(RIG_LINKS.filter((link) => link.kind === 'main')).toHaveLength(3);
    expect(RIG_LINKS.filter((link) => link.kind === 'branch')).toHaveLength(2);
  });

  test('主线是"竿梢 → 漂座 → 铅皮座 → 8字环"一条链，漂不是端点', () => {
    expect(RIG_LINKS.slice(0, 3).map((link) => link.from + '->' + link.to)).toEqual([
      'rodTip->float',
      'float->sinker',
      'sinker->swivel',
    ]);
  });

  test('上下钩并联在 8 字环上，钩与钩之间没有线', () => {
    expect(RIG_LINKS.slice(3).map((link) => link.from + '->' + link.to)).toEqual([
      'swivel->hookUpper',
      'swivel->hookLower',
    ]);
    expect(RIG_LINKS.some((link) => link.from === 'hookUpper' && link.to === 'hookLower')).toBe(false);
    expect(RIG_LINKS.some((link) => link.from === 'sinker' && link.to === 'hookLower')).toBe(false);
  });
});

describe('五档灵钝下的部件状态', () => {
  test('未到底（B=0）：双钩双饵都悬着，子线绷直', () => {
    const posture = rigPosture(rigAt(0));
    expect(posture.zone).toBe('off_bottom');
    expect(partOf(posture, 'baitLower').code).toBe('suspended');
    expect(partOf(posture, 'hookLower').code).toBe('suspended');
    expect(posture.subLineLower.state).toBe('straight');
    expect(posture.subLineLower.bend).toBe(0);
    expect(posture.sinker.code).toBe('suspended');
  });

  test('灵区（B=1）：下饵到底、下钩还悬着', () => {
    const posture = rigPosture(rigAt(1));
    expect(posture.zone).toBe('sensitive');
    expect(partOf(posture, 'baitLower').code).toBe('on_bottom');
    expect(partOf(posture, 'hookLower').code).toBe('suspended');
    expect(posture.subLineLower.state).toBe('straight');
  });

  test('不灵不钝（B=2）：下钩饵到底、上钩饵悬着，长子线刚好绷直', () => {
    const posture = rigPosture(rigAt(2));
    expect(posture.zone).toBe('neutral');
    expect(partOf(posture, 'baitLower').code).toBe('on_bottom');
    expect(partOf(posture, 'hookLower').code).toBe('on_bottom');
    expect(partOf(posture, 'baitUpper').code).toBe('suspended');
    expect(posture.subLineLower.bend).toBeCloseTo(0, 9);
    expect(posture.subLineLower.state).toBe('straight');
  });

  test('钝区（B=3）：上饵也到底，长子线开始起弯——信号衰减', () => {
    const posture = rigPosture(rigAt(3));
    expect(posture.zone).toBe('blunt');
    expect(partOf(posture, 'baitUpper').code).toBe('on_bottom');
    expect(posture.subLineLower.bend).toBeCloseTo(0.5, 9);
    expect(posture.subLineLower.state).toBe('sagging');
    // 短子线（上钩）这时还没被压弯：上钩刚到底，还没"过量"。
    expect(posture.subLineUpper.bend).toBeCloseTo(0, 9);
  });

  test('铅坠触底（B=4）：铅坠躺底，两根子线都弯到头', () => {
    const posture = rigPosture(rigAt(4));
    expect(posture.zone).toBe('sinker_on_bottom');
    expect(posture.sinker.code).toBe('on_bottom');
    expect(posture.subLineLower.state).toBe('lying');
    expect(posture.subLineUpper.state).toBe('lying');
  });

  test('越钝子线越弯（弯曲量单调不减）', () => {
    const bends = [0, 1, 2, 3, 4].map((d) => subLineBend(rigAt(d), 'lower'));
    for (let index = 1; index < bends.length; index += 1) {
      expect(bends[index]!).toBeGreaterThanOrEqual(bends[index - 1]!);
    }
  });
});

describe('漂相与走水', () => {
  test('漂常态是"露出 d 目"', () => {
    const posture = rigPosture(rigAt(2));
    expect(posture.float.visibleMarks).toBe(2);
    expect(posture.float.code).toBe('balanced');
    expect(posture.float.text).toContain('2 目');
  });

  test('黑漂 / 顿口 / 送漂各自进状态', () => {
    const signals: [FloatSignal, string][] = [
      ['sink', '黑漂'],
      ['nod', '顿口'],
      ['lift', '送漂'],
    ];
    for (const [signal, keyword] of signals) {
      const posture = rigPosture(rigAt(2), { signal });
      expect(posture.float.signal).toBe(signal);
      expect(posture.float.text).toContain(keyword);
    }
    expect(rigPosture(rigAt(2), { signal: 'sink' }).float.code).toBe('submerged');
  });

  test('走水：主线被拉斜、漂走位', () => {
    const calm = rigPosture(rigAt(2));
    const drifting = rigPosture(rigAt(2), { drift: true });
    expect(calm.mainLine.code).toBe('taut');
    expect(calm.mainLine.tiltDeg).toBe(0);
    expect(drifting.mainLine.code).toBe('tilted');
    expect(drifting.mainLine.tiltDeg).toBeGreaterThan(0);
    expect(drifting.float.code).toBe('drifting');
  });
});

describe('状态表', () => {
  test('自上而下八个部件，每个都有中文名与状态文案', () => {
    const posture = rigPosture(rigAt(2));
    expect(posture.parts.map((part) => part.part)).toEqual([
      'rodTip',
      'float',
      'sinker',
      'swivel',
      'hookUpper',
      'baitUpper',
      'hookLower',
      'baitLower',
    ]);
    for (const part of posture.parts) {
      expect(part.label.length).toBeGreaterThan(0);
      expect(part.text.length).toBeGreaterThan(0);
    }
  });

  test('摘要带上灵钝与子线形态，一眼能读懂', () => {
    const posture = rigPosture(rigAt(3));
    expect(posture.summary).toContain('钝');
    expect(posture.summary).toContain('子线');
  });
});
