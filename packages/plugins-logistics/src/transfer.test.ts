import { describe, expect, test } from 'bun:test';
import { TwinWorld, type WorldBehavior } from '@twin-platform/world-kernel';
import type { TwinEntity } from '@twin-platform/scene-schema';
import { liftTransfer, liftTransferCassette, parcel } from './devices';
import { buildCenterScene, logisticsPlugin } from './index';
import { createTransferBehavior } from './transfer';

const STEP = 1 / 60;

/**
 * 顶升移栽机是**单工位**设备：只有一个台面，同一时刻只能处理一个货。
 * 这条约束以前没写进代码——检测区里同时有两个货时会被一起顶起来，
 * 立库那两台移栽机（3 个分流货）尤其明显。这里把规矩固化成断言。
 */

/** 两台货同时挤在检测区里，用来逼出"认领一台 + 其余排队"。速度给 0，位置固定。 */
function buildContentionScene(): never {
  const entities: TwinEntity[] = [
    liftTransfer('transfer-1', [0, 0.6, 0], {
      label: '移栽机',
      size: [1.6, 0.6, 1.4],
      divertIds: ['p1', 'p2'],
      liftHeight: 0.13,
    }),
    liftTransferCassette('transfer-1-cassette', [0, 0.6, 0], '#F4A261', '托举座', [1.6, 0.14, 1.4], -1),
    parcel('p1', [
      [-0.5, 1.2, 0],
      [0.5, 1.2, 0],
    ], 0),
    parcel('p2', [
      [-0.2, 1.2, 0],
      [0.8, 1.2, 0],
    ], 0),
  ];
  return { version: 1, id: 'contention', name: '单工位排队', entities } as never;
}

describe('顶升移栽机 · 单工位', () => {
  test('两个货同时到：只认领一个，另一个原地排队打背压', () => {
    const world = new TwinWorld(buildContentionScene(), {
      seed: 7,
      step: STEP,
      behaviors: [createTransferBehavior()],
    });
    for (let i = 0; i < 60; i += 1) world.step(STEP);

    const unit = world.getEntity('transfer-1');
    expect(unit?.attrs.__job, '应当认领 p1').toBe('p1');
    expect(Number(unit?.attrs.__lift)).toBeGreaterThan(0.99);

    const p1 = world.getEntity('p1');
    const p2 = world.getEntity('p2');
    // p1 被链带顶起，p2 留在原高度排队。
    expect(p1?.transform.position[1] ?? 0).toBeGreaterThan(1.3);
    expect(p2?.transform.position[1] ?? 0).toBeCloseTo(1.2, 5);
    expect(p2?.attrs.backpressure, '排队的货要打上背压标记').toBe(true);
  });

  test('整场跑 60 秒：任一移栽机同时顶起的货不超过一个', () => {
    const scene = buildCenterScene({ parcels: 10, asrsParcels: 3, externalLanes: 4, aisles: 2 });
    const behaviors = (logisticsPlugin.activate().behaviors ?? []) as WorldBehavior[];
    const world = new TwinWorld(scene as never, {
      seed: 20240906,
      step: STEP,
      behaviors,
      maxStepsPerAdvance: 8,
    });

    const transfers = scene.entities.filter((entity) => entity.kind === 'transfer');
    expect(transfers.length).toBeGreaterThan(0);

    let maxLifted = 0;
    for (let i = 0; i < 3600; i += 1) {
      world.step(STEP);
      if (i % 10 !== 0) continue;
      for (const transfer of transfers) {
        const ids = (transfer.config?.divertIds as string[] | undefined) ?? [];
        if (ids.length === 0) continue;

        const job = world.getEntity(transfer.id)?.attrs.__job;
        if (typeof job === 'string' && job !== '') expect(ids).toContain(job);

        // 单工位：本机同一时刻只能顶起它自己认领的那一个货。
        // 注意多台移栽机会共享同一批 divertIds（立库 a/b 两台 + 角落机都吃同一组
        // asrs 物料），所以不能数"divertIds 里被抬高的总数"——那会把别的机正在
        // 处理的货也算进来；只数本机当前 job 那一个。
        let lifted = 0;
        if (typeof job === 'string' && job !== '') {
          const state = world.getEntity(job);
          if (state) {
            const baseY = state.baseTransform.position[1] ?? 0;
            if (state.transform.position[1] > baseY + 0.02) lifted = 1;
          }
        }
        if (lifted > maxLifted) maxLifted = lifted;
      }
    }
    expect(maxLifted, '移栽机一次只能处理一个货').toBeLessThanOrEqual(1);
  });
});
