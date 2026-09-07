/**
 * `plugin-sdk` —— 插件契约与宿主。
 *
 * 内核不认识"输送线"，Studio 不认识"物流指标"，两边都只认识这里的接口。
 * 插件贡献行为、指标、面板和场景模板；宿主负责校验、装配和故障隔离。
 */

export * from './manifest';
export * from './registry';
export * from './schema';
