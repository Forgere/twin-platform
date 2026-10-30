type PointerSample = Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY' | 'button'>;

/** 单指轻点才选中；转相机、移出后移回、多指缩放和取消都不算轻点。 */
export class CanvasTap {
  private readonly pointers = new Set<number>();
  private start: PointerSample | undefined;

  down(event: PointerSample): void {
    this.pointers.add(event.pointerId);
    this.start = this.pointers.size === 1 && event.button === 0
      ? { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, button: event.button }
      : undefined;
  }

  move(event: PointerSample): void {
    if (this.start?.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - this.start.clientX, event.clientY - this.start.clientY) > 8) this.start = undefined;
  }

  up(event: PointerSample): boolean {
    this.move(event);
    const tapped = this.start?.pointerId === event.pointerId;
    this.pointers.delete(event.pointerId);
    this.start = undefined;
    return tapped;
  }

  cancel(event: Pick<PointerSample, 'pointerId'>): void {
    this.pointers.delete(event.pointerId);
    this.start = undefined;
  }
}
