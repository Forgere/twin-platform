/**
 * Studio 的键盘契约。
 *
 * 只放纯逻辑，不碰信号：调用方决定「选中谁」，这里只负责把方向键翻译成
 * 目标 id、把 Tab 锁在弹窗里、判断当前焦点是不是文本/控件。
 */

const CONTROL_TAGS: Record<string, true> = {
  INPUT: true,
  TEXTAREA: true,
  SELECT: true,
  BUTTON: true,
  A: true,
  SUMMARY: true,
};

/**
 * 焦点落在可编辑控件或原生可激活元素上时，全局快捷键必须让路：
 * 否则空格会既触发按钮点击、又触发播放/暂停。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (CONTROL_TAGS[target.tagName] === true) return true;
  const role = target.getAttribute('role');
  return role === 'tab' || role === 'menuitem' || role === 'option';
}

/**
 * tablist 的方向键契约：左右循环、Home/End 跳首尾，焦点跟着选中项走。
 *
 * 调用方把 `event.currentTarget` 放在 tablist 的容器里（tab 按钮的直接父级），
 * 这样不用额外维护 ref 列表。
 */
export function handleTabKeys<T extends string>(
  event: KeyboardEvent,
  ids: readonly T[],
  active: T | undefined,
  select: (id: T) => void,
): void {
  const key = event.key;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
  if (ids.length === 0) return;

  event.preventDefault();
  const current = active === undefined ? -1 : ids.indexOf(active);
  let next: number;
  if (key === 'Home') next = 0;
  else if (key === 'End') next = ids.length - 1;
  else if (key === 'ArrowLeft') next = current <= 0 ? ids.length - 1 : current - 1;
  else next = current < 0 || current === ids.length - 1 ? 0 : current + 1;

  const id = ids[next];
  if (id === undefined) return;
  select(id);

  const tabs = (event.currentTarget as HTMLElement | null)?.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
  tabs?.[next]?.focus();
}

export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 弹窗内的 Tab 循环：焦点在最后一项时 Tab 回第一项，Shift+Tab 反向绕回。 */
export function trapTabKey(event: KeyboardEvent, root: HTMLElement | undefined): void {
  if (event.key !== 'Tab' || !root) return;
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
  if (items.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (document.activeElement === root) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
