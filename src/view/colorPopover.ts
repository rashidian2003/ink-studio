import { mountFloatingSurface } from "./floatingSurface";
import { Menu, setIcon } from "obsidian";
import type { InkStudioSettings, PenPreset } from "../settings";

// Compact colour + pen-box popover, opened from the single colour chip in the
// toolbar. Folds the old inline swatch row, custom-colour picker and preset
// chips into one tidy surface so the toolbar itself stays minimal.

export interface ColorPopoverHost {
  settings: InkStudioSettings;
  getColor(): string;
  setColor(color: string, remember: boolean): void;
  activatePreset(preset: PenPreset): void;
  removePreset(id: string): void;
}

export class ColorPopover {
  private root: HTMLElement;
  private host: ColorPopoverHost;
  private el: HTMLElement | null = null;
  private pressCleanups: Array<() => void> = [];
  private disposeSurface: (() => void) | null = null;

  constructor(root: HTMLElement, host: ColorPopoverHost) {
    this.root = root;
    this.host = host;
  }

  isOpen(): boolean {
    return this.el !== null;
  }

  close(): void {
    this.pressCleanups.splice(0).forEach(cleanup => cleanup());
    this.disposeSurface?.();
    this.disposeSurface = null;
    this.el?.remove();
    this.el = null;
  }

  toggle(anchor: HTMLElement): void {
    if (this.el) {
      this.close();
      return;
    }
    this.open(anchor);
  }

  /** Rebuild in place if open (e.g. after the colour changed elsewhere). */
  refreshIfOpen(anchor: HTMLElement): void {
    if (this.el) this.open(anchor);
  }

  private open(anchor: HTMLElement): void {
    this.close();
    const panel = this.root.createDiv({ cls: "ink-color-popover" });
    this.el = panel;

    const header = panel.createDiv({ cls: "ink-panel-header" });
    const heading = header.createDiv({ cls: "ink-panel-heading" });
    heading.createDiv({ cls: "ink-panel-title", text: "Ink colour" });
    heading.createDiv({ cls: "ink-panel-subtitle", text: "Recent colours and saved pens" });

    // --- swatches ---
    const swatches = panel.createDiv({ cls: "ink-pop-swatches" });
    const current = this.host.getColor().toLowerCase();
    for (const color of this.host.settings.recentColors.slice(0, 10)) {
      const sw = swatches.createEl("button", {
        cls: "ink-swatch",
        attr: { title: color, "aria-label": `Colour ${color}` },
      });
      sw.style.backgroundColor = color;
      sw.setAttribute("aria-pressed", String(color.toLowerCase() === current));
      if (color.toLowerCase() === current) sw.addClass("is-active");
      sw.onclick = () => {
        this.host.setColor(color, false);
        // Host refreshes the current surface.
      };
    }
    const add = swatches.createEl("button", {
      cls: "ink-swatch ink-swatch-add",
      attr: { title: "Custom colour", "aria-label": "Custom colour" },
    });
    setIcon(add, "plus");
    const hidden = swatches.createEl("input", {
      attr: { type: "color" },
      cls: "ink-hidden-color-input",
    }) as HTMLInputElement;
    hidden.value = this.host.getColor();
    add.onclick = () => hidden.click();
    hidden.onchange = () => {
      this.host.setColor(hidden.value, true);
    };

    const detail = panel.createEl("label", { cls: "ink-color-detail", text: "HEX" });
    const hex = detail.createEl("input", { attr: { type: "text", "aria-label": "Hex colour", maxlength: "7", spellcheck: "false" } });
    hex.value = this.host.getColor();
    hex.onchange = () => {
      const value = hex.value.startsWith("#") ? hex.value : `#${hex.value}`;
      const valid = /^#[0-9a-f]{6}$/i.test(value);
      hex.setAttribute("aria-invalid", String(!valid));
      if (valid) this.host.setColor(value, true);
    };

    // --- pen box ---
    const presets = this.host.settings.penPresets;
    if (presets.length > 0) {
      panel.createDiv({ cls: "ink-pop-label", text: "Pen box" });
      const box = panel.createDiv({ cls: "ink-pop-presets" });
      for (const preset of presets) {
        const chip = box.createEl("button", {
          cls: "ink-preset-chip",
          attr: { title: "Saved pen — long-press to remove" },
        });
        setIcon(chip, "pen");
        chip.style.color = preset.color;
        chip.style.borderColor = preset.color;
        chip.onclick = () => {
          this.host.activatePreset(preset);
          this.close();
        };
        const remove = (x: number, y: number) => {
          const menu = new Menu();
          menu.addItem((i) =>
            i
              .setTitle("Remove from pen box")
              .setIcon("trash-2")
              .onClick(() => {
                this.host.removePreset(preset.id);
                this.open(anchor);
              })
          );
          menu.showAtPosition({ x, y });
        };
        chip.oncontextmenu = (e) => {
          e.preventDefault();
          remove(e.clientX, e.clientY);
        };
        let timer: number | undefined;
        let held = false;
        const cancel = () => { window.clearTimeout(timer); timer = undefined; };
        chip.addEventListener("pointerdown", (event: PointerEvent) => {
          cancel(); held = false;
          if (event.pointerType === "touch") timer = window.setTimeout(() => {
            held = true; remove(event.clientX, event.clientY);
          }, 550);
        });
        for (const type of ["pointerup", "pointerleave", "pointercancel"]) chip.addEventListener(type, cancel);
        chip.addEventListener("click", event => {
          if (held) { event.preventDefault(); event.stopImmediatePropagation(); held = false; }
        }, true);
        this.pressCleanups.push(cancel);
        // Context menu also works with the keyboard menu key / Shift+F10.
        chip.setAttribute("aria-label", `Saved ${preset.nib} pen, ${preset.color}. Context menu to remove`);

      }
    }

    panel.createDiv({
      cls: "ink-pop-hint",
      text: "Tip: tap the active pen again for nib, size & stabilization.",
    });

    this.disposeSurface = mountFloatingSurface(this.root, panel, anchor, () => this.close());
  }
}
