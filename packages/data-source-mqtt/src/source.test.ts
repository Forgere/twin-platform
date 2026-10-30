import { describe, expect, test } from 'bun:test';
import type { TwinScene } from '@twin-platform/scene-schema';
import { TwinWorld } from '@twin-platform/world-kernel';
import { MqttFrameSource, type MqttTransport } from './source';

const STEP = 1 / 60;

const scene: TwinScene = {
  version: 1,
  id: 'mqtt-line',
  name: 'MQTT 测试产线',
  entities: [
    {
      id: 'cargo-01',
      kind: 'parcel',
      transform: { position: [0, 1, 0] },
      capabilities: ['move'],
      motion: { points: [[0, 1, 0], [9, 1, 0]], speed: 1, loop: 'repeat' },
    },
  ],
};

const buildWorld = (): TwinWorld => new TwinWorld(scene, { seed: 1, mode: 'external' });

const enc = (record: Record<string, unknown>): Uint8Array => new TextEncoder().encode(JSON.stringify(record));

/** 复刻 `ReplayController.runStepsWithSource`：每步先喂到 `world.time+STEP`，再 step。 */
function advanceTo(world: TwinWorld, source: MqttFrameSource, target: number): void {
  while (world.time < target - 1e-9) {
    source.feedTo(world, world.time + STEP);
    world.step(STEP);
  }
}

/** 假传输：记录 handler，测试直接 `publish` 灌消息，无需真 broker。 */
class FakeMqttTransport implements MqttTransport {
  private handler: ((topic: string, payload: Uint8Array) => void) | undefined;

  subscribe(_topic: string, handler: (topic: string, payload: Uint8Array) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.handler = undefined;
  }

  publish(topic: string, payload: Uint8Array): void {
    this.handler?.(topic, payload);
  }
}

describe('MqttFrameSource / 实时帧接入', () => {
  test('pose 消息被翻译并驱动外部实体位姿', async () => {
    const transport = new FakeMqttTransport();
    const source = new MqttFrameSource({ topic: 'twin/+/+', transport });
    await source.connect();

    transport.publish('twin/factory/cargo-01', enc({ t: 0.1, id: 'cargo-01', signal: 'pose', frame: 'world', x: 2 }));
    transport.publish('twin/factory/cargo-01', enc({ t: 0.2, id: 'cargo-01', signal: 'pose', frame: 'world', x: 4 }));
    transport.publish('twin/factory/cargo-01', enc({ t: 0.3, id: 'cargo-01', signal: 'pose', frame: 'world', x: 6 }));

    const world = buildWorld();
    advanceTo(world, source, 0.35);

    expect(world.getEntity('cargo-01')?.transform.position[0]).toBeCloseTo(6, 6);
    expect(source.size).toBe(3);
    expect(source.fedCount).toBe(3);
  });

  test('rewind 后重放得到一致结果（确定性）', async () => {
    const transport = new FakeMqttTransport();
    const source = new MqttFrameSource({ topic: 'twin/+/+', transport });
    await source.connect();

    transport.publish('twin/factory/cargo-01', enc({ t: 0.1, id: 'cargo-01', signal: 'pose', frame: 'world', x: 2 }));
    transport.publish('twin/factory/cargo-01', enc({ t: 0.2, id: 'cargo-01', signal: 'pose', frame: 'world', x: 4 }));
    transport.publish('twin/factory/cargo-01', enc({ t: 0.3, id: 'cargo-01', signal: 'pose', frame: 'world', x: 6 }));

    const first = buildWorld();
    advanceTo(first, source, 0.35);
    const fingerprint1 = first.getEntity('cargo-01')?.transform.position[0];

    // 换个全新的世界，rewind 后从 0 重放
    source.rewind();
    const second = buildWorld();
    advanceTo(second, source, 0.35);

    expect(second.getEntity('cargo-01')?.transform.position[0]).toBeCloseTo(fingerprint1 ?? 0, 6);
  });

  test('payload 缺 id 时从 topic 末段反推实体 id', async () => {
    const transport = new FakeMqttTransport();
    const source = new MqttFrameSource({ topic: 'twin/factory/+', transport });
    await source.connect();

    // 末段是 agv-09，payload 不带 id
    transport.publish('twin/factory/agv-09', enc({ t: 0.5, signal: 'pose', frame: 'world', x: 7, y: 0, z: 0 }));

    const world = buildWorld();
    advanceTo(world, source, 0.55);

    const entity = world.getEntity('agv-09');
    expect(entity?.transform.position[0]).toBeCloseTo(7, 6);
    expect(entity?.dataSource).toBe('external');
  });

  test('非法 JSON 直接丢弃，不污染 buffer', async () => {
    const transport = new FakeMqttTransport();
    const source = new MqttFrameSource({ topic: 'twin/#', transport });
    await source.connect();

    transport.publish('twin/factory/cargo-01', new TextEncoder().encode('not-json{{'));
    expect(source.size).toBe(0);
  });

  test('payload 无 id 且 topic 解析器也返回 undefined 时整条丢弃', async () => {
    const transport = new FakeMqttTransport();
    const source = new MqttFrameSource({
      topic: 'twin/+/+',
      transport,
      // 自定义解析器明确返回 undefined：既无 payload id 也无 topic id → 丢弃
      entityIdFromTopic: () => undefined,
    });
    await source.connect();

    transport.publish('twin/factory/cargo-01', enc({ t: 0.1, signal: 'pose', frame: 'world', x: 1 }));
    expect(source.size).toBe(0);
  });
});
