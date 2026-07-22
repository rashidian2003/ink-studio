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

    this.resizeObserver = new ResizeObserver(() => {
      if (this.state.position === "floating") this.applyState();
    });
    this.resizeObserver.observe(this.root);
    this.applyState();
  }

  destroy(): void {
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
    setToolIcon(this.positionButton, POSITION_ICONS[this.state.position]);
    this.positionButton.title = `Toolbar position: ${POSITION_LABELS[this.state.position]}`;
    this.positionButton.setAttribute(
      "aria-label",
      `Choose toolbar position. Current: ${POSITION_LABELS[this.state.position]}`
    );

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

  private openPositionMenu(event: MouseEvent): void {
    const menu = new Menu();
    const choices: ToolbarPosition[] = ["top", "bottom", "left", "right"];
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
