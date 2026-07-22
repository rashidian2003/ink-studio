import { Plugin, TFolder, debounce, normalizePath, Notice } from "obsidian";
import { InkView, INK_VIEW_TYPE } from "./view/InkView";
import {
  DEFAULT_SETTINGS,
  InkStudioSettings,
  InkStudioSettingTab,
} from "./settings";
import { emptyDocument, serializeDocument, PageTemplate } from "./types";
import { clearPdfCache } from "./pdf/pdfRenderer";
import { NewNoteModal } from "./view/newNoteModal";

/** The file extension Ink Studio notes use. */
export const INK_EXTENSION = "ink";

export default class InkStudioPlugin extends Plugin {
  settings!: InkStudioSettings;
  saveSettingsDebounced!: () => void;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.saveSettingsDebounced = debounce(() => void this.saveSettings(), 400, true);

    // Register our view and bind the `.ink` extension to it so double-clicking
    // an .ink file in the file explorer opens the canvas directly.
    this.registerView(INK_VIEW_TYPE, (leaf) => new InkView(leaf, this));
    this.registerExtensions([INK_EXTENSION], INK_VIEW_TYPE);

    this.addRibbonIcon("pen", "New ink note", () => void this.createInkNote());

    this.addCommand({
      id: "create-ink-note",
      name: "Create new ink note",
      callback: () => void this.createInkNote(),
    });

    this.addSettingTab(new InkStudioSettingTab(this.app, this));
  }

  onunload(): void {
    // Views are torn down by Obsidian; free the parsed-PDF cache.
    clearPdfCache();
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data, {
      // Nested objects need an explicit merge so new tools get defaults.
      toolSizes: Object.assign({}, DEFAULT_SETTINGS.toolSizes, data.toolSizes),
      penConfigs: {
        pen: Object.assign({}, DEFAULT_SETTINGS.penConfigs.pen, data.penConfigs?.pen, {
          customPressureCurve: Array.isArray(data.penConfigs?.pen?.customPressureCurve)
            ? data.penConfigs.pen.customPressureCurve
            : DEFAULT_SETTINGS.penConfigs.pen.customPressureCurve.map((point) => ({
                ...point,
              })),
        }),
        pencil: Object.assign(
          {},
          DEFAULT_SETTINGS.penConfigs.pencil,
          data.penConfigs?.pencil,
          {
            customPressureCurve: Array.isArray(
              data.penConfigs?.pencil?.customPressureCurve
            )
              ? data.penConfigs.pencil.customPressureCurve
              : DEFAULT_SETTINGS.penConfigs.pencil.customPressureCurve.map((point) => ({
                  ...point,
                })),
          }
        ),
      },
      penPresets: Array.isArray(data.penPresets)
        ? data.penPresets.map((preset: Record<string, unknown>) => ({
            ...DEFAULT_SETTINGS.penConfigs.pen,
            ...preset,
            customPressureCurve: Array.isArray(preset.customPressureCurve)
              ? preset.customPressureCurve
              : DEFAULT_SETTINGS.penConfigs.pen.customPressureCurve.map((point) => ({
                  ...point,
                })),
          }))
        : [],
    });
    // Free dragging was replaced by a direct position menu in 0.17.0.
    // Keep old saved settings usable instead of leaving the toolbar stranded.
    if (this.settings.toolbarPosition === "floating") {
      this.settings.toolbarPosition = "bottom";
    }
    if (!data.inputMode) {
      this.settings.inputMode = data.fingerDrawing ? "pen-and-finger" : "pen-only";
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Re-render every open ink note (e.g. after a settings change). */
  refreshOpenViews(): void {
    this.app.workspace.getLeavesOfType(INK_VIEW_TYPE).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof InkView) view.refresh();
    });
  }

  /** Ask for name / folder / paper, then create and open the note. */
  createInkNote(): void {
    new NewNoteModal(this.app, this.activeFolderPath(), (choice) => {
      void this.createInkNoteAt(choice.name, choice.folder, choice.template);
    }).open();
  }

  private async createInkNoteAt(
    name: string,
    folder: string,
    template: PageTemplate
  ): Promise<void> {
    try {
      const doc = emptyDocument();
      if (template.kind !== "blank") {
        // Apply to the first page and as the note default for new pages.
        doc.defaultTemplate = { ...template };
        doc.pages[0].template = { ...template };
      }
      const path = this.uniquePath(folder, name, INK_EXTENSION);
      const file = await this.app.vault.create(path, serializeDocument(doc));
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(file);
    } catch (e) {
      console.error("Ink Studio: failed to create note", e);
      new Notice("Ink Studio: could not create the ink note.");
    }
  }

  private activeFolderPath(): string {
    const active = this.app.workspace.getActiveFile();
    if (active?.parent) return active.parent.path;
    const root = this.app.vault.getRoot();
    return root instanceof TFolder ? root.path : "";
  }

  private uniquePath(folder: string, base: string, ext: string): string {
    const dir = folder && folder !== "/" ? `${folder}/` : "";
    for (let i = 0; i < 1000; i++) {
      const name = i === 0 ? base : `${base} ${i}`;
      const candidate = normalizePath(`${dir}${name}.${ext}`);
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
    // Extremely unlikely fallback.
    return normalizePath(`${dir}${base}-${Date.now()}.${ext}`);
  }
}
