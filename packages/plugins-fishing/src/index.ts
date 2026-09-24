/**
 * plugins-fishing —— 漂语（台钓）领域插件。
 *
 * 领域语义全部在这里：调钓计算、动作空间、规则判断、评分。
 * 决策内核（decision-core）不认识台钓，世界内核（world-kernel）也不认识台钓。
 *
 * 阶段 0/1 只覆盖纯计算 + 规则基线；场景、行为、Jev、面板在后续阶段接入。
 */

export * from './fishingCore';
export * from './presets';
export * from './loadout';
export * from './conditions';
export * from './assistant';
export * from './wizard';
export * from './actionSpace';
export * from './state';
export * from './ruleJudge';
export * from './domain';
export * from './fishSim';
export * from './rigPhase';
export * from './template';
export * from './rigPosture';
export * from './environment';
export * from './evaluator';
export * from './jevQuestions';
export * from './jevClient';
export * from './judges/jev';
export * from './plugin';
