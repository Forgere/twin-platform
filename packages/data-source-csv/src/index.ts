/**
 * `data-source-csv` —— CSV 回放数据源。
 *
 * 工厂里最常见的数据交付物就是一张表：一行一个"某时刻某设备怎么样"。这个包把
 * 表格翻译成内核认识的 `ExternalFrame`，中间不夹任何业务语义——
 * 换算全部由 `resolveExternalMotion` 这一个纯函数完成（见 `world-kernel/external`）。
 *
 * 两条硬要求：
 * 1. **确定性**：解析结果只取决于文件内容，排序按 (时间, 原始行号)，
 *    不读挂钟、不摇随机数，因此同一份 CSV 永远喂出同一串帧；
 * 2. **可重放**：`rewind()` 之后能按同样顺序再喂一遍，`seek` 才可能靠重算而不是插值。
 */

export * from './parse';
export * from './source';
