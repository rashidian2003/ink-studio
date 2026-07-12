import { App, Modal, Setting } from "obsidian";

// Create/edit dialog for typed text boxes. A Modal (rather than an on-canvas
// inline editor) is deliberate: it is the one text-input surface that works
// identically with the on-screen keyboard on Android and the desktop.

export interface TextModalResult {
  text: string;
  size: number;
}

export class TextBoxModal extends Modal {
  private text: string;
  private size: number;
  private isNew: boolean;
  private onSave: (r: TextModalResult) => void;
  private onDelete?: () => void;

  constructor(
    app: App,
    initial: { text: string; size: number; isNew: boolean },
    onSave: (r: TextModalResult) => void,
    onDelete?: () => void
  ) {
    super(app);
    this.text = initial.text;
    this.size = initial.size;
    this.isNew = initial.isNew;
    this.onSave = onSave;
    this.onDelete = onDelete;
  }

  onOpen(): void {
    this.titleEl.setText(this.isNew ? "Add text" : "Edit text");
    const { contentEl } = this;

    const area = contentEl.createEl("textarea", {
      cls: "ink-text-modal-area",
      attr: { rows: "5", placeholder: "Type here…" },
    }) as HTMLTextAreaElement;
    area.value = this.text;
    area.oninput = () => (this.text = area.value);
    window.setTimeout(() => area.focus(), 50);

    new Setting(contentEl).setName("Text size").addSlider((s) =>
      s
        .setLimits(20, 120, 2)
        .setValue(this.size)
        .setDynamicTooltip()
        .onChange((v) => (this.size = v))
    );

    const buttons = new Setting(contentEl);
    if (!this.isNew && this.onDelete) {
      buttons.addButton((b) =>
        b
          .setButtonText("Delete")
          .setWarning()
          .onClick(() => {
            this.onDelete?.();
            this.close();
          })
      );
    }
    buttons.addButton((b) =>
      b
        .setButtonText(this.isNew ? "Add" : "Save")
        .setCta()
        .onClick(() => {
          const trimmed = this.text.trim();
          if (trimmed) this.onSave({ text: trimmed, size: this.size });
          this.close();
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
