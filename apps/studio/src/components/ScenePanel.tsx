import { createSignal, For, Show } from 'solid-js';
import type {
  SceneDocumentIssue,
  SceneSummary,
  TwinScene,
} from '@twin-platform/scene-schema';
import type { SceneSource } from '../scene/studioSession';

/**
 * 场景面板：把"布局"从代码里解放出来的那一层 UI。
 *
 * 三种导入方式（文件选择 / 拖拽 / 粘贴文本）+ 导出 + 还原模板。
 * 导入必须给出**可诊断的反馈**：版本迁移做了什么、装进来多少东西、
 * 有没有校验问题——否则用户拿到一个跑不动的场景只会一脸茫然。
 */

/** 一次导入尝试的结果。由上层（持有 session 的组件）执行并回传。 */
export interface SceneImportOutcome {
  ok: boolean;
  /** 成功时的场景名，用来在界面上确认"装的是这个"。 */
  name?: string;
  /** 成功时的场景，交给上层重建会话。 */
  scene?: TwinScene;
  /** 执行的版本迁移说明。 */
  applied: string[];
  /** 解析 / 校验问题。 */
  issues: SceneDocumentIssue[];
  summary?: SceneSummary;
}

/** 导出请求的结果：上层序列化好，本面板负责触发浏览器下载。 */
export interface SceneExportPayload {
  text: string;
  fileName: string;
}

export interface ScenePanelProps {
  sceneId: string;
  sceneName: string;
  source: SceneSource;
  summary: SceneSummary;
  /** 当前场景里没有任何行为认领的类型（导入外部布局时最容易踩的坑）。 */
  unknownKinds: string[];
  /** 执行导入；返回诊断结果，成功时才带 scene。 */
  onImport: (text: string) => SceneImportOutcome;
  /** 序列化当前场景；返回 undefined 表示放弃导出。 */
  onExport: () => SceneExportPayload | undefined;
  /** 还原到插件模板场景。 */
  onReset: () => void;
}

const formatBounds = (summary: SceneSummary): string => {
  const bounds = summary.bounds;
  if (!bounds) return '—';
  const size = bounds.min.map((value, axis) => (bounds.max[axis]! - value).toFixed(1));
  return `${size[0]} × ${size[1]} × ${size[2]} m`;
};

export default function ScenePanel(props: ScenePanelProps) {
  const [result, setResult] = createSignal<SceneImportOutcome>();
  const [dragging, setDragging] = createSignal(false);
  const [pasting, setPasting] = createSignal(false);
  const [text, setText] = createSignal('');
  let fileInput: HTMLInputElement | undefined;

  const apply = (raw: string) => {
    setResult(props.onImport(raw));
  };

  const readFile = async (file: File) => {
    apply(await file.text());
  };

  const pickFile = (event: Event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (file) void readFile(file);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void readFile(file);
  };

  const download = () => {
    const payload = props.onExport();
    if (!payload) return;
    const url = URL.createObjectURL(new Blob([payload.text], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = payload.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  return (
    <section class="scene-panel">
      <h2>场景</h2>

      <dl class="scene-meta">
        <dt>名称</dt>
        <dd>{props.sceneName}</dd>
        <dt>标识</dt>
        <dd class="code-path">{props.sceneId}</dd>
        <dt>来源</dt>
        <dd>{props.source === 'template' ? '插件模板生成' : '外部 JSON 导入'}</dd>
        <dt>实体</dt>
        <dd>
          {props.summary.entities} 个 · 动体 {props.summary.moving} · 数据绑定 {props.summary.bound}
        </dd>
        <dt>尺寸</dt>
        <dd>{formatBounds(props.summary)}</dd>
      </dl>

      <Show when={props.unknownKinds.length > 0}>
        <p class="scene-warn">
          ⚠️ 有 {props.unknownKinds.length} 类设备没有行为认领：{props.unknownKinds.join('、')}
          。它们会渲染出来但不会动——需要在插件里补对应行为。
        </p>
      </Show>

      <div class="button-row">
        <button type="button" onClick={() => fileInput?.click()} title="选择 .twin.json 场景文件">
          导入文件
        </button>
        <button type="button" onClick={download} title="把当前场景导出成 JSON">
          导出 JSON
        </button>
        <button type="button" onClick={() => setPasting(!pasting())} title="直接粘贴场景 JSON">
          粘贴
        </button>
        <Show when={props.source === 'imported'}>
          <button type="button" onClick={props.onReset} title="放弃导入，回到插件模板场景">
            还原模板
          </button>
        </Show>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={pickFile}
      />

      <div
        class="scene-drop"
        classList={{ 'scene-drop-on': dragging() }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        把 .twin.json 拖到这里
      </div>

      <Show when={pasting()}>
        <textarea
          value={text()}
          onInput={(event) => setText(event.currentTarget.value)}
          rows={5}
          spellcheck={false}
          placeholder='{"version":1,"id":"my-plant","name":"我的车间","entities":[...]}'
          aria-label="场景 JSON"
        />
        <div class="button-row">
          <button type="button" onClick={() => apply(text())}>
            载入
          </button>
          <button type="button" onClick={() => setPasting(false)}>
            取消
          </button>
        </div>
      </Show>

      <Show when={result()}>
        <div class="scene-result" classList={{ 'scene-result-bad': !result()?.ok }}>
          <Show when={result()?.ok}>
            <p>
              ✓ 已载入 <strong>{result()?.name}</strong>：{result()?.summary?.entities} 个实体，
              动体 {result()?.summary?.moving}，数据绑定 {result()?.summary?.bound}
            </p>
          </Show>

          <Show when={(result()?.applied.length ?? 0) > 0}>
            <ul class="scene-migrations">
              <For each={result()?.applied ?? []}>{(item) => <li>{item}</li>}</For>
            </ul>
          </Show>

          <Show when={!result()?.ok}>
            <p>✗ 未能载入：</p>
            <ul class="scene-issues">
              <For each={result()?.issues ?? []}>
                {(issue) => (
                  <li>
                    <code>{issue.path}</code> {issue.message}
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </section>
  );
}
