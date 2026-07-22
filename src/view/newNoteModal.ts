import { App, Modal, Setting, TFolder } from "obsidian";
import type { PageTemplate, TemplateKind, TemplateSpacing } from "../types";
import { drawTemplate, SPACING_LABELS, TEMPLATE_LABELS } from "../canvas/templates";

// "New ink note" dialog: pick the name, the target folder and the paper style
// before the note is created.

export interface NewNoteChoice {
  name: string;
  folder: string;
  template: PageTemplate;
}

export class NewNoteModal extends Modal {
  private name = "Ink note";
  private folder: string;
  private kind: TemplateKind = "blank";
  private spacing: TemplateSpacing = "medium";
  private onSubmit: (choice: NewNoteChoice) => void;
  private kindButtons = new Map<TemplateKind, HTMLElement>();

  constructor(app: App, initialFolder: string, onSubmit: (choice: NewNoteChoice) => void) {
    super(app);
    this.folder = initialFolder;
    this.onSubmit = onSubmit;
  }

  /** All folder paths in the vault, root first. */
  private folderOptions(): Record<string, string> {
    const out: Record<string, string> = { "": "/ (vault root)" };
    this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && f.path !== "/")
      .sort((a, b) => a.path.localeCompare(b.path))
      .forEach((f) => (out[f.path] = f.path));
    return out;
  }

  onOpen(): void {
    this.titleEl.setText("New ink note");
    const { contentEl } = this;
    contentEl.addClass("ink-new-note-modal");

    new Setting(contentEl).setName("Name").addText((t) => {
      t.setValue(this.name).onChange((v) => (this.name = v));
      window.setTimeout(() => {
        t.inputEl.focus();
        t.inputEl.select();
      }, 50);
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.submit();
      });
    });

    const folders = this.folderOptions();
    if (!(this.folder in folders)) this.folder = "";
    new Setting(contentEl)
      .setName("Folder")
      .setDesc("Where the note is saved.")
      .addDropdown((d) =>
        d
          .addOptions(folders)
          .setValue(this.folder)
          .onChange((v) => (this.folder = v))
      );

    contentEl.createEl("div", { cls: "ink-pop-label", text: "Paper" });
    const grid = contentEl.createDiv({ cls: "ink-template-grid" });
    (Object.keys(TEMPLATE_LABELS) as TemplateKind[]).forEach((kind) => {
      const cell = grid.createDiv({ cls: "ink-template-cell" });
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

    new Setting(contentEl).setName("Spacing").addDropdown((d) => {
      (Object.keys(SPACING_LABELS) as TemplateSpacing[]).forEach((s) =>
        d.addOption(s, SPACING_LABELS[s])
      );
      d.setValue(this.spacing).onChange((v) => {
        this.spacing = v as TemplateSpacing;
        this.repaintPreviews();
      });
    });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Create").setCta().onClick(() => this.submit())
    );

    this.syncSelection();
  }

  private submit(): void {
    const name = this.name.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || "Ink note";
    this.onSubmit({
      name,
      folder: this.folder,
      template: { kind: this.kind, spacing: this.spacing },
    });
    this.close();
  }

  private paintPreview(canvas: HTMLCanvasElement, kind: TemplateKind): void {
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(0.25, 0, 0, 0.25, 0, 0);
    drawTemplate(ctx, { kind, spacing: this.spacing }, canvas.width * 4, canvas.height * 4);
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
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
