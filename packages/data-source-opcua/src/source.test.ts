import { describe, expect, test } from 'bun:test';
import type { TwinScene } from '@twin-platform/scene-schema';
import { TwinWorld } from '@twin-platform/world-kernel';
import { OpcUaFrameSource, type OpcUaConnector, type OpcUaDataChange, type OpcUaNodeBinding, type OpcUaSession } from './source';

const STEP = 1 / 60;

const scene: TwinScene = {
  version: 1,
  id: 'opcua-line',
  name: 'OPC-UA 测试产线',
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

function advanceTo(world: TwinWorld, source: OpcUaFrameSource, target: number): void {
  while (world.time < target - 1e-9) {
    source.feedTo(world, world.time + STEP);
    world.step(STEP);
  }
}

/** 假 server：记录 monitor handler，测试直接 `emit` 灌数据变化。 */
class FakeSession implements OpcUaSession {
  private handler: ((change: OpcUaDataChange) => void) | undefined;

  async monitor(_nodes: OpcUaNodeBinding[], handler: (change: OpcUaDataChange) => void): Promise<() => void> {
    this.handler = handler;
    return async () => {
      this.handler = undefined;
    };
  }

  async close(): Promise<void> {
    this.handler = undefined;
  }

  emit(nodeId: string, value: unknown, sourceTimeSeconds: number): void {
    this.handler?.({ nodeId, value, sourceTimeSeconds });
  }
}

class FakeConnector implements OpcUaConnector {
  readonly session = new FakeSession();

  async connect(): Promise<OpcUaSession> {
    return this.session;
  }
}

describe('OpcUaFrameSource / 实时帧接入', () => {
  test('pose 节点值（对象）驱动外部实体位姿', async () => {
    const connector = new FakeConnector();
    const source = new OpcUaFrameSource({
      nodes: [{ nodeId: 'ns=2;s=Cargo1.Pose', entityId: 'cargo-01', signal: 'pose', frame: 'world' }],
      connector,
    });
    await source.connect();

    connector.session.emit('ns=2;s=Cargo1.Pose', { x: 3, y: 1, z: 2 }, 0.2);

    const world = buildWorld();
    advanceTo(world, source, 0.25);
    expect(world.getEntity('cargo-01')?.transform.position).toEqual([3, 1, 2]);
  });

  test('progress 节点值（数字）按路径长度换算弧长', async () => {
    const connector = new FakeConnector();
    const source = new OpcUaFrameSource({
      nodes: [{ nodeId: 'ns=2;s=Cargo1.Progress', entityId: 'cargo-01', signal: 'progress' }],
      connector,
    });
    await source.connect();

    connector.session.emit('ns=2;s=Cargo1.Progress', 0.5, 0.1);

    const world = buildWorld();
    advanceTo(world, source, 0.15);
    // 路径长度 9，progress 0.5 → 弧长 4.5
    expect(world.getEntity('cargo-01')?.transform.position[0]).toBeCloseTo(4.5, 6);
  });

  test('entry 节点用 SourceTimestamp 当进入时刻', async () => {
    const connector = new FakeConnector();
    const source = new OpcUaFrameSource({
      nodes: [{ nodeId: 'ns=2;s=Cargo1.Entry', entityId: 'cargo-01', signal: 'entry' }],
      connector,
    });
    await source.connect();

    connector.session.emit('ns=2;s=Cargo1.Entry', 1, 0);

    const world = buildWorld();
    advanceTo(world, source, 1); // 跑满 1 秒
    // distance = (1 - 0) * speed(1) = 1
    expect(world.getEntity('cargo-01')?.transform.position[0]).toBeCloseTo(1, 6);
  });

  test('rewind 后重放得到一致结果（确定性）', async () => {
    const connector = new FakeConnector();
    const source = new OpcUaFrameSource({
      nodes: [{ nodeId: 'ns=2;s=Cargo1.Pose', entityId: 'cargo-01', signal: 'pose', frame: 'world' }],
      connector,
    });
    await source.connect();
    connector.session.emit('ns=2;s=Cargo1.Pose', { x: 3, y: 1, z: 2 }, 0.2);

    const first = buildWorld();
    advanceTo(first, source, 0.25);
    const fingerprint = first.getEntity('cargo-01')?.transform.position;

    source.rewind();
    const second = buildWorld();
    advanceTo(second, source, 0.25);
    expect(second.getEntity('cargo-01')?.transform.position).toEqual(fingerprint);
  });

  test('未绑定的 nodeId 被忽略', async () => {
    const connector = new FakeConnector();
    const source = new OpcUaFrameSource({
      nodes: [{ nodeId: 'ns=2;s=Cargo1.Pose', entityId: 'cargo-01', signal: 'pose', frame: 'world' }],
      connector,
    });
    await source.connect();

    connector.session.emit('ns=2;s=Other.Node', { x: 99, y: 0, z: 0 }, 0.2);
    expect(source.size).toBe(0);
  });
});
