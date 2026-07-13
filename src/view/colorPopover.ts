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
  private dismiss = (e: PointerEvent): void => {
    if (!this.el) return;
    if (this.el.contains(e.target as Node)) return;
    this.close();
  };

  constructor(root: HTMLElement, host: ColorPopoverHost) {
    this.root = root;
    this.host = host;
  }

  isOpen(): boolean {
    return this.el !== null;
  }

  close(): void {
    document.removeEventListener("pointerdown", this.dismiss, true);
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

    const rootRect = this.root.getBoundingClientRect();
    const aRect = anchor.getBoundingClientRect();
    panel.style.top = `${aRect.bottom - rootRect.top + 8}px`;
    panel.style.left = `${Math.max(
      8,
      Math.min(aRect.left - rootRect.left - 90, rootRect.width - 236)
    )}px`;

    // --- swatches ---
    const swatches = panel.createDiv({ cls: "ink-pop-swatches" });
    const current = this.host.getColor().toLowerCase();
    for (const color of this.host.settings.recentColors.slice(0, 10)) {
      const sw = swatches.createEl("button", {
        cls: "ink-swatch",
        attr: { title: color, "aria-label": `Colour ${color}` },
      });
      sw.style.backgroundColor = color;
      if (color.toLowerCase() === current) sw.addClass("is-active");
      sw.onclick = () => {
        this.host.setColor(color, false);
        this.open(anchor); // reflect the new active swatch
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
    hidden.oninput = () => {
      this.host.setColor(hidden.value, true);
      this.open(anchor);
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
        chip.addEventListener("pointerdown", (e: PointerEvent) => {
          if (e.pointerType !== "touch") return;
          const timer = window.setTimeout(() => remove(e.clientX, e.clientY), 550);
          const cancel = () => window.clearTimeout(timer);
          chip.addEventListener("pointerup", cancel, { once: true });
          chip.addEventListener("pointerleave", cancel, { once: true });
        });
      }
    }

    panel.createDiv({
      cls: "ink-pop-hint",
      text: "Tip: tap the active pen again for nib, size & stabilization.",
    });

    window.setTimeout(
      () => document.addEventListener("pointerdown", this.dismiss, true),
      0
    );
  }
}
