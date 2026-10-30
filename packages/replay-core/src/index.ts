/**
 * `replay-core` —— 录制与时间轴回放。
 *
 * 世界内核负责"每一步算出什么"，这个包负责"怎么把它变成可回看的录像"：
 *
 * - `SessionRecorder` 把内核吐出的事件、周期快照、最新状态投影和指标写进仓储；
 * - `ReplayController` 提供播放/暂停/倍速/定位/单步，并且所有定位都靠"恢复快照 +
 *   重新推演"，而不是靠插值猜——倍速只改变一帧吃几个步长，绝不影响结果。
 *
 * 依然零 UI 依赖：浏览器、Worker 和服务端回放任务用的是同一份实现。
 */

export * from './fingerprint';
export * from './recorder';
export * from './controller';
export * from './frame-source';
