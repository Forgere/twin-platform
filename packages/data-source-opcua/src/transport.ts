/**
 * OPC-UA 传输层抽象。
 *
 * 与 MQTT 一样，把"怎么连 server、怎么收数据变化"和"怎么翻译成 `ExternalFrame`"
 * 分开。这里的最小接口是 `OpcUaConnector` / `OpcUaSession` / `monitor`：
 * 帧源只认它，测试塞一个假 connector 即可，真实运行时用 `createOpcUaTransport`
 * （基于可选依赖 `node-opcua`）。
 */

/** 一个节点的映射声明：把某个 NodeId 绑定到场景里的某个实体的某个信号。 */
export interface OpcUaNodeBinding {
  /** OPC-UA NodeId，例如 `ns=2;s=Line1.Cargo1.Pose`。 */
  nodeId: string;
  /** 该节点数据要驱动的场景实体 id。 */
  entityId: string;
  /** 信号类型（与 `ExternalSignal` 对齐）。 */
  signal: 'pose' | 'progress' | 'entry' | 'span';
  /** 仅 `pose` 使用；默认 `local`。 */
  frame?: 'world' | 'local';
}

/** 一次数据变化事件。 */
export interface OpcUaDataChange {
  nodeId: string;
  /** 节点当前值（`DataValue.value.value`），类型取决于节点。 */
  value: unknown;
  /** 节点 SourceTimestamp（Unix 秒）；用于 `entry` 信号的进入时刻。 */
  sourceTimeSeconds: number;
}

/** 取消订阅 / 释放资源的函数，可同步或异步。 */
export type Disposer = () => void | Promise<void>;

export interface OpcUaSession {
  /** 订阅一组节点，返回取消订阅的函数。 */
  monitor(nodes: OpcUaNodeBinding[], handler: (change: OpcUaDataChange) => void): Promise<Disposer>;
  /** 关闭会话与底层连接。 */
  close(): Promise<void>;
}

export interface OpcUaConnector {
  connect(): Promise<OpcUaSession>;
}

export interface OpcUaConnectOptions {
  /** server 端点，例如 `opc.tcp://localhost:4840`。 */
  endpoint: string;
  username?: string;
  password?: string;
  /** 安全策略；默认 `None`，生产环境应改为 `Basic256Sha256` 等。 */
  securityPolicy?: string;
  /** 注入一个 connector（测试 / 自定义实现用）。优先级最高。 */
  connector?: OpcUaConnector;
}

/**
 * 取得一个 `OpcUaConnector`。
 *
 * - 给了 `connector` 直接用（测试 / 自定义传输）；
 * - 否则懒加载 `node-opcua` 连真 server。`node-opcua` 是**可选**依赖，没装时
 *   这里抛带安装指引的错，而不是让整个包在 import 阶段崩。
 */
export async function createOpcUaTransport(options: OpcUaConnectOptions): Promise<OpcUaConnector> {
  if (options.connector) return options.connector;
  return nodeOpcUaConnector(options);
}

async function nodeOpcUaConnector(options: OpcUaConnectOptions): Promise<OpcUaConnector> {
  // `node-opcua` 是可选依赖：没装时给出明确指引，而不是让类型检查或启动崩溃。
  // @ts-ignore 可选依赖，未安装时模块解析失败是预期内的，运行时再报清楚。
  const mod = (await import('node-opcua')) as unknown as NodeOpcUaModule;
  const { OPCUAClient, AttributeIds, ClientMonitoredItem, TimestampsToReturn, MessageSecurityMode, MessageSecurityPolicy } = mod;

  return {
    async connect() {
      const client = OPCUAClient.create({
        endpointUrl: options.endpoint,
        securityMode: MessageSecurityMode?.None ?? 1,
        securityPolicy: options.securityPolicy ?? MessageSecurityPolicy?.None ?? 'http://opcfoundation.org/UA/SecurityPolicy#None',
        userName: options.username,
        password: options.password,
      });
      await client.connect(options.endpoint);
      const userIdentity =
        options.username !== undefined ? { userName: options.username, password: options.password ?? '' } : undefined;
      const session = await client.createSession(userIdentity);

      return {
        async monitor(nodes, handler) {
          const subscription = await session.createSubscription({
            requestedPublishingInterval: 100,
            requestedLifetimeCount: 1000,
            requestedMaxKeepAliveCount: 10,
            publishingEnabled: true,
          });
          for (const node of nodes) {
            const itemToMonitor = { nodeId: node.nodeId, attributeId: AttributeIds.Value };
            const parameters = { samplingInterval: 100, discardOldest: true, queueSize: 1 };
            ClientMonitoredItem.create(
              subscription,
              itemToMonitor,
              parameters,
              TimestampsToReturn.Both,
              (dataValue: { value?: { value?: unknown }; sourceTimestamp?: Date }) => {
                handler({
                  nodeId: node.nodeId,
                  value: dataValue.value?.value,
                  sourceTimeSeconds: dataValue.sourceTimestamp ? dataValue.sourceTimestamp.getTime() / 1000 : 0,
                });
              },
            );
          }
          return async () => {
            await subscription.terminate();
          };
        },
        async close() {
          await session.close();
          await client.disconnect();
        },
      };
    },
  };
}

/**
 * `node-opcua` 暴露的 API 子集（仅本适配器用到的方法），避免直接依赖其完整类型。
 * 真实类型在 `node-opcua` 安装后由运行时提供；这里只描述形状，使未安装时也能编译。
 */
interface NodeOpcUaModule {
  OPCUAClient: {
    create(opts: Record<string, unknown>): {
      connect(endpoint: string): Promise<void>;
      createSession(identity?: unknown): Promise<{
        createSubscription(opts: Record<string, unknown>): Promise<{
          terminate(): Promise<void>;
          monitor?(item: unknown): void;
        }>;
        close(): Promise<void>;
      }>;
      disconnect(): Promise<void>;
    };
  };
  AttributeIds: { Value: number };
  ClientMonitoredItem: {
    create(
      subscription: unknown,
      itemToMonitor: unknown,
      parameters: unknown,
      timestamps: unknown,
      onChanged: (dataValue: { value?: { value?: unknown }; sourceTimestamp?: Date }) => void,
    ): void;
  };
  TimestampsToReturn: { Both: unknown };
  MessageSecurityMode: { None: number } | undefined;
  MessageSecurityPolicy: { None: string } | undefined;
}
