import { clamp, observeFloating, visibleBoundary } from "./floatingPosition";
import { Menu } from "obsidian";
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

const VIEW_MARGIN = 12;

const POSITION_LABELS: Record<ToolbarPosition, string> = {
  top: "Top",
  bottom: "Bottom",
  left: "Left side",
  right: "Right side",
  floating: "Floating",
};

const POSITION_ICONS: Record<ToolbarPosition, string> = {
  top: "panel-top",
  bottom: "panel-bottom",
  left: "panel-left",
  right: "panel-right",
  floating: "layout-grid",
};

/**
 * Adds direct edge docking and three density modes to an existing toolbar.
 * Tool ownership stays in InkView; this class only manages presentation and
 * persists a tiny serialisable state through its host.
 */
export class FloatingToolbarController {
  private root: HTMLElement;
  private bar: HTMLElement;
  private host: FloatingToolbarHost;
  private state: FloatingToolbarState;
  private positionButton: HTMLButtonElement;
  private compactButton: HTMLButtonElement;
  private hideButton: HTMLButtonElement;
  private revealButton: HTMLButtonElement;
  private disposeLayout: () => void;

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
    this.positionButton = this.bar.createEl("button", {
      cls: "ink-toolbar-control ink-toolbar-position",
      attr: {
        type: "button",
        title: "Toolbar position",
        "aria-label": "Choose toolbar position",
        "aria-haspopup": "menu",
      },
    });
    this.bar.prepend(this.positionButton);
    this.positionButton.onclick = (event) => this.openPositionMenu(event);

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

    this.disposeLayout = observeFloating(this.root, [this.bar], () => this.layout());
    this.applyState();
  }

  destroy(): void {
    this.disposeLayout();
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
    setToolIcon(this.positionButton, POSITION_ICONS[this.state.position]);
    this.positionButton.title = `Toolbar position: ${POSITION_LABELS[this.state.position]}`;
    this.positionButton.setAttribute(
      "aria-label",
      `Choose toolbar position. Current: ${POSITION_LABELS[this.state.position]}`
    );

    this.layout();
  }

  private layout(): void {
    const bounds = visibleBoundary(this.root);
    const origin = this.root.getBoundingClientRect();
    this.root.classList.toggle("is-narrow", origin.width < 600);
    const vertical = this.state.position === "left" || this.state.position === "right";
    this.bar.style.maxWidth = `${Math.max(0, Math.min(vertical ? 64 : Infinity, bounds.width - VIEW_MARGIN * 2))}px`;
    this.bar.style.maxHeight = `${Math.max(0, bounds.height - VIEW_MARGIN * 2)}px`;
    const size = this.bar.getBoundingClientRect();
    const minX = bounds.left - origin.left + VIEW_MARGIN;
    const minY = bounds.top - origin.top + VIEW_MARGIN;
    const maxX = bounds.left - origin.left + bounds.width - size.width - VIEW_MARGIN;
    const maxY = bounds.top - origin.top + bounds.height - size.height - VIEW_MARGIN;
    let x = (minX + maxX) / 2, y = (minY + maxY) / 2;
    if (this.state.position === "top") y = minY;
    if (this.state.position === "bottom") y = maxY;
    if (this.state.position === "left") x = minX;
    if (this.state.position === "right") x = maxX;
    if (this.state.position === "floating") { x = this.state.floatX; y = this.state.floatY; }
    // Clamp the display, preserving the saved preference for when space returns.
    this.bar.style.left = `${clamp(x, minX, maxX)}px`;
    this.bar.style.top = `${clamp(y, minY, maxY)}px`;
    this.bar.style.right = "auto";
    this.bar.style.bottom = "auto";
    this.bar.style.transform = "none";
    this.root.dispatchEvent(new Event("ink-toolbar-layout"));
  }

  private persist(): void {
    this.host.onStateChange(this.getState());
  }

  private openPositionMenu(event: MouseEvent): void {
    const menu = new Menu();
    const choices: ToolbarPosition[] = ["top", "bottom", "left", "right", "floating"];
    for (const position of choices) {
      menu.addItem((item) =>
        item
          .setTitle(POSITION_LABELS[position])
          .setIcon(POSITION_ICONS[position])
          .setChecked(this.state.position === position)
          .onClick(() => this.setPosition(position))
      );
    }
    menu.showAtMouseEvent(event);
  }
}
