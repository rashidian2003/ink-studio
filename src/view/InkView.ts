import {
  TextFileView,
  WorkspaceLeaf,
  Menu,
  Modal,
  Notice,
  Platform,
  Setting,
  App,
} from "obsidian";
import { setToolIcon } from "./icons";
import type InkStudioPlugin from "../main";
import {
  CanvasTool,
  InkDocument,
  InkPage,
  PageTemplate,
  ShapeKind,
  ShapeSpec,
  TemplateKind,
  ToolType,
  emptyDocument,
  pageIsEmpty,
  parseDocument,
  serializeDocument,
} from "../types";
import { TEMPLATE_LABELS } from "../canvas/templates";
import { CanvasEngine, EngineHost } from "../canvas/CanvasEngine";
import { AssetCache } from "../assets";
import { ThumbnailStrip } from "./thumbnailStrip";
import { PenPanel } from "./penPanel";
import { StickerPicker } from "./stickerPicker";
import { TemplateModal } from "./templateModal";
import type { PenConfig, PenPreset } from "../settings";
import {
  buildPdfPages,
  pickDeviceFile,
  pickVaultFile,
  saveBinaryToVault,
} from "../importers";
import { exportAnnotatedPdf } from "../pdf/pdfExport";

export const INK_VIEW_TYPE = "ink-studio-view";

const STROKE_TOOL_ICONS: Record<ToolType, string> = {
  pen: "pen",
  pencil: "pencil",
  highlighter: "highlighter",
  eraser: "eraser",
};

const TOOL_LABELS: Record<ToolType, string> = {
  pen: "Pen",
  pencil: "Pencil",
  highlighter: "Highlighter",
  eraser: "Eraser",
};

const SHAPE_ICONS: Record<Exclude<ShapeKind, "table">, string> = {
  rect: "square",
  ellipse: "circle",
  triangle: "triangle",
  line: "minus",
  arrow: "arrow-up-right",
};

const SHAPE_LABELS: Record<Exclude<ShapeKind, "table">, string> = {
  rect: "Rectangle",
  ellipse: "Ellipse",
  triangle: "Triangle",
  line: "Line",
  arrow: "Arrow",
};

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];

/** Small rows × columns prompt for the table tool. */
class TableModal extends Modal {
  private rows = 3;
  private cols = 3;
  private onSubmit: (rows: number, cols: number) => void;

  constructor(app: App, onSubmit: (rows: number, cols: number) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    this.titleEl.setText("Insert table");
    new Setting(this.contentEl).setName("Rows").addSlider((s) =>
      s
        .setLimits(1, 10, 1)
        .setValue(this.rows)
        .setDynamicTooltip()
        .onChange((v) => (this.rows = v))
    );
    new Setting(this.contentEl).setName("Columns").addSlider((s) =>
      s
        .setLimits(1, 10, 1)
        .setValue(this.cols)
        .setDynamicTooltip()
        .onChange((v) => (this.cols = v))
    );
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Drag on the page to place")
        .setCta()
        .onClick(() => {
          this.onSubmit(this.rows, this.cols);
          this.close();
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * The Ink Studio note view. Backed by TextFileView so it plugs directly into
 * Obsidian's file lifecycle: the framework reads the `.ink` file, hands us the
 * body via setViewData, tracks the dirty state, and calls getViewData whenever
 * a save is requested (including our stroke-triggered requestSave autosaves).
 */
export class InkView extends TextFileView implements EngineHost {
  plugin: InkStudioPlugin;
  doc: InkDocument = emptyDocument();
  private engine: CanvasEngine;
  private assets!: AssetCache;
  private strip: ThumbnailStrip | null = null;
  private penPanel: PenPanel | null = null;
  private stickerPicker: StickerPicker | null = null;

  private canvasHost!: HTMLElement;
  private toolButtons = new Map<CanvasTool, HTMLElement>();
  private presetBar!: HTMLElement;
  private swatchBar!: HTMLElement;
  private sizeSlider!: HTMLInputElement;
  private undoBtn!: HTMLElement;
  private redoBtn!: HTMLElement;
  private deleteImageBtn!: HTMLElement;
  private prevBtn!: HTMLElement;
  private nextBtn!: HTMLElement;
  private pageIndicator!: HTMLElement;
  private rulerBtn!: HTMLElement;
  private shapeBtn!: HTMLElement;

  private currentTool: CanvasTool;
  private currentColor: string;
  private activeShape: ShapeSpec | null = null;
  private stripRefreshTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: InkStudioPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentTool = plugin.settings.lastTool;
    this.currentColor = plugin.settings.color;
    this.engine = new CanvasEngine(this, this.doc);
  }

  getViewType(): string {
    return INK_VIEW_TYPE;
  }

  getIcon(): string {
    return "pen";
  }

  getDisplayText(): string {
    return this.file?.basename ?? "Ink note";
  }

  // --- TextFileView data plumbing -----------------------------------------

  getViewData(): string {
    return serializeDocument(this.doc);
  }

  setViewData(data: string, _clear: boolean): void {
    this.doc = parseDocument(data);
    this.engine.setDocument(this.doc);
    this.updateHistoryButtons();
  }

  clear(): void {
    this.doc = emptyDocument();
    this.engine.setDocument(this.doc);
  }

  // --- view lifecycle ------------------------------------------------------

  async onOpen(): Promise<void> {
    this.assets = new AssetCache(this.app, () => {
      this.engine.refresh();
      this.queueStripRefresh();
    });

    const root = this.contentEl;
    root.empty();
    root.addClass("ink-studio-view");

    this.penPanel = new PenPanel(root, {
      settings: this.plugin.settings,
      getColor: () => this.currentColor,
      setColor: (c, remember) => this.setColor(c, remember),
      onConfigChanged: () => {
        this.plugin.saveSettingsDebounced();
        this.syncToolUI();
        this.engine.refresh();
      },
      addPreset: (preset: PenPreset) => {
        this.plugin.settings.penPresets.push(preset);
        this.plugin.saveSettingsDebounced();
        this.renderPresetChips();
      },
    });
    this.stickerPicker = new StickerPicker(root, (emoji) => {
      this.engine.addSticker(emoji);
      this.selectTool("select");
    });

    this.buildToolbar(root);

    this.strip = new ThumbnailStrip(root, {
      getPages: () => this.doc.pages,
      getCurrentIndex: () => this.engine.getPageIndex(),
      getPressureMode: () => this.plugin.settings.pressureMode,
      resolveBackground: (p: InkPage) => this.assets.resolveBackground(p),
      resolveImage: (p: string) => this.assets.resolveImage(p),
      onSelect: (i) => this.engine.goToPage(i),
      onDelete: (i) => this.confirmDeletePage(i),
      onMove: (from, to) => this.engine.movePage(from, to),
    });

    this.canvasHost = root.createDiv({ cls: "ink-canvas-host" });
    this.engine.mount(this.canvasHost);
    this.engine.setDocument(this.doc);

    this.syncToolUI();
    this.updateHistoryButtons();

    // Clipboard paste (images) while this view is active.
    this.registerDomEvent(document, "paste", (evt: ClipboardEvent) => {
      if (this.app.workspace.getActiveViewOfType(InkView) !== this) return;
      void this.handlePaste(evt);
    });

    // Drag-drop image files onto the canvas.
    this.registerDomEvent(this.canvasHost, "dragover", (evt: DragEvent) => {
      evt.preventDefault();
    });
    this.registerDomEvent(this.canvasHost, "drop", (evt: DragEvent) => {
      evt.preventDefault();
      void this.handleDrop(evt);
    });

    // Desktop keyboard shortcuts, only while this view is focused/active.
    this.registerDomEvent(window, "keydown", (evt: KeyboardEvent) => {
      if (this.app.workspace.getActiveViewOfType(InkView) !== this) return;
      const target = evt.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const mod = evt.ctrlKey || evt.metaKey;
      const key = evt.key.toLowerCase();
      if (mod && key === "z" && !evt.shiftKey) {
        evt.preventDefault();
        this.engine.undo();
      } else if ((mod && key === "z" && evt.shiftKey) || (mod && key === "y")) {
        evt.preventDefault();
        this.engine.redo();
      } else if (!mod && (evt.key === "Delete" || evt.key === "Backspace")) {
        if (this.engine.hasSelection()) {
          evt.preventDefault();
          this.engine.deleteSelectedImage();
        }
      } else if (!mod && evt.key === "ArrowLeft") {
        this.engine.goToPage(this.engine.getPageIndex() - 1);
      } else if (!mod && evt.key === "ArrowRight") {
        this.engine.goToPage(this.engine.getPageIndex() + 1);
      } else if (evt.key === "Escape") {
        this.penPanel?.close();
        this.stickerPicker?.close();
      }
    });
  }

  async onClose(): Promise<void> {
    this.penPanel?.close();
    this.stickerPicker?.close();
    this.engine.destroy();
    this.assets?.destroy();
    if (this.stripRefreshTimer !== null) window.clearTimeout(this.stripRefreshTimer);
    this.contentEl.empty();
  }

  // --- toolbar -------------------------------------------------------------

  private buildToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "ink-toolbar" });

    // Stroke tools + select. Tapping the active tool again opens its panel.
    const toolsGroup = bar.createDiv({ cls: "ink-tb-group" });
    (Object.keys(STROKE_TOOL_ICONS) as ToolType[]).forEach((tool) => {
      const btn = toolsGroup.createEl("button", {
        cls: "ink-tb-btn ink-tool-btn",
        attr: { "aria-label": TOOL_LABELS[tool], title: TOOL_LABELS[tool] },
      });
      setToolIcon(btn, STROKE_TOOL_ICONS[tool]);
      btn.onclick = () => {
        if (this.currentTool === tool) {
          this.penPanel?.toggle(btn, tool);
        } else {
          this.penPanel?.close();
          this.selectTool(tool);
        }
      };
      this.toolButtons.set(tool, btn);
    });

    const selectBtn = toolsGroup.createEl("button", {
      cls: "ink-tb-btn ink-tool-btn",
      attr: { "aria-label": "Select", title: "Select / move images & stickers" },
    });
    setToolIcon(selectBtn, "mouse-pointer");
    selectBtn.onclick = () => this.selectTool("select");
    this.toolButtons.set("select", selectBtn);

    // Shape tool: pick a shape, then drag on the page.
    this.shapeBtn = toolsGroup.createEl("button", {
      cls: "ink-tb-btn ink-tool-btn",
      attr: { "aria-label": "Shapes", title: "Shapes (drag on the page)" },
    });
    setToolIcon(this.shapeBtn, "shapes");
    this.shapeBtn.onclick = (e) => {
      const menu = new Menu();
      (Object.keys(SHAPE_ICONS) as Array<Exclude<ShapeKind, "table">>).forEach((kind) => {
        menu.addItem((i) =>
          i
            .setTitle(SHAPE_LABELS[kind])
            .setIcon(SHAPE_ICONS[kind])
            .setChecked(this.activeShape?.kind === kind && this.currentTool === "shape")
            .onClick(() => {
              this.activeShape = { kind };
              this.selectTool("shape");
            })
        );
      });
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle("Table…")
          .setIcon("table")
          .onClick(() => {
            new TableModal(this.app, (rows, cols) => {
              this.activeShape = { kind: "table", rows, cols };
              this.selectTool("shape");
              new Notice("Ink Studio: drag on the page to place the table.");
            }).open();
          })
      );
      menu.showAtMouseEvent(e);
    };
    this.toolButtons.set("shape", this.shapeBtn);

    // Ruler toggle.
    this.rulerBtn = toolsGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Ruler", title: "Ruler (strokes near its edge snap straight)" },
    });
    setToolIcon(this.rulerBtn, "ruler");
    this.rulerBtn.onclick = () => {
      this.engine.toggleRuler();
      this.rulerBtn.toggleClass("is-active", this.engine.hasRuler());
    };

    // Sticker picker.
    const stickerBtn = toolsGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Stickers", title: "Insert sticker/emoji" },
    });
    setToolIcon(stickerBtn, "smile");
    stickerBtn.onclick = () => this.stickerPicker?.toggle(stickerBtn);

    this.deleteImageBtn = toolsGroup.createEl("button", {
      cls: "ink-tb-btn ink-delete-image mod-warning",
      attr: { "aria-label": "Delete selected item", title: "Delete selected item" },
    });
    setToolIcon(this.deleteImageBtn, "trash-2");
    this.deleteImageBtn.onclick = () => this.engine.deleteSelectedImage();
    this.deleteImageBtn.hide();

    // Pen box: saved pen presets as one-tap chips.
    this.presetBar = bar.createDiv({ cls: "ink-tb-group ink-preset-bar" });
    this.renderPresetChips();

    // Colours
    this.swatchBar = bar.createDiv({ cls: "ink-tb-group ink-swatches" });
    this.renderSwatches();

    const picker = bar.createEl("input", {
      cls: "ink-color-picker",
      attr: { type: "color", title: "Pick a colour" },
    }) as HTMLInputElement;
    picker.value = this.currentColor;
    picker.oninput = () => this.setColor(picker.value, true);

    // Size
    const sizeGroup = bar.createDiv({ cls: "ink-tb-group ink-size-group" });
    sizeGroup.createSpan({ cls: "ink-tb-label", text: "Size" });
    this.sizeSlider = sizeGroup.createEl("input", {
      cls: "ink-size-slider",
      attr: { type: "range", min: "1", max: "60", step: "1", title: "Stroke width" },
    }) as HTMLInputElement;
    this.sizeSlider.oninput = () => {
      const tool = this.sizeSliderTool();
      if (!tool) return;
      this.plugin.settings.toolSizes[tool] = parseInt(this.sizeSlider.value, 10);
      this.plugin.saveSettingsDebounced();
    };

    // History
    const actions = bar.createDiv({ cls: "ink-tb-group ink-tb-actions" });
    this.undoBtn = actions.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Undo", title: "Undo (Ctrl/Cmd+Z)" },
    });
    setToolIcon(this.undoBtn, "undo-2");
    this.undoBtn.onclick = () => this.engine.undo();

    this.redoBtn = actions.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Redo", title: "Redo (Shift+Ctrl/Cmd+Z)" },
    });
    setToolIcon(this.redoBtn, "redo-2");
    this.redoBtn.onclick = () => this.engine.redo();

    // Page navigation
    const pageGroup = bar.createDiv({ cls: "ink-tb-group ink-page-group" });
    this.prevBtn = pageGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Previous page", title: "Previous page" },
    });
    setToolIcon(this.prevBtn, "chevron-left");
    this.prevBtn.onclick = () => this.engine.goToPage(this.engine.getPageIndex() - 1);

    this.pageIndicator = pageGroup.createSpan({
      cls: "ink-page-indicator",
      text: "1 / 1",
    });

    this.nextBtn = pageGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Next page", title: "Next page" },
    });
    setToolIcon(this.nextBtn, "chevron-right");
    this.nextBtn.onclick = () => this.engine.goToPage(this.engine.getPageIndex() + 1);

    // Add page: pick the paper (template) upfront, before writing.
    const addPageBtn = pageGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Add page", title: "Add page (choose paper)" },
    });
    setToolIcon(addPageBtn, "plus");
    const TEMPLATE_MENU_ICONS: Record<TemplateKind, string> = {
      blank: "file",
      grid: "grid-3x3",
      lined: "align-justify",
      dotted: "more-horizontal",
    };
    addPageBtn.onclick = (e) => {
      const menu = new Menu();
      const current = this.engine.getPageTemplate();
      const spacing =
        current?.spacing ?? this.doc.defaultTemplate?.spacing ?? "medium";
      menu.addItem((i) =>
        i
          .setTitle("Same paper as this page")
          .setIcon("copy")
          .onClick(() =>
            this.addPageWithTemplate(current ? { ...current } : { kind: "blank", spacing })
          )
      );
      menu.addSeparator();
      (Object.keys(TEMPLATE_MENU_ICONS) as TemplateKind[]).forEach((kind) => {
        menu.addItem((i) =>
          i
            .setTitle(TEMPLATE_LABELS[kind])
            .setIcon(TEMPLATE_MENU_ICONS[kind])
            .onClick(() => this.addPageWithTemplate({ kind, spacing }))
        );
      });
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle("More options…")
          .setIcon("settings-2")
          .onClick(() => {
            new TemplateModal(this.app, current, (t, asDefault) => {
              this.addPageWithTemplate(t);
              if (asDefault) this.engine.setPageTemplate(t, true);
            }).open();
          })
      );
      menu.showAtMouseEvent(e);
    };

    // Change the paper of the page you're on — one tap, not buried in ⋮.
    const templateBtn = pageGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Page template", title: "Paper style for this page" },
    });
    setToolIcon(templateBtn, "layout-template");
    templateBtn.onclick = () => {
      new TemplateModal(this.app, this.engine.getPageTemplate(), (t, asDefault) =>
        this.engine.setPageTemplate(t, asDefault)
      ).open();
    };

    const stripBtn = pageGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Page overview", title: "Show/hide page overview" },
    });
    setToolIcon(stripBtn, "layout-grid");
    stripBtn.onclick = () => {
      const strip = this.strip;
      if (!strip) return;
      strip.setVisible(!strip.isVisible());
      stripBtn.toggleClass("is-active", strip.isVisible());
    };

    // Insert / import
    const insertGroup = bar.createDiv({ cls: "ink-tb-group" });
    const pdfBtn = insertGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Import PDF", title: "Import PDF to annotate" },
    });
    setToolIcon(pdfBtn, "file-plus");
    pdfBtn.onclick = (e) => {
      const menu = new Menu();
      menu.addItem((i) =>
        i
          .setTitle("PDF from vault")
          .setIcon("folder")
          .onClick(() => void this.importPdfFlow("vault"))
      );
      menu.addItem((i) =>
        i
          .setTitle("PDF from device")
          .setIcon("smartphone")
          .onClick(() => void this.importPdfFlow("device"))
      );
      menu.showAtMouseEvent(e);
    };

    const imgBtn = insertGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Insert image", title: "Insert image" },
    });
    setToolIcon(imgBtn, "image-plus");
    imgBtn.onclick = (e) => {
      const menu = new Menu();
      menu.addItem((i) =>
        i
          .setTitle("Image from vault")
          .setIcon("folder")
          .onClick(() => void this.insertImageFlow("vault"))
      );
      menu.addItem((i) =>
        i
          .setTitle(Platform.isMobile ? "Image from gallery" : "Image from device")
          .setIcon("image")
          .onClick(() => void this.insertImageFlow("device"))
      );
      if (Platform.isMobile) {
        menu.addItem((i) =>
          i
            .setTitle("Take photo")
            .setIcon("camera")
            .onClick(() => void this.insertImageFlow("camera"))
        );
      }
      menu.showAtMouseEvent(e);
    };

    // Overflow menu: template, export, destructive page ops.
    const moreBtn = insertGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "More actions", title: "More actions" },
    });
    setToolIcon(moreBtn, "more-vertical");
    moreBtn.onclick = (e) => {
      const menu = new Menu();
      menu.addItem((i) =>
        i
          .setTitle("Export as annotated PDF")
          .setIcon("download")
          .onClick(() => this.chooseExport())
      );
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle("Clear this page")
          .setIcon("eraser")
          .onClick(() => this.engine.clearPage())
      );
      menu.addItem((i) =>
        i
          .setTitle("Delete this page")
          .setIcon("trash-2")
          .onClick(() => this.confirmDeletePage(this.engine.getPageIndex()))
      );
      menu.showAtMouseEvent(e);
    };
  }

  private renderPresetChips(): void {
    if (!this.presetBar) return;
    this.presetBar.empty();
    for (const preset of this.plugin.settings.penPresets) {
      const chip = this.presetBar.createEl("button", {
        cls: "ink-preset-chip",
        attr: { title: "Saved pen (long-press to remove)" },
      });
      setToolIcon(chip, "pen");
      chip.style.color = preset.color;
      chip.style.borderColor = preset.color;

      chip.onclick = () => this.activatePreset(preset);

      // Remove via right-click (desktop) or long-press (touch).
      const showRemoveMenu = (x: number, y: number) => {
        const menu = new Menu();
        menu.addItem((i) =>
          i
            .setTitle("Remove from pen box")
            .setIcon("trash-2")
            .onClick(() => {
              this.plugin.settings.penPresets =
                this.plugin.settings.penPresets.filter((p) => p.id !== preset.id);
              this.plugin.saveSettingsDebounced();
              this.renderPresetChips();
            })
        );
        menu.showAtPosition({ x, y });
      };
      chip.oncontextmenu = (e) => {
        e.preventDefault();
        showRemoveMenu(e.clientX, e.clientY);
      };
      chip.addEventListener("pointerdown", (e: PointerEvent) => {
        if (e.pointerType !== "touch") return;
        const timer = window.setTimeout(() => {
          showRemoveMenu(e.clientX, e.clientY);
        }, 550);
        const cancel = () => window.clearTimeout(timer);
        chip.addEventListener("pointerup", cancel, { once: true });
        chip.addEventListener("pointerleave", cancel, { once: true });
      });
    }
  }

  /** Load a saved pen into the pen tool and switch to it. */
  private activatePreset(preset: PenPreset): void {
    const s = this.plugin.settings;
    s.penConfigs.pen = {
      nib: preset.nib,
      pressurePct: preset.pressurePct,
      stabilizationPct: preset.stabilizationPct,
    };
    s.toolSizes.pen = preset.size;
    this.setColor(preset.color, false);
    this.plugin.saveSettingsDebounced();
    this.selectTool("pen");
  }

  /** Add a fresh page carrying the chosen paper, ready to write on. */
  private addPageWithTemplate(t: PageTemplate): void {
    this.engine.addPage();
    this.engine.setPageTemplate(t, false);
  }

  private chooseExport(): void {
    const anyTemplate = this.doc.pages.some((p) => !p.bg && p.template);
    if (!anyTemplate) {
      void this.exportPdfFlow(true);
      return;
    }
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("Export with page template")
        .setIcon("layout-template")
        .onClick(() => void this.exportPdfFlow(true))
    );
    menu.addItem((i) =>
      i
        .setTitle("Export ink only (no template)")
        .setIcon("pen")
        .onClick(() => void this.exportPdfFlow(false))
    );
    const rect = this.pageIndicator.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
  }

  private confirmDeletePage(index: number): void {
    const page = this.doc.pages[index];
    if (!page) return;
    if (pageIsEmpty(page)) {
      this.engine.deletePage(index);
      return;
    }
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle(`Delete page ${index + 1} and its contents?`)
        .setIcon("trash-2")
        .onClick(() => this.engine.deletePage(index))
    );
    menu.addItem((i) => i.setTitle("Cancel").setIcon("x"));
    const rect = this.pageIndicator.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
  }

  private renderSwatches(): void {
    this.swatchBar.empty();
    for (const color of this.plugin.settings.recentColors.slice(0, 5)) {
      const sw = this.swatchBar.createEl("button", {
        cls: "ink-swatch",
        attr: { title: color, "aria-label": `Colour ${color}` },
      });
      sw.style.backgroundColor = color;
      if (color.toLowerCase() === this.currentColor.toLowerCase()) {
        sw.addClass("is-active");
      }
      sw.onclick = () => this.setColor(color, false);
    }
  }

  private selectTool(tool: CanvasTool): void {
    this.currentTool = tool;
    if (tool !== "select" && tool !== "shape") {
      this.plugin.settings.lastTool = tool;
      this.plugin.saveSettingsDebounced();
    }
    this.syncToolUI();
    // Leaving select mode hides the selection chrome.
    this.engine.refresh();
  }

  private setColor(color: string, remember: boolean): void {
    this.currentColor = color;
    this.plugin.settings.color = color;
    if (remember) {
      const rc = this.plugin.settings.recentColors.filter(
        (c) => c.toLowerCase() !== color.toLowerCase()
      );
      rc.unshift(color);
      this.plugin.settings.recentColors = rc.slice(0, 8);
    }
    this.plugin.saveSettingsDebounced();
    // Picking a colour while erasing implies you want to draw again.
    if (this.currentTool === "eraser") {
      this.currentTool = "pen";
      this.syncToolUI();
    }
    this.renderSwatches();
  }

  /** Which tool the main size slider edits right now. */
  private sizeSliderTool(): ToolType | null {
    if (this.currentTool === "select") return null;
    if (this.currentTool === "shape") return "pen";
    return this.currentTool;
  }

  private syncToolUI(): void {
    for (const [tool, btn] of this.toolButtons) {
      btn.toggleClass("is-active", tool === this.currentTool);
    }
    const sizeTool = this.sizeSliderTool();
    if (this.sizeSlider && sizeTool) {
      this.sizeSlider.value = String(this.plugin.settings.toolSizes[sizeTool]);
    }
    this.sizeSlider?.toggleAttribute("disabled", sizeTool === null);
    this.rulerBtn?.toggleClass("is-active", this.engine.hasRuler());
  }

  private updateHistoryButtons(): void {
    this.undoBtn?.toggleClass("is-disabled", !this.engine.canUndo());
    this.redoBtn?.toggleClass("is-disabled", !this.engine.canRedo());
  }

  private queueStripRefresh(): void {
    if (!this.strip?.isVisible()) return;
    if (this.stripRefreshTimer !== null) window.clearTimeout(this.stripRefreshTimer);
    this.stripRefreshTimer = window.setTimeout(() => {
      this.stripRefreshTimer = null;
      this.strip?.render();
    }, 400);
  }

  /** Called by the plugin when settings change externally. */
  refresh(): void {
    this.engine.refresh();
    this.renderSwatches();
    this.renderPresetChips();
    this.syncToolUI();
    this.queueStripRefresh();
  }

  // --- import / insert flows ------------------------------------------------

  private async importPdfFlow(source: "vault" | "device"): Promise<void> {
    try {
      let pdfPath: string | null = null;

      if (source === "vault") {
        const file = await pickVaultFile(this.app, ["pdf"], "Pick a PDF to annotate…");
        pdfPath = file?.path ?? null;
      } else {
        const file = await pickDeviceFile("application/pdf");
        if (file) {
          const saved = await saveBinaryToVault(
            this.app,
            await file.arrayBuffer(),
            file.name || "imported.pdf",
            this.file?.path ?? ""
          );
          pdfPath = saved.path;
        }
      }
      if (!pdfPath) return;

      const notice = new Notice("Ink Studio: reading PDF…", 0);
      let pages: InkPage[];
      try {
        pages = await buildPdfPages(this.app, pdfPath);
      } finally {
        notice.hide();
      }
      if (pages.length === 0) {
        new Notice("Ink Studio: that PDF has no pages.");
        return;
      }

      // A brand-new note with one untouched page gets replaced outright;
      // otherwise the PDF is appended after the existing pages.
      const replaceAll = this.doc.pages.length === 1 && pageIsEmpty(this.doc.pages[0]);
      this.engine.insertPages(pages, replaceAll ? 0 : this.doc.pages.length);
      if (replaceAll) this.engine.deletePage(pages.length);

      new Notice(`Ink Studio: imported ${pages.length} PDF page(s). Write away!`);
    } catch (e) {
      console.error("Ink Studio: PDF import failed", e);
      new Notice("Ink Studio: could not import that PDF. See console for details.");
    }
  }

  private async insertImageFlow(source: "vault" | "device" | "camera"): Promise<void> {
    try {
      let path: string | null = null;

      if (source === "vault") {
        const file = await pickVaultFile(this.app, IMAGE_EXTENSIONS, "Pick an image…");
        path = file?.path ?? null;
      } else {
        const file = await pickDeviceFile(
          "image/*",
          source === "camera" ? "environment" : undefined
        );
        if (file) {
          const saved = await saveBinaryToVault(
            this.app,
            await file.arrayBuffer(),
            file.name || "photo.jpg",
            this.file?.path ?? ""
          );
          path = saved.path;
        }
      }
      if (!path) return;

      await this.placeImage(path);
    } catch (e) {
      console.error("Ink Studio: image insert failed", e);
      new Notice("Ink Studio: could not insert that image.");
    }
  }

  /** Load an image's natural size, then hand it to the engine. */
  private async placeImage(path: string): Promise<void> {
    const el = await this.assets.loadImageElement(path);
    this.engine.addImage(path, el.naturalWidth || 300, el.naturalHeight || 300);
    // Manipulating the fresh image is the natural next step.
    this.selectTool("select");
    this.queueStripRefresh();
  }

  private async handlePaste(evt: ClipboardEvent): Promise<void> {
    const items = Array.from(evt.clipboardData?.items ?? []);
    const imageItem = items.find((i) => i.type.startsWith("image/"));
    if (!imageItem) return;
    evt.preventDefault();
    const blob = imageItem.getAsFile();
    if (!blob) return;
    try {
      const ext = (imageItem.type.split("/")[1] || "png").replace("jpeg", "jpg");
      const saved = await saveBinaryToVault(
        this.app,
        await blob.arrayBuffer(),
        `pasted-image.${ext}`,
        this.file?.path ?? ""
      );
      await this.placeImage(saved.path);
    } catch (e) {
      console.error("Ink Studio: paste failed", e);
      new Notice("Ink Studio: could not paste that image.");
    }
  }

  private async handleDrop(evt: DragEvent): Promise<void> {
    const file = Array.from(evt.dataTransfer?.files ?? []).find((f) =>
      f.type.startsWith("image/")
    );
    if (!file) return;
    try {
      const saved = await saveBinaryToVault(
        this.app,
        await file.arrayBuffer(),
        file.name || "dropped-image.png",
        this.file?.path ?? ""
      );
      await this.placeImage(saved.path);
    } catch (e) {
      console.error("Ink Studio: drop failed", e);
      new Notice("Ink Studio: could not insert the dropped image.");
    }
  }

  private async exportPdfFlow(includeTemplates: boolean): Promise<void> {
    if (!this.file) return;
    const notice = new Notice("Ink Studio: exporting annotated PDF…", 0);
    try {
      const outPath = await exportAnnotatedPdf(
        this.app,
        this.doc,
        this.file.path,
        this.assets,
        this.plugin.settings.pressureMode,
        { includeTemplates },
        (done, total) => notice.setMessage(`Ink Studio: exporting page ${done}/${total}…`)
      );
      notice.hide();
      new Notice(`Ink Studio: exported to "${outPath}"`);
    } catch (e) {
      notice.hide();
      console.error("Ink Studio: PDF export failed", e);
      new Notice("Ink Studio: PDF export failed. See console for details.");
    }
  }

  // --- EngineHost ----------------------------------------------------------

  getTool(): CanvasTool {
    return this.currentTool;
  }
  getColor(): string {
    return this.currentColor;
  }
  getSize(tool: ToolType): number {
    return this.plugin.settings.toolSizes[tool];
  }
  getPressureMode() {
    return this.plugin.settings.pressureMode;
  }
  getToolConfig(tool: "pen" | "pencil"): PenConfig {
    return this.plugin.settings.penConfigs[tool];
  }
  getActiveShape(): ShapeSpec | null {
    return this.currentTool === "shape" ? this.activeShape : null;
  }
  isFingerDrawing(): boolean {
    return this.plugin.settings.fingerDrawing;
  }
  resolveBackground(page: InkPage): CanvasImageSource | null {
    return this.assets.resolveBackground(page);
  }
  resolveImage(path: string): CanvasImageSource | null {
    return this.assets.resolveImage(path);
  }
  onChange(): void {
    this.requestSave();
    this.queueStripRefresh();
  }
  onHistoryChange(): void {
    this.updateHistoryButtons();
  }
  onPageChanged(index: number, count: number): void {
    if (this.pageIndicator) {
      this.pageIndicator.setText(`${index + 1} / ${count}`);
    }
    this.prevBtn?.toggleClass("is-disabled", index <= 0);
    this.nextBtn?.toggleClass("is-disabled", index >= count - 1);
    this.strip?.render();
  }
  onSelectionChange(hasSelection: boolean): void {
    if (!this.deleteImageBtn) return;
    if (hasSelection) this.deleteImageBtn.show();
    else this.deleteImageBtn.hide();
  }
}
