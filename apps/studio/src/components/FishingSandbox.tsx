import { For, Show } from 'solid-js';
import { fishingView, rigPosture, SIGNAL_LABEL, type FishingView, type RigPosture } from '@twin-platform/plugins-fishing';
import type { StudioSession } from '../scene/studioSession';

/**
 * 台钓剖面沙盒（2D / SVG）。
 *
 * 两个身份：
 * - **教学**：把抽象的"调钓"画出来——漂、主线、铅坠、上下钩饵相对水底的位置，
 *   以及 d 在 d1..d3 刻度上的落点；
 * - **FishSim 的可视化测试工具**：图用的是行为写进世界的同一份 fishingLayout，
 *   下面那行"图与 FishSim 写入一致"就是逐帧核对，对不上说明行为有 bug。
 *
 * 不自己算物理、不引入 Three.js：只读 fishingView()，一行渲染。
 */

const RIG_ID = 'rig-01';
const WIDTH = 280;
const PAD = 16;
const SCALE = 130; // px / 米
const SURFACE_Y = PAD + 30;

const fmt = (value: number): string => String(Math.round(value * 100) / 100);
const pct = (value: number, min: number, max: number): number =>
  max - min <= 1e-9 ? 0 : Math.min(Math.max((value - min) / (max - min), 0), 1);

const ZONE_LABEL: Readonly<Record<string, string>> = {
  off_bottom: '未到底',
  sensitive: '灵区',
  neutral: '不灵不钝',
  blunt: '钝区',
  sinker_on_bottom: '铅坠触底',
};

const zoneLabel = (zone: string): string => ZONE_LABEL[zone] ?? zone;

/** 逐部件姿态列表（漂 / 主线 / 铅坠 / 8 字环 / 上下钩饵 / 子线），与 3D 场景共用 rigPosture。 */
const postureParts = (current: FishingView): RigPosture['parts'] =>
  rigPosture(current.state.rig, { drift: current.drift, signal: current.signal }).parts;

export default function FishingSandbox(props: { session: StudioSession; tick: number }) {
  const view = (): FishingView | undefined => {
    // 读一下采样节拍：世界位姿在实体 transform 里，不经过信号，必须显式拉取。
    props.tick;
    try {
      return fishingView(props.session.world);
    } catch {
      return undefined;
    }
  };

  /** 图坐标 vs 世界坐标的最大 Y 偏差；undefined 表示没有可核对的对象。 */
  const drift = (): number | undefined => {
    const current = view();
    if (!current) return undefined;
    let max = 0;
    let compared = false;
    for (const entity of props.session.world.listEntities()) {
      const config = entity.config as { rigId?: unknown; slot?: unknown } | undefined;
      if (config?.rigId !== RIG_ID || typeof config.slot !== 'string') continue;
      const expected = current.layout[config.slot as keyof FishingView['layout']];
      const actualY = entity.transform.position[1];
      if (!expected || actualY === undefined) continue;
      compared = true;
      max = Math.max(max, Math.abs(actualY - expected[1]));
    }
    return compared ? max : undefined;
  };

  const driftText = (): string | undefined => {
    const value = drift();
    if (value === undefined) return undefined;
    return value < 1e-6 ? '图与 FishSim 写入一致' : '与 FishSim 偏差 ' + value.toFixed(4) + ' m';
  };

  const crossSection = () => {
    const current = view();
    if (!current) return undefined;
    const bottomY = SURFACE_Y + current.depth * SCALE;
    const height = bottomY + PAD;
    const cx = WIDTH / 2;
    // 按视图自己的水面高度换算，而不是假定世界水面在 y=0——场景现在水底贴地、
    // 水面在 +depth，写死 0 会把整张图画到 viewBox 外面。
    const sy = (y: number): number => SURFACE_Y + (current.surfaceY - y) * SCALE;
    const layout = current.layout;

    // 由状态算姿态：部件状态 + 子线弯曲，与 3D 场景共用 rigPosture 同一份真相。
    const posture = rigPosture(current.state.rig, { drift: current.drift, signal: current.signal });
    const bendU = posture.subLineUpper.bend;
    const bendL = posture.subLineLower.bend;
    const upperDX = 7;
    const lowerDX = -7;

    const floatY = sy(layout.float[1]);
    const sinkerY = sy(layout.sinker[1]);
    const swivelY = sy(layout.swivel[1]);
    const upperHookY = sy(layout.upperHook[1]);
    const lowerHookY = sy(layout.lowerHook[1]);
    const upperBaitY = sy(layout.upperBait[1]);
    const lowerBaitY = sy(layout.lowerBait[1]);
    const tipX = cx + 88;
    const tipY = SURFACE_Y - 12;
    // 子线弯曲：钝区子线松弛，中间点向外侧鼓出（上钩向右、下钩向左，像真分叉）。
    const upperMidX = cx + upperDX + bendU * 12;
    const upperMidY = (swivelY + upperHookY) / 2;
    const lowerMidX = cx + lowerDX - bendL * 12;
    const lowerMidY = (swivelY + lowerHookY) / 2;

    return (
      <svg class="sandbox-svg" viewBox={'0 0 ' + WIDTH + ' ' + height} width="100%" role="img" aria-label="钓组剖面图">
        <rect x={0} y={SURFACE_Y} width={WIDTH} height={bottomY - SURFACE_Y} fill="#cfe8f3" />
        <line x1={0} y1={SURFACE_Y} x2={WIDTH} y2={SURFACE_Y} stroke="#2E86AB" stroke-width={1.5} />
        <rect x={0} y={bottomY} width={WIDTH} height={height - bottomY} fill="#e6d3b3" />
        <line x1={0} y1={bottomY} x2={WIDTH} y2={bottomY} stroke="#b08d57" stroke-width={2} />

        {/* 主线：竿梢 → 浮漂 → 铅坠 → 8 字环（自上而下一条链） */}
        <line x1={tipX} y1={tipY} x2={cx} y2={floatY} stroke="#8a8a8a" stroke-width={1.2} />
        <line x1={cx} y1={floatY} x2={cx} y2={sinkerY} stroke="#8a8a8a" stroke-width={1.2} />
        <line x1={cx} y1={sinkerY} x2={cx} y2={swivelY} stroke="#8a8a8a" stroke-width={1.2} />
        {/* 子线：8 字环并联分出两根到上钩 / 下钩，弯曲时鼓成折线 */}
        <polyline points={`${cx},${swivelY} ${upperMidX},${upperMidY} ${cx + upperDX},${upperHookY}`} fill="none" stroke="#aab2bb" stroke-width={1} />
        <polyline points={`${cx},${swivelY} ${lowerMidX},${lowerMidY} ${cx + lowerDX},${lowerHookY}`} fill="none" stroke="#aab2bb" stroke-width={1} />

        <circle cx={cx} cy={swivelY} r={3} fill="#b08d57" />
        <ellipse cx={cx} cy={floatY} rx={4} ry={11} fill={current.signal === 'sink' ? '#c0392b' : '#ff8c42'} />
        <rect x={cx - 3} y={sinkerY - 5} width={6} height={10} rx={1.5} fill="#4a4a4a" />

        <circle cx={cx + upperDX} cy={upperHookY} r={3} fill="none" stroke="#333" stroke-width={1.2} />
        <circle cx={cx + lowerDX} cy={lowerHookY} r={3} fill="none" stroke="#333" stroke-width={1.2} />
        <circle cx={cx + upperDX - 9} cy={upperBaitY} r={3.5} fill="#e07a5f" />
        <circle cx={cx + lowerDX - 9} cy={lowerBaitY} r={3.5} fill="#e07a5f" />

        <text x={tipX - 4} y={tipY - 4} font-size="9" fill="#333" text-anchor="end">竿梢</text>
        <text x={cx + 10} y={floatY + 3} font-size="9" fill="#333">漂</text>
        <text x={cx + 10} y={sinkerY + 3} font-size="9" fill="#333">铅</text>
        <text x={cx + 10} y={swivelY + 3} font-size="9" fill="#b08d57">8字环</text>
        <text x={cx + upperDX + 8} y={upperHookY + 3} font-size="9" fill="#333">上钩</text>
        <text x={cx + lowerDX + 8} y={lowerHookY + 3} font-size="9" fill="#333">下钩</text>
        <text x={8} y={SURFACE_Y - 4} font-size="9" fill="#2E86AB">水面</text>
        <text x={8} y={bottomY - 4} font-size="9" fill="#8a6a3d">水底 {fmt(current.depth)}m</text>
      </svg>
    );
  };

  const markerStyle = (current: FishingView): string => {
    const marks = current.state.rig.criticalMarks;
    const position = pct(current.state.rig.d, marks.d1, marks.d3);
    return 'position:absolute;top:-3px;bottom:-3px;width:3px;left:calc(' + (position * 100).toFixed(1) + '% - 1.5px);background:#d1495b;';
  };
  const sensitiveStyle = (current: FishingView): string => {
    const marks = current.state.rig.criticalMarks;
    return 'position:absolute;top:0;bottom:0;left:0;width:' + (pct(marks.d2, marks.d1, marks.d3) * 100).toFixed(1) + '%;background:#bfe3b0;';
  };
  const bluntStyle = (current: FishingView): string => {
    const marks = current.state.rig.criticalMarks;
    return 'position:absolute;top:0;bottom:0;left:' + (pct(marks.d2, marks.d1, marks.d3) * 100).toFixed(1) + '%;right:0;background:#f3d5a5;';
  };

  return (
    <section aria-label="钓组剖面">
      <h2>钓组剖面</h2>
      <Show when={view()} fallback={<p class="plugin-note">当前场景不是钓场（缺少 rig 实体）。</p>}>
        {(current) => (
          <>
            {crossSection()}

            <Show when={current().signal !== 'none'}>
              <p class="plugin-note" style="color:#c0392b">漂相：{SIGNAL_LABEL[current().signal]}</p>
            </Show>
            <Show when={current().drift}>
              <p class="plugin-note" style="color:#b8860b">⚠ 走水：主线被拉斜、浮漂走位</p>
            </Show>

            <h3 style="margin:10px 0 4px;font-size:12px;opacity:0.85">各部件状态</h3>
            <ul class="rig-posture">
              <For each={postureParts(current())}>{(part) => (
                <li>
                  <span class="rp-label">{part.label}</span>
                  <span class="rp-text">{part.text}</span>
                </li>
              )}</For>
            </ul>

            {/* 刻度条：绿 = 灵区、橙 = 钝区，红针 = 当前钓目；刻度写明含义，不靠记 d1/d2/d3。 */}
            <div class="sandbox-ruler" style="margin:8px 0 4px" aria-label={'钓目 ' + fmt(current().state.rig.d) + '，' + zoneLabel(current().state.rig.zone)}>
              <div style="position:relative;height:10px;border-radius:5px;overflow:hidden;background:#eee">
                <div style={sensitiveStyle(current())} />
                <div style={bluntStyle(current())} />
                <div style={markerStyle(current())} />
              </div>
              <div style="display:flex;justify-content:space-between;font-size:11px;opacity:0.75">
                <span>离底 d1 {fmt(current().state.rig.criticalMarks.d1)}</span>
                <span>不灵不钝 d2 {fmt(current().state.rig.criticalMarks.d2)}</span>
                <span>到铅 d3 {fmt(current().state.rig.criticalMarks.d3)}</span>
              </div>
            </div>

            <details class="sandbox-tech">
              <summary>技术参数与核对</summary>
            <p class="plugin-contrib">
              t0 {fmt(current().state.rig.t0)} · 带钩调目 t {fmt(current().state.rig.t)} · 单饵压目 w {fmt(current().state.rig.w)} · 钓目 d {fmt(current().state.rig.d)}
            </p>
            <p class="plugin-contrib">
              底承重 B {fmt(current().state.rig.bottomLoad)} · {zoneLabel(current().state.rig.zone)} · 钩 {current().state.rig.hookState} · 饵 {current().state.rig.baitState}
            </p>

            <p class="plugin-note">
              可调 {fmt(current().state.rig.adjustableRange.min)}–{fmt(current().state.rig.adjustableRange.max)} 目 · 每次抛竿间隔 {fmt(current().castInterval)}s
            </p>
            <Show when={driftText()}>{(text) => <p class="plugin-note">{text()}</p>}</Show>
            </details>
          </>
        )}
      </Show>
    </section>
  );
}
