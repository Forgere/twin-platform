/**
 * `analytics-core` —— 窗口聚合与指标计算。
 *
 * 输入只有事件流，输出只有数字：不看世界状态、不读挂钟、不碰 UI。
 * 因此同一段历史在浏览器、回放任务和 CI 里算出来的结果完全一致，
 * 两个方案的差异才有可比性。
 *
 * 指标语义由插件声明（`MetricDescriptor`），计算统一在这里——
 * 免得每个插件各写一套"吞吐"，比较的时候口径对不上。
 */

export * from './metrics';
export * from './status';
export * from './window';
