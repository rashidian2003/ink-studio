import { mountFloatingSurface } from "./floatingSurface";
// Emoji sticker picker popover: curated grid + free input for anything else.

const CURATED = [
  "✅", "❌", "⭐", "🔥", "❗", "❓", "💡", "📌",
  "⚠️", "🎯", "🏆", "💯", "👍", "👎", "❤️", "🧠",
  "📖", "✏️", "🧪", "⚗️", "🧮", "📐", "💻", "🔬",
  "➡️", "⬅️", "⬆️", "⬇️", "🔁", "🔗", "🕐", "📅",
  "😀", "😅", "🤔", "😴", "🚀", "🎉", "☕", "📝",
];

export class StickerPicker {
  private root: HTMLElement;
  private onPick: (emoji: string) => void;
  private el: HTMLElement | null = null;
  private disposeSurface: (() => void) | null = null;

  constructor(root: HTMLElement, onPick: (emoji: string) => void) {
    this.root = root;
    this.onPick = onPick;
  }

  isOpen(): boolean {
    return this.el !== null;
  }

  close(): void {
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

  open(anchor: HTMLElement): void {
    this.close();
    const panel = this.root.createDiv({ cls: "ink-sticker-panel" });
    this.el = panel;

    const header = panel.createDiv({ cls: "ink-panel-header" });
    const heading = header.createDiv({ cls: "ink-panel-heading" });
    heading.createDiv({ cls: "ink-panel-title", text: "Stickers" });
    heading.createDiv({ cls: "ink-panel-subtitle", text: "Add a visual marker to this page" });

    const grid = panel.createDiv({ cls: "ink-sticker-grid" });
    for (const emoji of CURATED) {
      const btn = grid.createEl("button", { cls: "ink-sticker-btn", text: emoji, attr: { "aria-label": `Insert ${emoji}` } });
      btn.onclick = () => {
        this.onPick(emoji);
        this.close();
      };
    }

    // Free input: any emoji from the OS keyboard.
    const row = panel.createDiv({ cls: "ink-sticker-input-row" });
    const input = row.createEl("input", {
      attr: { type: "text", placeholder: "Any emoji…", maxlength: "8", "aria-label": "Custom emoji" },
      cls: "ink-sticker-input",
    }) as HTMLInputElement;
    const add = row.createEl("button", { text: "Add", cls: "mod-cta" });
    const commit = () => {
      const v = input.value.trim();
      if (v) {
        this.onPick(v);
        this.close();
      }
    };
    add.onclick = commit;
    input.onkeydown = (e) => {
      if (e.key === "Enter") commit();
    };

    this.disposeSurface = mountFloatingSurface(this.root, panel, anchor, () => this.close());
  }
}
