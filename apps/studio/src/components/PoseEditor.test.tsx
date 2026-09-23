import { createSignal, flush } from 'solid-js';
import { fireEvent, render } from '@solidjs/testing-library';
import { describe, expect, test } from 'vitest';
import type { TwinTransform } from '@twin-platform/scene-schema';

import PoseEditor from './PoseEditor';

/**
 * 布局编辑器的 DOM 契约：绑**声明**、只在提交成功后回填、锁死时给出原因。
 *
 * 这一层的坑全在响应式时序上（面板每 120ms 采样刷新），所以测试的重点不是
 * "能不能输入"，而是"回填只认 revision"——打字打到一半不能被别人冲掉。
 */
describe('<PoseEditor />', () => {
  const setup = (initial: TwinTransform, locked?: string) => {
    const [revision, setRevision] = createSignal(0);
    const [declared, setDeclared] = createSignal<TwinTransform>(initial);
    const commits: TwinTransform[] = [];
    const view = render(() => (
      <PoseEditor
        entityId="rack-01"
        revision={revision()}
        getDeclared={() => declared()}
        locked={locked}
        onCommit={(next) => commits.push(next)}
      />
    ));
    flush();
    const input = (label: string): HTMLInputElement => view.getByLabelText(label) as HTMLInputElement;
    return { ...view, input, commits, revision: { get: revision, set: setRevision }, declared: { get: declared, set: setDeclared } };
  };

  test('输入框显示的是声明位姿，并在改动时交出完整的新位姿', () => {
    const { input, commits } = setup({ position: [1, 2, 3], rotation: [0, 0.5, 0] });

    expect(input('位置 X').value).toBe('1');
    expect(input('位置 Y').value).toBe('2');
    expect(input('朝向 Y').value).toBe('0.5');

    fireEvent.change(input('位置 X'), { target: { value: '7' } });
    flush();
    expect(commits).toHaveLength(1);
    // 只改了 X：Y/Z 与朝向必须原样带过去，否则每次改一个字段都会冲掉别的字段。
    expect(commits[0]).toEqual({ position: [7, 2, 3], rotation: [0, 0.5, 0] });
  });

  test('没有声明朝向时补全为 [0, y, 0]，而不是留个半截 rotation', () => {
    const { input, commits } = setup({ position: [0, 1, 0] });
    fireEvent.change(input('朝向 Y'), { target: { value: '1.5' } });
    flush();
    expect(commits[0]?.rotation).toEqual([0, 1.5, 0]);
  });

  test('revision 变化才回填：外部编辑提交后输入框跟上新的声明', () => {
    const { input, revision, declared } = setup({ position: [1, 2, 3] });

    // 面板的采样刷新不经过 revision：这里只动外部状态，输入框不该被冲掉。
    revision.set(1);
    declared.set({ position: [9, 9, 9] });
    flush();
    expect(input('位置 X').value).toBe('9');
  });

  test('非法中间值不提交（打到一半的 "-"、"1." 不该拼出 NaN）', () => {
    const { input, commits } = setup({ position: [1, 2, 3] });
    fireEvent.change(input('位置 X'), { target: { value: '' } });
    flush();
    expect(commits).toHaveLength(0);
  });

  test('锁定时输入框禁用并展示内核给的原因', () => {
    const { input, getByText } = setup({ position: [1, 2, 3] }, '位姿由路径决定（声明了 motion），要改得改路径。');

    expect(input('位置 X').disabled).toBe(true);
    expect(input('朝向 Y').disabled).toBe(true);
    expect(getByText(/🔒/)).toBeTruthy();
    expect(getByText(/路径/)).toBeTruthy();
  });
});
