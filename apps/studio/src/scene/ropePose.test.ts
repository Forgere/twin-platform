import { expect, test } from 'vitest';
import { Rope, type RopeForces } from './rope';

const water: RopeForces = { gravity: -1.2, current: [1.5, 0, 0], surfaceY: 2, floorY: 0.08 };

test('钓线无历史采样：同一挂点即同一曲线，不受此前 step 的帧间隔或惯性影响', () => {
  const fresh = new Rope();
  const replayed = new Rope();
  fresh.pose([0, 1.5, 0], [0.2, 0.4, 0.1], 1.4, water);
  for (const dt of [1 / 240, 0.05, 0.2, 0]) replayed.step([1, 1.5, 0.5], [-0.2, 0.3, 0], 2.1, dt, water);
  replayed.pose([0, 1.5, 0], [0.2, 0.4, 0.1], 1.4, water);
  expect(replayed.nodes).toEqual(fresh.nodes);
  replayed.pose([0, 1.5, 0], [0.2, 0.4, 0.1], 1.4, water);
  expect(replayed.nodes).toEqual(fresh.nodes);
  expect(replayed.point(0)).toEqual([0, 1.5, 0]);
  expect(replayed.point(12)).toEqual([0.2, 0.4, 0.1]);
});
