import type { MetricDescriptor } from '@twin-platform/plugin-sdk';

/**
 * 物流产线指标描述符。
 *
 * 描述符只声明"这个指标吃哪些事件、怎么聚"，真正计算在 `analytics-core`。
 * 吞吐直接数 `parcel:exit`；设备忙碌时长数 `entity:status` 里 status=busy 的区间。
 *
 * 积压 / 利用率 / 停机这三项和"进出配对""状态区间"强相关，由 `analytics-core`
 * 的 `lineMetrics` 一次性算全（见 Studio 的对比面板），不在这里用单描述符表达。
 */
export const lineMetricsDescriptors: readonly MetricDescriptor[] = [
  {
    id: 'throughput',
    label: '吞吐',
    unit: '件/分',
    eventTypes: ['parcel:exit'],
    aggregation: 'count',
  },
  {
    id: 'busy-duration',
    label: '设备忙碌时长',
    unit: 's',
    eventTypes: ['entity:status'],
    aggregation: 'duration',
    valueKey: 'busy',
    groupByEntity: true,
  },
];
