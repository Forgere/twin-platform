import { createSignal, onCleanup, Show } from 'solid-js';
import { type TwinEntityView, TwinSceneController } from '../scene/TwinSceneController';

const entityLabels: Record<string, string> = {
  'infeed-01': '入料输送线',
  'inspection-01': '视觉检测站',
  'buffer-01': '缓存货架',
};

export default function TwinViewport() {
  let controller: TwinSceneController | undefined;
  const [selected, setSelected] = createSignal<TwinEntityView>();
  const mountViewport = (host: HTMLDivElement) => {
    controller = new TwinSceneController(host, setSelected);
  };
  onCleanup(() => controller?.dispose());

  return <main class="studio-shell">
    <section class="studio-heading">
      <div><p class="eyebrow">TWIN PLATFORM / STUDIO</p><h1>物流产线概览</h1><p>原生 Three.js 视口 · SolidJS 工作台 · 本地演示场景</p></div>
      <div class="scene-status" aria-label="场景状态"><span class="status-dot" />场景已加载</div>
    </section>
    <section class="studio-grid">
      <div class="viewport-panel"><div ref={mountViewport} class="viewport" aria-label="数字孪生三维场景" /><div class="viewport-hint">拖动旋转 · 右键平移 · 滚轮缩放 · 点击设备选择</div></div>
      <aside class="inspector" aria-label="场景控制与实体详情">
        <section><h2>机位</h2><div class="button-row"><button type="button" onClick={() => controller?.setCameraPreset('overview')}>全局视角</button><button type="button" onClick={() => controller?.setCameraPreset('line')}>产线视角</button></div></section>
        <section><h2>实体</h2><div class="entity-list">{Object.entries(entityLabels).map(([id, label]) => <button type="button" class={selected()?.id === id ? 'selected' : undefined} onClick={() => controller?.selectEntity(id)}>{label}</button>)}</div></section>
        <section class="entity-detail" aria-live="polite"><h2>当前选择</h2><Show when={selected()} fallback={<p>请选择场景中的一个实体。</p>}>{(entity) => <><strong>{entity().label}</strong><span>{entity().kind}</span><button type="button" onClick={() => controller?.focusEntity(entity().id)}>聚焦此设备</button></>}</Show></section>
      </aside>
    </section>
  </main>;
}
