import { flush } from 'solid-js';
import { fireEvent, render } from '@solidjs/testing-library';
import { describe, expect, test } from 'vitest';
import type { SceneDiff, SceneSummary } from '@twin-platform/scene-schema';
import type { SceneVersionSummary } from '@twin-platform/storage-contracts';

import ScenePanel, { type SceneHistoryState, type ServerState } from './ScenePanel';

/**
 * 版本历史的 DOM 契约：列表、diff、回滚入口，以及"当前版本不给回滚按钮"。
 *
 * 面板只负责把 (sceneId, version) 交给上层——读库、重建会话都不在这里。
 */
describe('ScenePanel 版本历史', () => {
  const summary: SceneSummary = { entities: 1, kinds: [{ kind: 'transport', count: 1 }], moving: 0, bound: 0 };
  const versions: SceneVersionSummary[] = [
    { sceneId: 'line', version: 1, kind: 'snapshot', opCount: 0, name: '产线', createdAt: '2026-10-31T08:00:00.000Z' },
    { sceneId: 'line', version: 2, kind: 'ops', opCount: 1, name: '产线', createdAt: '2026-10-31T09:00:00.000Z' },
  ];
  const diff: SceneDiff = { added: ['agv-01'], removed: ['rack-01'], changed: [{ id: 'belt-01', fields: ['transform'] }], sceneFields: ['name'] };

  const setup = (history: SceneHistoryState | undefined) => {
    const calls: string[] = [];
    const server: ServerState = { url: 'http://localhost:8787', scenes: [{ id: 'line', name: '产线', version: 2, updatedAt: 'x' }], busy: false };
    const view = render(() => (
      <ScenePanel
        sceneId="line"
        sceneName="产线"
        source="imported"
        summary={summary}
        unknownKinds={[]}
        onImport={() => ({ ok: true, applied: [], issues: [] })}
        onExport={() => undefined}
        onReset={() => undefined}
        server={server}
        history={history}
        onListVersions={async (id) => {
          calls.push(`list:${id}`);
        }}
        onShowVersionDiff={async (id, version) => {
          calls.push(`diff:${id}:${version}`);
        }}
        onRollbackVersion={async (id, version) => {
          calls.push(`rollback:${id}:${version}`);
        }}
      />
    ));
    flush();
    return { ...view, calls };
  };

  test('展开的场景列出版本，并按 kind 标注快照 / ops 条数', () => {
    const { container } = setup({ sceneId: 'line', versions, busy: false });
    const rows = container.querySelectorAll('.scene-version-main');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('v1');
    expect(rows[0]?.textContent).toContain('快照');
    expect(rows[1]?.textContent).toContain('1 条 ops');
  });

  test('只有非当前版本给回滚按钮；点击交出 (sceneId, version)', () => {
    const { container, calls } = setup({ sceneId: 'line', versions, busy: false });
    const rollbacks = container.querySelectorAll<HTMLButtonElement>('.scene-version-rollback');
    // 场景当前是 v2，所以只有 v1 可回滚。
    expect(rollbacks).toHaveLength(1);
    fireEvent.click(rollbacks[0]!);
    flush();
    expect(calls).toEqual(['rollback:line:1']);
  });

  test('diff 按当前 → 选中版本的方向展示增删改', () => {
    const { container, calls } = setup({ sceneId: 'line', versions, selected: 1, diff, busy: false });
    fireEvent.click(container.querySelectorAll('.scene-version-main')[1] as HTMLButtonElement);
    flush();
    expect(calls).toEqual(['diff:line:2']);
    const block = container.querySelector('.scene-version-diff');
    expect(block?.querySelector('.scene-version-diff-scene')?.textContent).toContain('name');
    expect(block?.querySelector('.diff-add')?.textContent).toContain('agv-01');
    expect(block?.querySelector('.diff-remove')?.textContent).toContain('rack-01');
    expect(block?.querySelector('.diff-change')?.textContent).toContain('transform');
  });

  test('没有展开历史时不渲染版本区', () => {
    const { container } = setup(undefined);
    expect(container.querySelector('.scene-versions')).toBeNull();
  });
});
