/**
 * live-twin —— MQTT 常驻孪生进程示例。
 *
 * 这就是"有了常驻进程才谈得上做 MQTT/OPC-UA Adapter"里那个常驻进程的最小示范：
 * 加载场景 → 建 `external` 模式世界 → 挂 `MqttFrameSource` → 每帧 `advance`。
 * 不需要浏览器、不需要 Studio，纯服务端进程把实时数据喂进内核。
 *
 * 运行：
 *   MQTT_URL=mqtt://localhost:1883 MQTT_TOPIC=twin/+/+ \
 *   TWIN_LIVE_SCENE=scenes/demo.json bun run live:mqtt
 *
 * - 不传 `TWIN_LIVE_SCENE` 时用内置 demo 场景；
 * - 不传 `MQTT_URL` 时尝试连本地 broker，连不上仅告警、世界保持空闲（不崩）；
 * - 想换成 OPC-UA：把 `MqttFrameSource` 换成 `OpcUaFrameSource`（`@twin-platform/data-source-opcua`），
 *   `connect` 改填 `{ endpoint }`，`nodes` 填 NodeId 绑定即可，其余循环不变。
 */
import { readFileSync } from 'node:fs';
import { parseSceneDocument, type TwinScene } from '@twin-platform/scene-schema';
import { TwinWorld } from '@twin-platform/world-kernel';
import { createMemoryStorage } from '@twin-platform/storage-memory';
import { ReplayController } from '@twin-platform/replay-core';
import { MqttFrameSource } from '@twin-platform/data-source-mqtt';

const DEMO_SCENE: TwinScene = {
  version: 1,
  id: 'live-demo',
  name: 'MQTT 常驻孪生 Demo',
  entities: [
    { id: 'belt-01', kind: 'transport', transform: { position: [0, 0, 0] }, capabilities: ['move'] },
    {
      id: 'cargo-01',
      kind: 'parcel',
      transform: { position: [0, 1, 0] },
      capabilities: ['move'],
      motion: { points: [[0, 1, 0], [9, 1, 0]], speed: 1.5, loop: 'repeat' },
    },
    {
      id: 'cargo-02',
      kind: 'parcel',
      transform: { position: [0, 1, 3] },
      capabilities: ['move'],
      motion: { points: [[0, 1, 3], [9, 1, 3]], speed: 1.2, loop: 'repeat' },
    },
  ],
};

function loadScene(): TwinScene {
  const path = process.env.TWIN_LIVE_SCENE;
  if (!path) return DEMO_SCENE;
  const parsed = parseSceneDocument(readFileSync(path, 'utf8'));
  if (!parsed.ok || !parsed.scene) {
    throw new Error(`场景校验失败：${JSON.stringify(parsed.issues)}`);
  }
  return parsed.scene;
}

const STEP = 1 / 60;

async function main(): Promise<void> {
  const scene = loadScene();
  console.log(`[live-twin] 启动：模式 external，场景 ${scene.id}，实体数 ${scene.entities.length}`);
  // external 模式：世界只听外部数据，内核不做推演（没数据的设备就停着）。
  const world = new TwinWorld(scene, { seed: 1, mode: 'external', maxStepsPerAdvance: 600 });
  const storage = createMemoryStorage();

  const source = new MqttFrameSource({
    topic: process.env.MQTT_TOPIC ?? 'twin/+/+',
    connect: { url: process.env.MQTT_URL ?? 'mqtt://localhost:1883', clientId: `twin-live-${Date.now()}` },
    // 消息没带时间字段时，按到达时刻补 sourceTime，确保直播模式下帧能按时被喂出。
    assignArrivalTime: true,
  });

  const controller = new ReplayController({ world, storage, source });

  try {
    await source.connect();
    console.log(`[live-twin] MQTT 已连接：${process.env.MQTT_URL ?? 'mqtt://localhost:1883'}（主题 ${source.subscribedTopic}）`);
  } catch (error) {
    console.warn('[live-twin] MQTT 连接失败，世界将保持空闲：', error instanceof Error ? error.message : error);
  }

  controller.play(1);

  let lastLog = 0;
  const tick = (): void => {
    try {
      const start = performance.now();
      // advance 自带余量累加：16ms @ 1× 大约每两帧补一步，不会丢进度。
      controller.advance(STEP);
      if (performance.now() - lastLog > 1000) {
        lastLog = performance.now();
        const sample = world
          .listEntities()
          .slice(0, 6)
          .map((entity) => `${entity.id}=[${entity.transform.position.map((n) => n.toFixed(2)).join(',')}]`)
          .join(' ');
        console.log(`[live-twin] t=${world.time.toFixed(1)}s 缓冲=${source.size} 已喂=${source.fedCount} | ${sample}`);
      }
      setTimeout(tick, Math.max(0, STEP * 1000 - (performance.now() - start)));
    } catch (error) {
      console.error('[live-twin] tick 出错：', error);
      process.exit(1);
    }
  };
  tick();

  const shutdown = async (): Promise<void> => {
    await source.close();
    console.log('\n[live-twin] 已关闭，退出。');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
