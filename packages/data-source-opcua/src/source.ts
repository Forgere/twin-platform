import { BufferedFrameSource, type BufferedFrameSourceOptions } from '@twin-platform/replay-core';
import type { ExternalEntityState, ExternalFrame, TwinVector3 } from '@twin-platform/world-kernel';
import { createOpcUaTransport, type Disposer, type OpcUaConnector, type OpcUaConnectOptions, type OpcUaDataChange, type OpcUaNodeBinding } from './transport';

/**
 * OPC-UA 帧源：实现 `ExternalFrameSource`，把 server 上的实时数据变化翻译成内核帧。
 *
 * 与 MQTT 的差别在于"节点"而非"主题"：每个要监听的设备量在 `nodes` 里声明
 * `NodeId → 实体 id + 信号类型`。每次 `DataChange` 经 `mapNode` 翻译成
 * `ExternalEntityState` 入缓冲。默认 `mapNode` 覆盖两种最常见形态：
 *
 * - 节点值是数字 → `progress`（按路径长度换算弧长）；
 * - 节点值是 `{x,y,z,heading}` 或 JSON 字符串 → `pose`；
 * - `entry` → 用节点 SourceTimestamp 当进入时刻（span 需要两个节点合成，建议自定义 `mapNode`）。
 *
 * 一个 NodeId 对应一个实体的一路信号。多节点合成一个位姿（x/y/z 分属不同节点）
 * 请自行提供 `mapNode` 做聚合。
 */
export interface OpcUaFrameSourceOptions extends BufferedFrameSourceOptions {
  /** 要订阅的节点绑定。 */
  nodes: OpcUaNodeBinding[];
  /** 注入 connector（测试 / 自定义实现用）。 */
  connector?: OpcUaConnector;
  /** 真实连 server 的选项；与 `connector` 二选一。 */
  connect?: OpcUaConnectOptions;
  /** 自定义"数据变化 → 实体状态"。默认见 `defaultMapNode`。 */
  mapNode?: (change: OpcUaDataChange, binding: OpcUaNodeBinding) => ExternalEntityState | undefined;
}

export class OpcUaFrameSource extends BufferedFrameSource {
  private readonly nodes: OpcUaNodeBinding[];
  private readonly connector?: OpcUaConnector;
  private readonly connectOptions?: OpcUaConnectOptions;
  private readonly mapNode: (change: OpcUaDataChange, binding: OpcUaNodeBinding) => ExternalEntityState | undefined;

  private session?: Awaited<ReturnType<OpcUaConnector['connect']>>;
  private unsubscribe?: Disposer;

  constructor(options: OpcUaFrameSourceOptions) {
    super(options);
    if (!options.nodes || options.nodes.length === 0) throw new Error('OpcUaFrameSource 需要 nodes。');
    if (!options.connector && !options.connect) throw new Error('OpcUaFrameSource 需要 connector 或 connect 之一。');
    this.nodes = options.nodes;
    this.connector = options.connector;
    this.connectOptions = options.connect;
    this.mapNode = options.mapNode ?? defaultMapNode;
  }

  /** 连上 server、订阅节点、开始收数据变化。 */
  async connect(): Promise<void> {
    const connector = this.connector ?? (this.connectOptions ? await createOpcUaTransport(this.connectOptions) : (() => {
      throw new Error('OpcUaFrameSource 既没有 connector 也没有 connect。');
    })());
    this.session = await connector.connect();
    const byNode = new Map(this.nodes.map((node) => [node.nodeId, node]));
    this.unsubscribe = await this.session.monitor(this.nodes, (change) => {
      const binding = byNode.get(change.nodeId);
      if (!binding) return;
      const state = this.mapNode(change, binding);
      if (!state) return;
      const frame: ExternalFrame = {
        ...(change.sourceTimeSeconds > 0 ? { sourceTime: change.sourceTimeSeconds } : {}),
        entities: [state],
      };
      this.append(frame);
    });
  }

  /** 取消订阅、关闭会话。 */
  async close(): Promise<void> {
    await this.unsubscribe?.();
    await this.session?.close();
    this.session = undefined;
    this.unsubscribe = undefined;
  }
}

const num = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (value.trim() !== '' && Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

/**
 * 默认映射：节点值 → 实体状态。覆盖 progress / pose 两种最常见形态；
 * entry 用 SourceTimestamp 当进入时刻；span 退化为单点（建议自定义）。
 */
export function defaultMapNode(change: OpcUaDataChange, binding: OpcUaNodeBinding): ExternalEntityState | undefined {
  const value = change.value;

  if (binding.signal === 'progress') {
    const progress = num(value);
    if (progress === undefined) return undefined;
    return { id: binding.entityId, signal: { kind: 'progress', progress } };
  }

  if (binding.signal === 'pose') {
    let obj: Record<string, unknown> | undefined;
    if (typeof value === 'string') {
      try {
        obj = JSON.parse(value) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    } else if (value !== null && typeof value === 'object') {
      obj = value as Record<string, unknown>;
    }
    if (!obj) return undefined;
    const x = num(obj.x);
    const y = num(obj.y);
    const z = num(obj.z);
    if (x === undefined || y === undefined || z === undefined) return undefined;
    const position: TwinVector3 = [x, y, z];
    const heading = num(obj.heading);
    return {
      id: binding.entityId,
      signal: { kind: 'pose', frame: binding.frame ?? 'local', position, ...(heading !== undefined ? { heading } : {}) },
    };
  }

  if (binding.signal === 'entry') {
    return { id: binding.entityId, signal: { kind: 'entry', tEnter: change.sourceTimeSeconds } };
  }

  // span 单节点无法同时给进入/离开时刻，退化为单点；多节点聚合请用自定义 mapNode。
  if (binding.signal === 'span') {
    return { id: binding.entityId, signal: { kind: 'span', tEnter: change.sourceTimeSeconds, tExit: change.sourceTimeSeconds } };
  }

  return undefined;
}
