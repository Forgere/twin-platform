/**
 * `data-source-opcua` —— OPC-UA 实时帧源。
 *
 * 车间里的 PLC / SCADA 常通过 OPC-UA 暴露实时数据。这个包把 server 上的
 * `DataChange` 翻译成内核认识的 `ExternalFrame`，与 MQTT / CSV 共用同一套换算，
 * 接入后世界在 `external` / `hybrid` 模式下直接听 OPC-UA。
 *
 * 设计要点：
 * - **可重放**：`rewind()` 后按同样顺序再喂一遍得到同样的帧序列；
 * - **可注入**：传输层是 `OpcUaConnector` 接口，测试塞假 connector 即可，无需真 server；
 * - **可选依赖**：默认传输基于 `node-opcua`，没装时只在真正连接时才报错，不影响编译与单测。
 */

export * from './transport';
export * from './source';
