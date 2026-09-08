import { observeFloating, positionFloating, visibleBoundary, type Placement } from "./floatingPosition";

/** Shared non-modal inspector lifecycle. Surfaces remain pane children to inherit
 * themes; coordinates are converted to the pane's padding box after measuring. */
export function mountFloatingSurface(root: HTMLElement, panel: HTMLElement, anchor: HTMLElement,
  close: () => void, onLayout?: () => void): () => void {
  const doc = root.ownerDocument;
  panel.classList.add("ink-floating-surface");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", panel.querySelector(".ink-panel-title")?.textContent ?? "Tool options");
  panel.tabIndex = -1;
  anchor.setAttribute("aria-expanded", "true");
  anchor.setAttribute("aria-haspopup", "dialog");
  const update = () => {
    const bounds = visibleBoundary(root);
    const initial = positionFloating(anchor.getBoundingClientRect(), panel.getBoundingClientRect(), bounds);
    panel.style.maxWidth = `${initial.maxWidth}px`;
    panel.style.maxHeight = `${initial.maxHeight}px`;
    const dock = anchor.closest<HTMLElement>(".ink-toolbar")?.dataset.position;
    const preferred: Placement = dock === "bottom" ? "top" : dock === "left" ? "right" : dock === "right" ? "left" : "bottom";
    const result = positionFloating(anchor.getBoundingClientRect(), panel.getBoundingClientRect(), bounds, preferred);
    const origin = root.getBoundingClientRect();
    panel.style.left = `${result.x - origin.left - root.clientLeft + root.scrollLeft}px`;
    panel.style.top = `${result.y - origin.top - root.clientTop + root.scrollTop}px`;
    panel.dataset.placement = result.placement;
    panel.style.visibility = "visible";
    onLayout?.();
  };
  const dismiss = (event: PointerEvent) => {
    const target = event.target as Node;
    if (!panel.contains(target) && !anchor.contains(target)) close();
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); anchor.focus(); }
    else event.stopPropagation(); // Arrow keys belong to controls, never page navigation.
  };
  const stop = (event: Event) => event.stopPropagation();
  panel.addEventListener("keydown", keys);
  panel.addEventListener("pointerdown", stop);
  doc.addEventListener("pointerdown", dismiss, true);
  const unobserve = observeFloating(root, [anchor, panel], update);
  update();
  panel.focus({ preventScroll: true });
  return () => {
    unobserve();
    doc.removeEventListener("pointerdown", dismiss, true);
    panel.removeEventListener("keydown", keys);
    panel.removeEventListener("pointerdown", stop);
    anchor.setAttribute("aria-expanded", "false");
    if (panel.contains(doc.activeElement)) anchor.focus({ preventScroll: true });
  };
}
