import { setToolIcon } from "./icons";

export type ToolbarMode = "full" | "compact" | "hidden";
export type ToolbarPosition = "top" | "bottom" | "left" | "right" | "floating";

export interface FloatingToolbarState {
  mode: ToolbarMode;
  position: ToolbarPosition;
  floatX: number;
  floatY: number;
}

export interface FloatingToolbarHost {
  onStateChange(state: FloatingToolbarState): void;
}

const EDGE_SNAP_PX = 72;
const VIEW_MARGIN = 12;

/**
 * Adds docking, dragging and three density modes to an existing toolbar.
 * Tool ownership stays in InkView; this class only manages presentation and
 * persists a tiny serialisable state through its host.
 */
export class FloatingToolbarController {
  private root: HTMLElement;
  private bar: HTMLElement;
  private host: FloatingToolbarHost;
  private state: FloatingToolbarState;
  private handle: HTMLButtonElement;
  private compactButton: HTMLButtonElement;
  private hideButton: HTMLButtonElement;
  private revealButton: HTMLButtonElement;
  private resizeObserver: ResizeObserver;

  constructor(
    root: HTMLElement,
    bar: HTMLElement,
    state: FloatingToolbarState,
    host: FloatingToolbarHost
  ) {
    this.root = root;
    this.bar = bar;
    this.host = host;
    this.state = { ...state };

    this.bar.addClass("ink-toolbar-floating");
    this.handle = this.bar.createEl("button", {
      cls: "ink-toolbar-handle",
      attr: {
        type: "button",
        title: "Move toolbar",
        "aria-label": "Move toolbar",
      },
    });
    this.bar.prepend(this.handle);
    setToolIcon(this.handle, "grip-vertical");

    const controls = this.bar.createDiv({ cls: "ink-toolbar-controls" });
    this.compactButton = controls.createEl("button", {
      cls: "ink-toolbar-control ink-toolbar-compact",
      attr: {
        type: "button",
        title: "Compact toolbar",
        "aria-label": "Compact toolbar",
      },
    });
    setToolIcon(this.compactButton, "minimize-2");
    this.compactButton.onclick = () => this.setMode("compact");

    this.hideButton = controls.createEl("button", {
      cls: "ink-toolbar-control ink-toolbar-hide",
      attr: {
        type: "button",
        title: "Hide toolbar",
        "aria-label": "Hide toolbar",
      },
    });
    setToolIcon(this.hideButton, "eye-off");
    this.hideButton.onclick = () => this.setMode("hidden");

    this.revealButton = controls.createEl("button", {
      cls: "ink-toolbar-control ink-toolbar-reveal",
      attr: {
        type: "button",
        title: "Show toolbar",
        "aria-label": "Show toolbar",
      },
    });
    setToolIcon(this.revealButton, "panel-top-open");
    this.revealButton.onclick = () => this.setMode("full");

    this.handle.addEventListener("pointerdown", this.onDragStart);
    this.resizeObserver = new ResizeObserver(() => {
      if (this.state.position === "floating") this.applyState();
    });
    this.resizeObserver.observe(this.root);
    this.applyState();
  }

  destroy(): void {
    this.handle.removeEventListener("pointerdown", this.onDragStart);
    this.resizeObserver.disconnect();
  }

  getState(): FloatingToolbarState {
    return { ...this.state };
  }

  setMode(mode: ToolbarMode): void {
    if (this.state.mode === mode) return;
    this.state.mode = mode;
    this.applyState();
    this.persist();
  }

  setPosition(position: ToolbarPosition): void {
    const changed = this.state.position !== position;
    this.state.position = position;
    this.applyState();
    if (changed) this.persist();
  }

  private applyState(): void {
    this.bar.dataset.mode = this.state.mode;
    this.bar.dataset.position = this.state.position;

    if (this.state.position === "floating") {
      const rect = this.root.getBoundingClientRect();
      const barRect = this.bar.getBoundingClientRect();
      const maxX = Math.max(VIEW_MARGIN, rect.width - barRect.width - VIEW_MARGIN);
      const maxY = Math.max(VIEW_MARGIN, rect.height - barRect.height - VIEW_MARGIN);
      this.state.floatX = Math.max(VIEW_MARGIN, Math.min(this.state.floatX, maxX));
      this.state.floatY = Math.max(VIEW_MARGIN, Math.min(this.state.floatY, maxY));
      this.bar.style.left = `${this.state.floatX}px`;
      this.bar.style.top = `${this.state.floatY}px`;
      this.bar.style.removeProperty("right");
      this.bar.style.removeProperty("bottom");
    } else {
      this.bar.style.removeProperty("left");
      this.bar.style.removeProperty("right");
      this.bar.style.removeProperty("top");
      this.bar.style.removeProperty("bottom");
    }
  }

  private persist(): void {
    this.host.onStateChange(this.getState());
  }

  private onDragStart = (event: PointerEvent): void => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    event.preventDefault();
    event.stopPropagation();

    const rootRect = this.root.getBoundingClientRect();
    const barRect = this.bar.getBoundingClientRect();
    const offsetX = event.clientX - barRect.left;
    const offsetY = event.clientY - barRect.top;
    this.state.position = "floating";
    this.bar.dataset.position = "floating";
    this.bar.addClass("is-dragging");
    this.handle.setPointerCapture(event.pointerId);

    const onMove = (move: PointerEvent): void => {
      const currentBar = this.bar.getBoundingClientRect();
      const maxX = Math.max(VIEW_MARGIN, rootRect.width - currentBar.width - VIEW_MARGIN);
      const maxY = Math.max(VIEW_MARGIN, rootRect.height - currentBar.height - VIEW_MARGIN);
      this.state.floatX = Math.max(
        VIEW_MARGIN,
        Math.min(move.clientX - rootRect.left - offsetX, maxX)
      );
      this.state.floatY = Math.max(
        VIEW_MARGIN,
        Math.min(move.clientY - rootRect.top - offsetY, maxY)
      );
      this.bar.style.left = `${this.state.floatX}px`;
      this.bar.style.top = `${this.state.floatY}px`;
    };

    const onEnd = (up: PointerEvent): void => {
      this.handle.removeEventListener("pointermove", onMove);
      this.handle.removeEventListener("pointerup", onEnd);
      this.handle.removeEventListener("pointercancel", onEnd);
      this.bar.removeClass("is-dragging");
      try {
        this.handle.releasePointerCapture(up.pointerId);
      } catch {
        // Capture may already be released by a mobile WebView.
      }

      const r = this.bar.getBoundingClientRect();
      const distances: Array<[ToolbarPosition, number]> = [
        ["left", r.left - rootRect.left],
        ["right", rootRect.right - r.right],
        ["top", r.top - rootRect.top],
        ["bottom", rootRect.bottom - r.bottom],
      ];
      distances.sort((a, b) => a[1] - b[1]);
      this.state.position =
        distances[0][1] <= EDGE_SNAP_PX ? distances[0][0] : "floating";
      this.applyState();
      this.persist();
    };

    this.handle.addEventListener("pointermove", onMove);
    this.handle.addEventListener("pointerup", onEnd);
    this.handle.addEventListener("pointercancel", onEnd);
  };
}
