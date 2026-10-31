import { For } from 'solid-js';
import type { JSX } from '@solidjs/web';

/**
 * Studio 的线性图标：16px 视框、1.5 描边、`currentColor` 上色。
 *
 * 不引图标库（依赖表里没有，也不该为一个图标集加一个包）。所有图形都画在
 * 16×16 的格子里，靠 `stroke` 而不是 `fill`，所以强调色换一下全站跟着变。
 */

export type IconName =
  | 'camera'
  | 'radar'
  | 'palette'
  | 'more'
  | 'close'
  | 'cube'
  | 'shield'
  | 'bars'
  | 'scale'
  | 'database'
  | 'folder'
  | 'list'
  | 'rod'
  | 'plug'
  | 'play'
  | 'pause'
  | 'skip-start'
  | 'step-forward'
  | 'fast-forward'
  | 'locate'
  | 'copy'
  | 'check'
  | 'alert'
  | 'chevron-up'
  | 'chevron-down'
  | 'settings'
  | 'git-branch';

/** 描边图形：`d` 就是路径本身，闭合与否按视觉需要。 */
const STROKES: Record<IconName, string[]> = {
  camera: ['M2.4 5.6h2.3l1.2-1.7h3.2l1.2 1.7h3.3v7H2.4Z', 'M5.4 9.1a2.6 2.6 0 1 0 5.2 0 2.6 2.6 0 1 0-5.2 0'],
  radar: ['M8 8.6a1.4 1.4 0 1 0 0-1.2 1.4 1.4 0 0 0 0 1.2Z', 'M4.6 4.6a4.8 4.8 0 0 0 0 6.8', 'M11.4 11.4a4.8 4.8 0 0 0 0-6.8', 'M2.6 2.6a7.6 7.6 0 0 0 0 10.8', 'M13.4 13.4a7.6 7.6 0 0 0 0-10.8'],
  palette: ['M8 2.2a5.8 5.8 0 0 0 0 11.6c1 0 1.7-.8 1.7-1.6 0-1.1.9-1.7 1.8-1.7h1.2c1.1 0 1.6-.8 1.6-1.7A5.8 5.8 0 0 0 8 2.2Z', 'M5.2 6.6h.1', 'M8 5.2h.1', 'M10.6 6.6h.1'],
  more: ['M3.4 8h.1', 'M8 8h.1', 'M12.6 8h.1'],
  close: ['M4 4l8 8', 'M12 4l-8 8'],
  cube: ['M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9Z', 'M2.6 4.9L8 8l5.4-3.1', 'M8 8v6.2'],
  shield: ['M8 1.9l5.3 1.7v4c0 3-2.2 5-5.3 5.9C4.9 12.6 2.7 10.6 2.7 7.6v-4Z', 'M5.6 7.8l1.8 1.7 3.2-3.6'],
  bars: ['M2.6 13.4h10.8', 'M5 13.4V8.2', 'M8 13.4V4.4', 'M11 13.4V9.8'],
  scale: ['M8 2.4v11.2', 'M3 4.4h10', 'M3 4.4L1.4 8.6h3.2Z', 'M13 4.4l-1.6 4.2h3.2Z', 'M5 13.4h6'],
  database: ['M8 2.4c3.3 0 6 1.1 6 2.4s-2.7 2.4-6 2.4-6-1.1-6-2.4 2.7-2.4 6-2.4Z', 'M14 4.8v6.4c0 1.3-2.7 2.4-6 2.4s-6-1.1-6-2.4V4.8', 'M14 8c0 1.3-2.7 2.4-6 2.4S2 9.3 2 8'],
  folder: ['M2.4 4h3.8l1.2 1.8h6.2v6.8H2.4Z'],
  list: ['M3 4.4h10', 'M3 8h10', 'M3 11.6h6.6'],
  plug: ['M5.6 2.2v2.6', 'M10.4 2.2v2.6', 'M3.8 6.2h8.4v2.2a4.2 4.2 0 0 1-8.4 0Z', 'M8 12.6v1.6'],
  // 竿：斜向竿身 + 竿梢垂下的线 + 卷线轮（领域插件自定义页签的图标）
  rod: ['M2.2 13.8L13 3.1', 'M13 3.1c.3 1.9-.5 3.2-2 3.9', 'M6.6 8.1a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 1 0-2.4 0'],
  play: ['M5.2 3.2l7.6 4.8-7.6 4.8Z'],
  pause: ['M5.9 3.6v8.8', 'M10.1 3.6v8.8'],
  'skip-start': ['M4 3.4v9.2', 'M12.6 3.4L6.4 8l6.2 4.6Z'],
  'step-forward': ['M3.6 3.4L9.8 8l-6.2 4.6Z', 'M12 3.4v9.2'],
  'fast-forward': ['M2.8 4.4L7.4 8l-4.6 3.6Z', 'M8.4 4.4L13 8l-4.6 3.6Z'],
  locate: ['M8 10.8a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6Z', 'M8 1.6v2.2', 'M8 12.2v2.2', 'M1.6 8h2.2', 'M12.2 8h2.2'],
  copy: ['M5.6 5.6h7v7.4h-7Z', 'M3.6 10.4V3.4h7.2'],
  check: ['M3 8.4l3.2 3.2L13 4.8'],
  alert: ['M8 2.4l6 11.2H2Z', 'M8 6.6v3.2', 'M8 11.6h.1'],
  'chevron-up': ['M3.6 10.4l4.4-4.4 4.4 4.4'],
  'chevron-down': ['M3.6 5.6l4.4 4.4 4.4-4.4'],
  settings: [
    'M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Z',
    'M8 1.8v1.6',
    'M8 12.6v1.6',
    'M1.8 8h1.6',
    'M12.6 8h1.6',
    'M3.6 3.6l1.1 1.1',
    'M11.3 11.3l1.1 1.1',
    'M12.4 3.6l-1.1 1.1',
    'M4.7 11.3l-1.1 1.1',
  ],
  'git-branch': [
    'M4.5 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z',
    'M4.5 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z',
    'M11.5 4.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z',
    'M4.5 6.5v3',
    'M4.5 8c2.6 0 4.2-.4 5.5-1.5',
  ],
};

const KNOWN_ICONS = new Set<string>(Object.keys(STROKES));
/**
 * 领域插件的页签只给一个 `icon` 字符串。是本站画过的图标就上线性图标，
 * 否则由调用方退回它自带的字形——Studio 核心因此不必知道任何领域页签的 id。
 */
export const isIconName = (value: string): value is IconName => KNOWN_ICONS.has(value);

export interface IconProps {
  name: IconName;
  /** 像素边长；只改尺寸，不改比例。 */
  size?: number;
  /** 纯装饰的图标（旁边已有文字）交给 `aria-hidden`，这里只处理要当标签用的情况。 */
  role?: 'img';
  label?: string;
}

/**
 * 单个图标。`stroke-linecap: round` + `stroke-linejoin: round` 让短路径（打点）
 * 也显示成圆点，不必为每个 dot 另写 `<circle>`。
 */
export default function Icon(props: IconProps): JSX.Element {
  const size = () => props.size ?? 16;
  return (
    <svg
      class="icon"
      width={size()}
      height={size()}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={props.label ? undefined : 'true'}
      role={props.label ? 'img' : undefined}
    >
      {props.label ? <title>{props.label}</title> : undefined}
      <For each={STROKES[props.name]}>{(d) => <path d={d} />}</For>
    </svg>
  );
}
