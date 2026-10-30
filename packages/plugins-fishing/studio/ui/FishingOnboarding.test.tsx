import { flush } from 'solid-js';
import { cleanup, fireEvent, render, within } from '@solidjs/testing-library';
import { afterEach, expect, test } from 'vitest';
import { TwinWorld } from '@twin-platform/world-kernel';
import { buildFishingScene, createFishSimBehavior } from '@twin-platform/plugins-fishing';
import { ReplayController } from '@twin-platform/replay-core';
import { createMemoryStorage } from '@twin-platform/storage-memory';
import type { StudioSessionPort } from '@twin-platform/studio-sdk';
import FishingOnboarding from './FishingOnboarding';

afterEach(cleanup);

const setup = () => {
  const world = new TwinWorld(buildFishingScene(), { seed: 5, behaviors: [createFishSimBehavior()] });
  const controller = new ReplayController({ world, storage: createMemoryStorage() });
  const session: StudioSessionPort = { world, controller, host: { decisions: [] } };
  const view = render(() => <FishingOnboarding session={session} onClose={() => {}} />);
  flush();
  const click = (element: Element) => { fireEvent.click(element); flush(); };
  const pick = (mark: number) => click(within(view.getByRole('img', { name: '漂尾刻度，点击选择露出目数' })).getByText(String(mark)));
  const next = () => click(view.getByRole('button', { name: '下一步 →' }));
  click(view.getByRole('button', { name: /鲫鱼/ }));
  click(view.getByRole('button', { name: '装备就这样 →' }));
  pick(7); next();
  pick(4); next();
  return { ...view, world, click, pick, next };
};

test('挂饵直接读剩余目数，预览3目、由4目自动换算单饵压1目', () => {
  const view = setup();
  expect(view.getByText('单钩挂一颗饵，漂还有几目？')).toBeTruthy();
  expect(view.getByRole('button', { name: '下一步 →' })).toBeDisabled();
  view.pick(5);
  expect(view.getByRole('button', { name: '下一步 →' })).toBeDisabled();
  view.pick(4); view.next();
  expect(view.getByText(/单饵压目必须大于 0/)).toBeTruthy();
  view.pick(3);
  expect(view.world.getEntity('rig-01')!.attrs.setupMarks).toBe(3);
  view.next();
  view.click(view.getByRole('button', { name: /调四钓二/ }));
  expect(view.world.getEntity('rig-01')!.attrs.w).toBe(1);
});

test('平水可选0目，与完全没顶明确区分', () => {
  const view = setup();
  view.click(view.getByRole('button', { name: '平水（0 目）' }));
  expect(view.world.getEntity('rig-01')!.attrs.setupMarks).toBe(0);
  expect(view.getByText(/若漂已完全沉没/)).toBeTruthy();
  view.next();
  view.click(view.getByRole('button', { name: /调四钓二/ }));
  expect(view.world.getEntity('rig-01')!.attrs.w).toBe(4);
});
