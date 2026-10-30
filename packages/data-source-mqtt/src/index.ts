/**
 * `data-source-mqtt` —— MQTT 实时帧源。
 *
 * 工厂里 MES / SCADA / PLC 常把设备实时态发到 MQTT。这个包把 broker 上的消息
 * 翻译成内核认识的 `ExternalFrame`，和 CSV 源共享同一套换算（`resolveExternalMotion`），
 * 因此接入后内核一行不用改——世界在 `external` / `hybrid` 模式下直接听 MQTT。
 *
 * 两条硬要求（与 `ExternalFrameSource` 契约一致）：
 * 1. **可重放**：`rewind()` 后按同样顺序再喂一遍得到同样的帧序列，`seek` 才靠重算；
 * 2. **可注入**：传输层是 `MqttTransport` 接口，测试塞假传输即可，无需真 broker。
 */

export * from './transport';
export * from './source';
