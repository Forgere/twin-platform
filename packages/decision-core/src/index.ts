/**
 * decision-core —— 领域无关的决策内核。
 *
 * 它不认识"台钓"，也不认识"输送线"：领域状态、动作空间、判断与评分全部由
 * 插件的 DecisionDomain 提供。内核提供的是四件事：
 *
 * - 端口（Judge / Policy / Environment / Executor）——判断可替换；
 * - 决策循环（DecisionEngine）——判断必过策略，越界即降级；
 * - 决策日志（DecisionLog）——决策 + 状态指纹 + 事后结果，可回放；
 * - 评测（summarize / compareJudges / buildCalibration）——准确率可量化。
 *
 * 这里不依赖 MCP、不依赖 LLM SDK、不依赖 UI。
 */

export * from './types';
export * from './ports';
export * from './hash';
export * from './policy';
export * from './log';
export * from './engine';
export * from './calibration';
export * from './evaluate';
