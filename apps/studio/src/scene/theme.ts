/**
 * 设备主题：pastel（玩具工厂）↔ industrial（工业涂装）。
 *
 * 所有颜色 / 材质参数都从 `DeviceTheme` 读，组件不写字面量——换主题 = 换对象，
 * 和 r3f-tools 的 `DeviceTheme` 契约一致。渲染层在构建模型时读 `activeTheme`，
 * 切主题时由 `TwinSceneController.setTheme()` 触发整场重建。
 */

export interface DeviceTheme {
  /** 主题名，供 UI 切换与调试面板显示；和 themeByName 对应。 */
  name: 'pastel' | 'industrial';
  /** 结构件 / 侧板 / 货架。 */
  frame: string;
  /** 深结构件 / 支腿 / 底座。 */
  frameDark: string;
  /** 金属件（滚筒 / 电机 / 天梁）。 */
  metal: string;
  /** 强调色（分拣台 / 移栽机 / 状态灯 active）。 */
  accent: string;
  /** 滚筒表面色。 */
  roller: string;
  /** 台面色。 */
  deck: string;
  /** 地面色。 */
  floor: string;
  /** 状态灯 idle 色。 */
  lightIdle: string;
  /** 状态灯 active / busy 色。 */
  lightActive: string;
  /** 圆角半径（米），0 走方角。 */
  cornerRadius: number;
  roughness: number;
  metalness: number;
  /** 是否绘制装饰件（电机 / 脚 / 光幕等）。 */
  detail: boolean;
  /** 物料箱 5 色轮转。 */
  cargoColors: string[];
}

export const PASTEL_THEME: DeviceTheme = {
  name: 'pastel',
  frame: '#E8E4DC',
  frameDark: '#CFC7B8',
  metal: '#A9A296',
  accent: '#F4A261',
  roller: '#D8D8D8',
  deck: '#F5F2EB',
  floor: '#EFEAE0',
  lightIdle: '#8BD3C7',
  lightActive: '#F4A261',
  cornerRadius: 0.04,
  roughness: 0.62,
  metalness: 0.12,
  detail: true,
  cargoColors: ['#FFB7B2', '#B5EAD7', '#C7CEEA', '#FFDAC1', '#FDFD96'],
};

export const INDUSTRIAL_THEME: DeviceTheme = {
  name: 'industrial',
  frame: '#4A5259',
  frameDark: '#3B4248',
  metal: '#8D949B',
  accent: '#F0801E',
  roller: '#9AA3AA',
  deck: '#3B4248',
  floor: '#2F3438',
  lightIdle: '#5FD35F',
  lightActive: '#FFC53D',
  cornerRadius: 0.006,
  roughness: 0.42,
  metalness: 0.62,
  detail: false,
  cargoColors: ['#C9A66B', '#7FA8C9', '#9FB89A', '#C98B7B', '#B7B7A8'],
};

let activeTheme: DeviceTheme = PASTEL_THEME;

export function getActiveTheme(): DeviceTheme {
  return activeTheme;
}

export function setActiveTheme(theme: DeviceTheme): void {
  activeTheme = theme;
}

export type ThemeName = 'pastel' | 'industrial';

export function themeByName(name: ThemeName): DeviceTheme {
  return name === 'industrial' ? INDUSTRIAL_THEME : PASTEL_THEME;
}

/** 把实体 id 哈希成稳定色板下标，保证同一货物永远同色（刷新不跳色）。 */
export function cargoColorFor(theme: DeviceTheme, id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const index = Math.abs(hash) % theme.cargoColors.length;
  return theme.cargoColors[index]!;
}
