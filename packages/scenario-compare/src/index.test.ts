import { describe, expect, test } from 'bun:test';
import { createLogisticsBehavior, buildLineScene } from '@twin-platform/plugins-logistics';
import { compareScenarios } from './index';

const scene = buildLineScene({ parcels: 5, length: 20 }) as never;

describe('方案分叉与比对', () => {
  test('同种子、不同检测区宽度 → 吞吐一致、忙碌时长随区宽减小', () => {
    const wide = createLogisticsBehavior(); // 用设备声明的 1.6m
    const narrow = createLogisticsBehavior({ zoneHalfWidth: 0.5 });

    const diff = compareScenarios({
      scene,
      forkAt: 0,
      horizon: 20,
      variants: [
        { id: 'wide', label: '宽检测区', behaviors: [wide] },
        { id: 'narrow', label: '窄检测区', behaviors: [narrow] },
      ],
    });

    const byId = Object.fromEntries(diff.metricDeltas.map((metric) => [metric.id, metric]));
    // 包裹流完全一样：吞吐与末态积压不变。
    expect(byId.throughput.delta).toBe(0);
    expect(byId.backlog.delta).toBe(0);
    // 窄检测区 → 设备看到包裹的窗口更短 → 累计忙碌时长更短（delta < 0）。
    expect(byId.busy.delta).toBeLessThan(0);

    // 包裹进出事件数量两路一致，状态事件数量随区宽变化。
    const enterA = diff.eventDeltas.find((metric) => metric.id === 'parcel:enter');
    expect(enterA?.delta).toBe(0);
    const statusDelta = diff.eventDeltas.find((metric) => metric.id === 'entity:status');
    expect(statusDelta?.delta).not.toBe(0);
  });

  test('从 t=5 分叉也能确定性比对，且同输入两次结果逐字节一致', () => {
    const inputs = () => ({
      scene,
      forkAt: 5,
      horizon: 15,
      variants: [
        { id: 'A', behaviors: [createLogisticsBehavior()] },
        { id: 'B', behaviors: [createLogisticsBehavior({ zoneHalfWidth: 0.5 })] },
      ],
    });
    const first = JSON.stringify(compareScenarios(inputs()));
    const second = JSON.stringify(compareScenarios(inputs()));
    expect(first).toBe(second);
  });
});
