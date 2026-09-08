import { App, Modal, Setting } from "obsidian";
import type { PageTemplate, TemplateKind, TemplateSpacing } from "../types";
import { drawTemplate, SPACING_LABELS, TEMPLATE_LABELS } from "../canvas/templates";

// Page-template picker: kind (with live mini previews), spacing, and whether
// the choice becomes the default for new pages of this note.

export class TemplateModal extends Modal {
  private kind: TemplateKind;
  private spacing: TemplateSpacing;
  private asDefault = false;
  private onApply: (t: PageTemplate, asNoteDefault: boolean) => void;
  private kindButtons = new Map<TemplateKind, HTMLElement>();

  constructor(
    app: App,
    current: PageTemplate | undefined,
    onApply: (t: PageTemplate, asNoteDefault: boolean) => void
  ) {
    super(app);
    this.kind = current?.kind ?? "blank";
    this.spacing = current?.spacing ?? "medium";
    this.onApply = onApply;
  }

  onOpen(): void {
    this.titleEl.setText("Page template");
    const { contentEl } = this;
    contentEl.addClass("ink-template-modal");

    const grid = contentEl.createDiv({ cls: "ink-template-grid" });
    (Object.keys(TEMPLATE_LABELS) as TemplateKind[]).forEach((kind) => {
      const cell = grid.createEl("button", { cls: "ink-template-cell", attr: { type: "button", "aria-label": TEMPLATE_LABELS[kind] } });
      const preview = cell.createEl("canvas", { cls: "ink-template-preview" });
      preview.width = 90;
      preview.height = 120;
      this.paintPreview(preview, kind);
      cell.createDiv({ cls: "ink-template-name", text: TEMPLATE_LABELS[kind] });
      cell.onclick = () => {
        this.kind = kind;
        this.syncSelection();
      };
      this.kindButtons.set(kind, cell);
    });

    new Setting(contentEl)
      .setName("Spacing")
      .setDesc("Grid / line density.")
      .addDropdown((d) => {
        (Object.keys(SPACING_LABELS) as TemplateSpacing[]).forEach((s) =>
          d.addOption(s, SPACING_LABELS[s])
        );
        d.setValue(this.spacing).onChange((v) => {
          this.spacing = v as TemplateSpacing;
          this.repaintPreviews();
        });
      });

    new Setting(contentEl)
      .setName("Use for new pages in this note")
      .addToggle((t) => t.setValue(this.asDefault).onChange((v) => (this.asDefault = v)));

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Apply")
        .setCta()
        .onClick(() => {
          this.onApply({ kind: this.kind, spacing: this.spacing }, this.asDefault);
          this.close();
        })
    );

    this.syncSelection();
  }

  private paintPreview(canvas: HTMLCanvasElement, kind: TemplateKind): void {
    const dpr = canvas.ownerDocument.defaultView?.devicePixelRatio || 1;
    canvas.width = Math.round(90 * dpr);
    canvas.height = Math.round(120 * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Previews render at ~1/4 page scale so the pattern is visible.
    ctx.setTransform(0.25 * dpr, 0, 0, 0.25 * dpr, 0, 0);
    drawTemplate(ctx, { kind, spacing: this.spacing }, 360, 480);
  }

  private repaintPreviews(): void {
    for (const [kind, cell] of this.kindButtons) {
      const canvas = cell.querySelector("canvas");
      if (canvas) this.paintPreview(canvas as HTMLCanvasElement, kind);
    }
  }

  private syncSelection(): void {
    for (const [kind, cell] of this.kindButtons) {
      cell.toggleClass("is-selected", kind === this.kind);
      cell.setAttribute("aria-pressed", String(kind === this.kind));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
