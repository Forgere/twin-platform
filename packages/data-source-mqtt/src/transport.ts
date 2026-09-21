/**
 * MQTT 传输层抽象。
 *
 * 把"怎么连 broker、怎么收消息"和"收到消息后怎么翻译成 `ExternalFrame`"彻底分开：
 * 帧源只认 `MqttTransport` 这个极小的接口，因此测试里可以塞一个假传输、
 * 完全不需要真 broker，真实运行时再换成 `createMqttTransport`（基于 `mqtt` 包）。
 */

export interface MqttTransport {
  /** 订阅一个主题过滤器；handler 收到具体 topic 与原始负载（字节）。 */
  subscribe(topic: string, handler: (topic: string, payload: Uint8Array) => void): void | Promise<void>;
  /** 关闭连接、释放资源（常驻进程退出时调用）。 */
  close(): void | Promise<void>;
}

export interface MqttConnectOptions {
  /** broker 地址，例如 `mqtt://localhost:1883` 或 `tls://broker.example.com:8883`。 */
  url: string;
  username?: string;
  password?: string;
  clientId?: string;
  /** 连接超时（毫秒），默认 5000；超时未连上直接报错而非无限挂起。 */
  connectTimeout?: number;
  /** 透传给 `mqtt.connect` 的额外选项（keepalive、reconnectPeriod…）。 */
  options?: Record<string, unknown>;
}

/**
 * 用 `mqtt` 包连上 broker 并返回一个 `MqttTransport`。
 *
 * `mqtt` 只在真正连 broker 时才被 import——测试路径注入假传输，永远不会触发这里，
 * 所以 `mqtt` 即便没装也不影响类型检查与单测。连接带超时：broker 不可达时
 * 快速失败（抛出带地址的错），而不是让调用方永久挂起。
 */
export async function createMqttTransport(connect: MqttConnectOptions): Promise<MqttTransport> {
  const mod = (await import('mqtt')) as unknown as {
    connect(url: string, opts?: Record<string, unknown>): MqttClientLike;
  };
  const timeoutMs = connect.connectTimeout ?? 5000;
  const client = mod.connect(connect.url, {
    username: connect.username,
    password: connect.password,
    clientId: connect.clientId,
    connectTimeout: timeoutMs,
    ...connect.options,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`MQTT 连接超时（${timeoutMs}ms 内未连上 ${connect.url}）。`));
      client.end(true);
    }, timeoutMs);
    client.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('error', (error: unknown) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  return {
    subscribe(topic, handler) {
      client.subscribe(topic);
      client.on('message', (topicName: string, payload: Uint8Array) => handler(topicName, payload));
    },
    close() {
      return new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
    },
  };
}

/** `mqtt` 暴露的客户端子集，仅列举本适配器用到的方法，避免直接依赖其类型。 */
interface MqttClientLike {
  subscribe(topic: string): void;
  on(event: 'message', handler: (topic: string, payload: Uint8Array) => void): void;
  on(event: 'connect' | 'error', handler: (value: unknown) => void): void;
  once(event: 'connect' | 'error', handler: (value: unknown) => void): void;
  end(force: boolean, opts?: Record<string, unknown>, cb?: () => void): void;
}
