import { BufferedFrameSource, toExternalFrame, type BufferedFrameSourceOptions, type EntityStateMappingOptions } from '@twin-platform/replay-core';
import type { ExternalFrame } from '@twin-platform/world-kernel';
import { createMqttTransport, type MqttConnectOptions, type MqttTransport } from './transport';

/**
 * MQTT 帧源：实现 `ExternalFrameSource`，把 broker 上的实时消息翻译成内核帧。
 *
 * 用法分两层：
 *
 * 1. **协议连接**：`connect` 选项（broker 地址）→ 运行时用 `mqtt` 连上；
 *    或 `transport` 选项（注入 `MqttTransport`）→ 测试 / 自定义传输用。
 * 2. **消息翻译**：每收到一条消息，先 `parse` 成 JSON 记录（默认 UTF-8 JSON），
 *    再用 `toExternalFrame` 映射成 `ExternalFrame`，必要时从 topic 补实体 id、
 *    用到达时刻补 `sourceTime`，最后 `append` 入缓冲。
 *
 * 订阅是"一次性"的：构造时给定 `topic` 过滤器，连上后只订阅这一个。多主题请用一个
 * 通配过滤器（如 `twin/+/+`）并在 `parse` / `entityIdFromTopic` 里区分。
 */
export interface MqttFrameSourceOptions extends BufferedFrameSourceOptions {
  /** 订阅的主题过滤器，例如 `twin/+/+` 或 `factory/line-1/#`。 */
  topic: string;
  /**
   * 注入一个传输层（测试 / 自定义实现用）。与 `connect` 二选一；
   * 都不给则在 `connect()` 时抛错。
   */
  transport?: MqttTransport;
  /** 真实连 broker 的选项；与 `transport` 二选一。 */
  connect?: MqttConnectOptions;
  /** 原始字节 → JSON 记录。默认 UTF-8 `JSON.parse`，解析失败整条丢弃。 */
  parse?: (payload: Uint8Array) => Record<string, unknown> | undefined;
  /** payload 没带 id 时，从具体 topic 反推实体 id；默认取 path 末段。 */
  entityIdFromTopic?: (topic: string) => string | undefined;
  /**
   * payload 不含时间字段时，用"相对连接时刻的单调秒数"补 `sourceTime`。
   * 不设这个开关则缺时间的帧 `sourceTime` 为 undefined，会被立即喂出（适合纯直播）。
   */
  assignArrivalTime?: boolean;
  /** 透传给 `toExternalFrame` 的映射选项（默认坐标系、键名…）。 */
  mapping?: EntityStateMappingOptions;
}

const defaultParse = (payload: Uint8Array): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const defaultEntityIdFromTopic = (topic: string): string | undefined => {
  const parts = topic.split('/');
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : undefined;
};

export class MqttFrameSource extends BufferedFrameSource {
  private readonly topic: string;
  private readonly providedTransport?: MqttTransport;
  private readonly connectOptions?: MqttConnectOptions;
  private readonly parse: (payload: Uint8Array) => Record<string, unknown> | undefined;
  private readonly entityIdFromTopic: (topic: string) => string | undefined;
  private readonly assignArrivalTime: boolean;
  private readonly mapping?: EntityStateMappingOptions;

  private resolved?: MqttTransport;
  private startNs?: number;

  constructor(options: MqttFrameSourceOptions) {
    super(options);
    if (!options.topic) throw new Error('MqttFrameSource 需要 topic。');
    if (!options.transport && !options.connect) throw new Error('MqttFrameSource 需要 transport 或 connect 之一。');
    this.topic = options.topic;
    this.providedTransport = options.transport;
    this.connectOptions = options.connect;
    this.parse = options.parse ?? defaultParse;
    this.entityIdFromTopic = options.entityIdFromTopic ?? defaultEntityIdFromTopic;
    this.assignArrivalTime = options.assignArrivalTime ?? false;
    this.mapping = options.mapping;
  }

  /** 订阅主题、开始收消息。常驻进程启动和重连时调用。 */
  async connect(): Promise<void> {
    if (!this.resolved) {
      this.resolved =
        this.providedTransport ??
        (this.connectOptions ? await createMqttTransport(this.connectOptions) : (() => {
          throw new Error('MqttFrameSource 既没有 transport 也没有 connect。');
        })());
    }
    this.startNs = performance.now();
    await this.resolved.subscribe(this.topic, (topic, payload) => this.onMessage(topic, payload));
  }

  /** 关闭连接，释放资源。 */
  async close(): Promise<void> {
    await this.resolved?.close();
    this.resolved = undefined;
  }

  /** 当前订阅的主题过滤器。 */
  get subscribedTopic(): string {
    return this.topic;
  }

  private onMessage(topic: string, payload: Uint8Array): void {
    const record = this.parse(payload);
    if (!record) return;

    let enriched = record;
    if (record.id === undefined && record.entity === undefined) {
      const id = this.entityIdFromTopic(topic);
      if (id) enriched = { ...record, id };
    }

    const frame = toExternalFrame(enriched, this.mapping);
    if (!frame) return;
    if (frame.sourceTime === undefined && this.assignArrivalTime) {
      frame.sourceTime = this.clock();
    }
    this.append(frame as ExternalFrame);
  }

  private clock(): number {
    if (this.startNs === undefined) this.startNs = performance.now();
    return (performance.now() - this.startNs) / 1000;
  }
}
