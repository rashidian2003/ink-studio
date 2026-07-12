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
  private dismiss = (e: PointerEvent): void => {
    if (!this.el) return;
    if (this.el.contains(e.target as Node)) return;
    this.close();
  };

  constructor(root: HTMLElement, onPick: (emoji: string) => void) {
    this.root = root;
    this.onPick = onPick;
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

  open(anchor: HTMLElement): void {
    const panel = this.root.createDiv({ cls: "ink-sticker-panel" });
    this.el = panel;

    const rootRect = this.root.getBoundingClientRect();
    const aRect = anchor.getBoundingClientRect();
    panel.style.top = `${aRect.bottom - rootRect.top + 6}px`;
    panel.style.left = `${Math.max(8, Math.min(aRect.left - rootRect.left, rootRect.width - 300))}px`;

    const grid = panel.createDiv({ cls: "ink-sticker-grid" });
    for (const emoji of CURATED) {
      const btn = grid.createEl("button", { cls: "ink-sticker-btn", text: emoji });
      btn.onclick = () => {
        this.onPick(emoji);
        this.close();
      };
    }

    // Free input: any emoji from the OS keyboard.
    const row = panel.createDiv({ cls: "ink-sticker-input-row" });
    const input = row.createEl("input", {
      attr: { type: "text", placeholder: "Any emoji…", maxlength: "8" },
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

    window.setTimeout(
      () => document.addEventListener("pointerdown", this.dismiss, true),
      0
    );
  }
}
