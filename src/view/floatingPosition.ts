/** Viewport-coordinate geometry, independent of Obsidian and the DOM. */
export interface Rect { left: number; top: number; width: number; height: number }
export type Placement = "top" | "bottom" | "left" | "right";
export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(Number.isFinite(value) ? value : min, Math.max(min, max)));

export function intersectRects(a: Rect, b: Rect): Rect {
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
  return { left, top, width: Math.max(0, Math.min(a.left + a.width, b.left + b.width) - left),
    height: Math.max(0, Math.min(a.top + a.height, b.top + b.height) - top) };
}

export function positionFloating(anchor: Rect, size: { width: number; height: number }, boundary: Rect,
  preferred: Placement = "bottom", margin = 8, gap = 8) {
  const mx = Math.min(margin, boundary.width / 2), my = Math.min(margin, boundary.height / 2);
  const maxWidth = Math.max(0, boundary.width - 2 * mx), maxHeight = Math.max(0, boundary.height - 2 * my);
  const width = Math.min(size.width, maxWidth), height = Math.min(size.height, maxHeight);
  const left = boundary.left + mx, top = boundary.top + my;
  const right = left + maxWidth, bottom = top + maxHeight;
  const space = { bottom: bottom - anchor.top - anchor.height - gap, top: anchor.top - top - gap,
    left: anchor.left - left - gap, right: right - anchor.left - anchor.width - gap };
  const opposite: Record<Placement, Placement> = { top: "bottom", bottom: "top", left: "right", right: "left" };
  const needed = preferred === "top" || preferred === "bottom" ? height : width;
  const placement = space[preferred] < needed && space[opposite[preferred]] > space[preferred] ? opposite[preferred] : preferred;
  let x = anchor.left, y = anchor.top;
  if (placement === "bottom") y += anchor.height + gap;
  if (placement === "top") y -= height + gap;
  if (placement === "right") x += anchor.width + gap;
  if (placement === "left") x -= width + gap;
  return { x: clamp(x, left, right - width), y: clamp(y, top, bottom - height), maxWidth, maxHeight, placement };
}

/** The actual visible portion of this pane, including the software keyboard. */
export function visibleBoundary(root: HTMLElement): Rect {
  const win = root.ownerDocument.defaultView!;
  const vp = win.visualViewport;
  const viewport = { left: vp?.offsetLeft ?? 0, top: vp?.offsetTop ?? 0,
    width: vp?.width ?? win.innerWidth, height: vp?.height ?? win.innerHeight };
  const style = win.getComputedStyle(root);
  const inset = (side: string) => parseFloat(style.getPropertyValue(`--ink-safe-${side}`)) || 0;
  viewport.left += inset("left"); viewport.top += inset("top");
  viewport.width = Math.max(0, viewport.width - inset("left") - inset("right"));
  viewport.height = Math.max(0, viewport.height - inset("top") - inset("bottom"));
  return intersectRects(root.getBoundingClientRect(), viewport);
}

/** Coalesce all layout triggers; no observers or animation loops while closed. */
export function observeFloating(root: HTMLElement, elements: HTMLElement[], update: () => void): () => void {
  const win = root.ownerDocument.defaultView!;
  let frame = 0;
  const schedule = () => { if (!frame) frame = win.requestAnimationFrame(() => { frame = 0; update(); }); };
  const observer = new ResizeObserver(schedule);
  for (const el of new Set([root, ...elements])) observer.observe(el);
  win.addEventListener("resize", schedule);
  win.addEventListener("scroll", schedule, true);
  win.visualViewport?.addEventListener("resize", schedule);
  win.visualViewport?.addEventListener("scroll", schedule);
  if (!elements.some(el => el.classList.contains("ink-toolbar"))) root.addEventListener("ink-toolbar-layout", schedule);
  return () => {
    observer.disconnect();
    win.cancelAnimationFrame(frame);
    win.removeEventListener("resize", schedule);
    win.removeEventListener("scroll", schedule, true);
    win.visualViewport?.removeEventListener("resize", schedule);
    win.visualViewport?.removeEventListener("scroll", schedule);
    root.removeEventListener("ink-toolbar-layout", schedule);
  };
}
