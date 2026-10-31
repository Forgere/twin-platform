import { flush } from 'solid-js';
import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { afterEach, expect, test, vi } from 'vitest';
import TwinViewport from './TwinViewport';
import { buildDefaultScene } from '../scene/studioSession';
import type { TwinScene } from '@twin-platform/scene-schema';
import type { SceneVersionSummary } from '@twin-platform/storage-contracts';
import type { TwinSceneControllerOptions } from '../scene/TwinSceneController';

vi.mock('../scene/TwinSceneController', () => ({
  TwinSceneController: class {
    entities = [];
    themeName = 'pastel';
    dispose = vi.fn();
    constructor(_host: unknown, _select: unknown, _options: TwinSceneControllerOptions) {}
    setCameraPreset() {}
    setAuditSpots() {}
    setBackdrop() {}
    setTheme() {}
    setSpeed() {}
    play() {}
    pause() {}
    stepFrames() {}
    seek() {
      return Promise.resolve(undefined);
    }
    codePath() {
      return 'mock/TwinSceneController.ts';
    }
    listEntities() {
      return [];
    }
  },
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

/**
 * 版本历史的完整一条线：列版本 → 看差异 → 回滚。
 *
 * 验的是**接线**：面板交出 (sceneId, version)，视口去读库、算差异、把旧文档
 * 作为新版本写回并重建会话。库里当前版本与本地默认场景内容相同，否则录制器
 * 会先补一版，测的就不是这条线。
 */
test('版本列表、差异预览与回滚走通，回滚后的文档与所选版本逐位一致', async () => {
  const stored = buildDefaultScene();
  const historic = structuredClone(stored);
  historic.entities[0]!.transform.position = [stored.entities[0]!.transform.position[0] + 1.5, 0, 0];

  const store = {
    current: 2,
    docs: new Map<number, TwinScene>([
      [1, structuredClone(historic)],
      [2, structuredClone(stored)],
    ]),
  };
  const sceneUrl = `/api/scenes/${stored.id}`;

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';

    if (path === '/api/health') return Response.json({ ok: true, backend: 'memory' });
    if (path === '/api/scenes' && method === 'GET') {
      return Response.json([{ id: stored.id, name: stored.name, version: store.current, updatedAt: 'now' }]);
    }
    if (path === '/api/scenes' && method === 'POST') {
      const scene = JSON.parse(String(init?.body)) as TwinScene;
      store.current += 1;
      store.docs.set(store.current, scene);
      return Response.json({ id: scene.id, name: scene.name, version: store.current, updatedAt: 'now' });
    }
    if (path === sceneUrl && method === 'GET') return Response.json(store.docs.get(store.current) ?? null);
    if (path === `${sceneUrl}/versions` && method === 'GET') {
      const rows: SceneVersionSummary[] = [...store.docs.keys()]
        .sort((a, b) => a - b)
        .map((version) => ({
          sceneId: stored.id,
          version,
          kind: version === 1 ? ('ops' as const) : ('snapshot' as const),
          opCount: version === 1 ? 1 : 0,
          name: store.docs.get(version)!.name,
          createdAt: '2026-10-31T08:00:00.000Z',
        }));
      return Response.json(rows);
    }
    const versionMatch = path.match(new RegExp(`^${sceneUrl}/versions/(\\d+)$`));
    if (versionMatch && method === 'GET') {
      const doc = store.docs.get(Number(versionMatch[1]));
      return doc ? Response.json(doc) : Response.json({ error: '场景版本不存在。' }, { status: 404 });
    }
    if (path === '/api/events/latest') return Response.json({ sequence: 0 });
    if (path === '/api/events' && method === 'GET') return Response.json([]);
    if (path === '/api/snapshots/query') return Response.json(null);
    if (method === 'POST') return Response.json({ ok: true, written: 0, removed: 0 });
    return Response.json(null);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

  const view = render(() => <TwinViewport />);
  flush();

  fireEvent.click(view.getByRole('button', { name: /系统与数据配置/ }));
  flush();
  fireEvent.click(view.getByRole('tab', { name: /场景管理与云端/ }));
  flush();
  await vi.waitFor(() => expect(view.container.querySelector('.scene-server-list')).not.toBeNull());

  // 1. 展开版本列表：库里两版（v1 是 ops，v2 是快照）。
  fireEvent.click(view.getByRole('button', { name: 'v2' }));
  await vi.waitFor(() => expect(view.container.querySelectorAll('.scene-version')).toHaveLength(2));
  expect(view.container.querySelectorAll('.scene-version-rollback')).toHaveLength(1);

  // 2. 对比 v1：差异就是"回滚会改什么"——实体 0 的位姿要挪回历史位置。
  const rows = view.container.querySelectorAll<HTMLButtonElement>('.scene-version-main');
  fireEvent.click(rows[0]!);
  await vi.waitFor(() => expect(view.container.querySelector('.scene-version-diff')).not.toBeNull());
  expect(view.container.querySelector('.scene-version-diff-head')?.textContent).toContain('回滚到 v1');
  expect(view.container.querySelector('.diff-change')?.textContent).toContain('transform');

  // 3. 回滚：旧文档作为**新版本**写回，历史只增不减。
  fireEvent.click(view.container.querySelector('.scene-version-rollback') as HTMLButtonElement);
  await vi.waitFor(() => expect(store.current).toBe(3));
  expect(store.docs.get(3)).toEqual(historic);
  await vi.waitFor(() =>
    expect(view.container.querySelector('.scene-server-note')?.textContent).toContain('已回滚到 v1'),
  );
});
