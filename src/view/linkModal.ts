import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type { InkLinkTarget } from "../types";
import { parseDocument } from "../types";

type LinkKind = "note" | "ink-page" | "address";

export class LinkModal extends Modal {
  private kind: LinkKind = "note";
  private targetValue = "";
  private label = "";
  private selectedPageId = "";
  private body!: HTMLElement;

  constructor(
    app: App,
    private initial: { target?: InkLinkTarget; label?: string },
    private onSubmit: (target: InkLinkTarget, label?: string) => void
  ) {
    super(app);
    this.label = initial.label ?? "";
    if (initial.target) {
      if (initial.target.type === "url") {
        this.kind = "address";
        this.targetValue = initial.target.url;
      } else if (initial.target.type === "ink-page") {
        this.kind = "ink-page";
        this.targetValue = initial.target.path;
        this.selectedPageId = initial.target.pageId;
      } else {
        this.kind = "note";
        this.targetValue = initial.target.path +
          (initial.target.type === "heading" ? `#${initial.target.heading}` : initial.target.type === "block" ? `#^${initial.target.blockId}` : "");
      }
    }
  }

  onOpen(): void {
    this.modalEl.addClass("ink-link-modal");
    this.contentEl.createEl("h2", { text: this.initial.target ? "Edit link" : "Create link" });
    const tabs = this.contentEl.createDiv({ cls: "ink-link-tabs" });
    ([['note', 'Note'], ['ink-page', 'Ink page'], ['address', 'Address']] as Array<[LinkKind, string]>).forEach(([kind, label]) => {
      const button = tabs.createEl("button", { text: label, cls: "ink-link-tab" });
      button.toggleClass("is-active", this.kind === kind);
      button.onclick = () => { this.kind = kind; this.targetValue = ""; this.selectedPageId = ""; this.render(); };
    });
    this.body = this.contentEl.createDiv({ cls: "ink-link-body" });
    this.render();
  }

  private render(): void {
    this.body.empty();
    this.contentEl.querySelectorAll(".ink-link-tab").forEach((el, index) =>
      (el as HTMLElement).toggleClass("is-active", index === ["note", "ink-page", "address"].indexOf(this.kind))
    );
    if (this.kind === "address") this.renderAddress();
    else this.renderVaultTarget();
    new Setting(this.body).setName("Label (optional)").addText((text) =>
      text.setPlaceholder("Related topic or chat").setValue(this.label).onChange((value) => { this.label = value; })
    );
    new Setting(this.body).addButton((button) =>
      button.setButtonText(this.initial.target ? "Save changes" : "Create link").setCta().onClick(() => void this.submit())
    );
  }

  private renderAddress(): void {
    new Setting(this.body).setName("URL or deep link").setDesc("Web, ChatGPT and app deep links are supported.").addText((text) =>
      text.setPlaceholder("https://chatgpt.com/c/…").setValue(this.targetValue).onChange((value) => { this.targetValue = value.trim(); })
    );
  }

  private renderVaultTarget(): void {
    const extensions = this.kind === "ink-page" ? new Set(["ink"]) : new Set(["md", "ink"]);
    const files = this.app.vault.getFiles().filter((file) => extensions.has(file.extension));
    const setting = new Setting(this.body).setName(this.kind === "ink-page" ? "Ink file" : "Note or file");
    setting.addDropdown((dropdown) => {
      dropdown.addOption("", "Choose a file…");
      files.forEach((file) => dropdown.addOption(file.path, file.path));
      dropdown.setValue(this.targetValue.split("#")[0]);
      dropdown.onChange((value) => { this.targetValue = value; if (this.kind === "ink-page") void this.renderInkPages(value); });
    });
    if (this.kind === "note") {
      new Setting(this.body).setName("Heading or block (optional)").setDesc("Use Heading or ^block-id.").addText((text) => {
        const fragment = this.targetValue.includes("#") ? this.targetValue.slice(this.targetValue.indexOf("#") + 1) : "";
        text.setPlaceholder("Heading or ^block-id").setValue(fragment).onChange((value) => {
          const path = this.targetValue.split("#")[0];
          this.targetValue = value.trim() ? `${path}#${value.trim()}` : path;
        });
      });
    } else if (this.targetValue) {
      void this.renderInkPages(this.targetValue);
    }
  }

  private async renderInkPages(path: string): Promise<void> {
    this.body.querySelector(".ink-link-pages")?.remove();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const document = parseDocument(await this.app.vault.read(file));
    const wrap = this.body.createDiv({ cls: "ink-link-pages" });
    wrap.createDiv({ cls: "setting-item-name", text: "Page" });
    const select = wrap.createEl("select", { cls: "dropdown" });
    document.pages.forEach((page, index) => select.createEl("option", {
      text: page.name || `Page ${index + 1}`,
      attr: { value: page.id },
    }));
    if (!document.pages.some((page) => page.id === this.selectedPageId)) this.selectedPageId = document.pages[0]?.id ?? "";
    select.value = this.selectedPageId;
    select.onchange = () => { this.selectedPageId = select.value; };
  }

  private async submit(): Promise<void> {
    let target: InkLinkTarget | null = null;
    if (this.kind === "address") {
      try {
        const url = new URL(this.targetValue);
        if (!url.protocol) throw new Error();
        target = { type: "url", url: url.toString() };
      } catch { new Notice("Ink Studio: enter a valid URL or deep link."); return; }
    } else if (this.kind === "ink-page") {
      if (this.targetValue && this.selectedPageId) target = { type: "ink-page", path: this.targetValue, pageId: this.selectedPageId };
    } else {
      const [path, fragment = ""] = this.targetValue.split("#", 2);
      if (path) target = fragment.startsWith("^")
        ? { type: "block", path, blockId: fragment.slice(1) }
        : fragment ? { type: "heading", path, heading: fragment }
        : { type: "vault-file", path };
    }
    if (!target) { new Notice("Ink Studio: choose a link destination."); return; }
    this.onSubmit(target, this.label.trim() || undefined);
    this.close();
  }
}
