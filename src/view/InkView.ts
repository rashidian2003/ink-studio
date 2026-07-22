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
import { clusterLines, strokeBBox } from "../canvas/tidy";
import { flashcardStudioApiKey, GeminiError, transcribeHandwriting } from "../ai/gemini";
import { ThumbnailStrip } from "./thumbnailStrip";
import { PenPanel } from "./penPanel";
import { StickerPicker } from "./stickerPicker";
import { ColorPopover } from "./colorPopover";
import { TemplateModal } from "./templateModal";
import { TextBoxModal } from "./textModal";
import {
  CalligraphyModal,
  OcrResultModal,
  TidyModal,
  renderStrokesPreview,
} from "./aiModals";
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
  private colorPopover: ColorPopover | null = null;

  private canvasHost!: HTMLElement;
  private toolButtons = new Map<CanvasTool, HTMLElement>();
  private colorChip!: HTMLElement;
  private undoBtn!: HTMLElement;
  private redoBtn!: HTMLElement;
  private deleteImageBtn!: HTMLElement;
  private insertBtn!: HTMLElement;
  private lockBtn!: HTMLElement;
  private prevBtn!: HTMLElement;
  private nextBtn!: HTMLElement;
  private pageIndicator!: HTMLElement;

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
        // Presets appear in the colour popover; nothing to re-render inline.
      },
    });
    this.stickerPicker = new StickerPicker(root, (emoji) => {
      this.engine.addSticker(emoji);
      this.selectTool("select");
    });
    this.colorPopover = new ColorPopover(root, {
      settings: this.plugin.settings,
      getColor: () => this.currentColor,
      setColor: (c, remember) => this.setColor(c, remember),
      activatePreset: (p) => this.activatePreset(p),
      removePreset: (id) => {
        this.plugin.settings.penPresets = this.plugin.settings.penPresets.filter(
          (p) => p.id !== id
        );
        this.plugin.saveSettingsDebounced();
      },
    });

    this.buildToolbar(root);

    this.strip = new ThumbnailStrip(root, {
      getPages: () => this.doc.pages,
      getCurrentIndex: () => this.engine.getPageIndex(),
      getPressureMode: () => this.plugin.settings.pressureMode,
      getDark: () => this.isDarkPaper(),
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

    // In "auto" paper mode, follow Obsidian flipping between light/dark themes.
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        if (this.plugin.settings.paperTheme === "auto") this.refresh();
      })
    );

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
        if (this.engine.hasStrokeSelection()) {
          evt.preventDefault();
          this.engine.deleteSelectedStrokes();
        } else if (this.engine.hasSelection()) {
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
    this.colorPopover?.close();
    this.engine.destroy();
    this.assets?.destroy();
    if (this.stripRefreshTimer !== null) window.clearTimeout(this.stripRefreshTimer);
    this.contentEl.empty();
  }

  // --- toolbar -------------------------------------------------------------

  private buildToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "ink-toolbar" });

    // --- Group 1: core drawing tools. Second tap on the active pen-family
    // tool opens its full settings panel (nib, size, stabilization, colour).
    const toolsGroup = bar.createDiv({ cls: "ink-tb-group ink-tb-tools" });
    toolsGroup.setAttribute("aria-label", "Drawing tools");
    (Object.keys(STROKE_TOOL_ICONS) as ToolType[]).forEach((tool) => {
      const btn = this.makeToolButton(toolsGroup, tool, STROKE_TOOL_ICONS[tool], TOOL_LABELS[tool]);
      btn.onclick = () => {
        if (this.currentTool === tool) this.penPanel?.toggle(btn, tool);
        else {
          this.penPanel?.close();
          this.selectTool(tool);
        }
      };
    });

    bar.createDiv({ cls: "ink-tb-sep" });

    // --- Group 2: selection & text tools.
    const selGroup = bar.createDiv({ cls: "ink-tb-group ink-tb-selection" });
    selGroup.setAttribute("aria-label", "Selection tools");
    this.makeToolButton(
      selGroup,
      "lasso",
      "lasso",
      "Lasso — circle strokes to select them"
    ).onclick = () => this.selectTool("lasso");
    this.makeToolButton(
      selGroup,
      "select",
      "mouse-pointer",
      "Select / move images & stickers"
    ).onclick = () => this.selectTool("select");
    this.makeToolButton(selGroup, "text", "type", "Text — tap the page to place").onclick = () =>
      this.selectTool("text");

    this.deleteImageBtn = selGroup.createEl("button", {
      cls: "ink-tb-btn ink-delete-image",
      attr: { "aria-label": "Delete selected item", title: "Delete selected item" },
    });
    setToolIcon(this.deleteImageBtn, "trash-2");
    this.deleteImageBtn.onclick = () => this.engine.deleteSelectedImage();
    this.deleteImageBtn.hide();

    bar.createDiv({ cls: "ink-tb-sep" });

    // --- Group 3: colour and content actions.
    const contentGroup = bar.createDiv({ cls: "ink-tb-group ink-tb-content" });
    contentGroup.setAttribute("aria-label", "Colour and insert actions");
    this.colorChip = contentGroup.createEl("button", {
      cls: "ink-color-chip",
      attr: { "aria-label": "Colour", title: "Colour & pen box" },
    });
    this.colorChip.createDiv({ cls: "ink-color-chip-dot" });
    this.colorChip.onclick = () => this.colorPopover?.toggle(this.colorChip);
    this.updateColorChip();

    // --- Group 4: insert (shapes/table/ruler/sticker/image/pdf).
    this.insertBtn = contentGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Insert", title: "Insert shapes, table, image, PDF…" },
    });
    setToolIcon(this.insertBtn, "circle-plus");
    this.insertBtn.onclick = (e) => this.openInsertMenu(e);

    // --- Group 5: overflow (AI, template, overview, export, page ops).
    const moreBtn = contentGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "More", title: "AI tools, paper, export, page actions" },
    });
    setToolIcon(moreBtn, "more-vertical");
    moreBtn.onclick = (e) => this.openMoreMenu(e);

    bar.createDiv({ cls: "ink-tb-sep" });

    // --- Group 6: history.
    const historyGroup = bar.createDiv({ cls: "ink-tb-group ink-tb-history" });
    historyGroup.setAttribute("aria-label", "History");
    this.undoBtn = historyGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Undo", title: "Undo (Ctrl/Cmd+Z)" },
    });
    setToolIcon(this.undoBtn, "undo-2");
    this.undoBtn.onclick = () => this.engine.undo();

    this.redoBtn = historyGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Redo", title: "Redo (Shift+Ctrl/Cmd+Z)" },
    });
    setToolIcon(this.redoBtn, "redo-2");
    this.redoBtn.onclick = () => this.engine.redo();

    bar.createDiv({ cls: "ink-tb-sep" });

    // --- Group 7: page navigation.
    const pageGroup = bar.createDiv({ cls: "ink-tb-group ink-page-group" });
    pageGroup.setAttribute("aria-label", "Page navigation");
    this.prevBtn = pageGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Previous page", title: "Previous page" },
    });
    setToolIcon(this.prevBtn, "chevron-left");
    this.prevBtn.onclick = () => this.engine.goToPage(this.engine.getPageIndex() - 1);

    this.pageIndicator = pageGroup.createSpan({ cls: "ink-page-indicator", text: "1 / 1" });

    this.nextBtn = pageGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Next page", title: "Next page" },
    });
    setToolIcon(this.nextBtn, "chevron-right");
    this.nextBtn.onclick = () => this.engine.goToPage(this.engine.getPageIndex() + 1);

    const addPageBtn = pageGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Add page", title: "Add page (choose paper)" },
    });
    setToolIcon(addPageBtn, "plus");
    addPageBtn.onclick = (e) => this.openAddPageMenu(e);

    // Zoom lock: freeze the current zoom so it can't be resized by accident.
    this.lockBtn = pageGroup.createEl("button", {
      cls: "ink-tb-btn",
      attr: { "aria-label": "Lock zoom", title: "Lock zoom (stop accidental resizing)" },
    });
    setToolIcon(this.lockBtn, "lock-open");
    this.lockBtn.onclick = () => {
      this.engine.setZoomLocked(!this.engine.isZoomLocked());
      this.updateLockButton();
    };
    this.updateLockButton();
  }

  private updateLockButton(): void {
    if (!this.lockBtn) return;
    const locked = this.engine.isZoomLocked();
    setToolIcon(this.lockBtn, locked ? "lock" : "lock-open");
    this.lockBtn.toggleClass("is-active", locked);
    this.lockBtn.setAttribute(
      "title",
      locked ? "Zoom locked — tap to unlock" : "Lock zoom (stop accidental resizing)"
    );
  }

  private toggleOverview(): void {
    if (!this.strip) return;
    this.strip.setVisible(!this.strip.isVisible());
  }

  /** Create a tool button registered for active-state syncing. */
  private makeToolButton(
    parent: HTMLElement,
    tool: CanvasTool,
    icon: string,
    label: string
  ): HTMLElement {
    const btn = parent.createEl("button", {
      cls: "ink-tb-btn ink-tool-btn",
      attr: { "aria-label": label, title: label },
    });
    setToolIcon(btn, icon);
    this.toolButtons.set(tool, btn);
    return btn;
  }

  // --- toolbar menus ---------------------------------------------------------

  private openInsertMenu(e: MouseEvent): void {
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
    menu.addItem((i) =>
      i
        .setTitle("Table…")
        .setIcon("table")
        .onClick(() =>
          new TableModal(this.app, (rows, cols) => {
            this.activeShape = { kind: "table", rows, cols };
            this.selectTool("shape");
            new Notice("Ink Studio: drag on the page to place the table.");
          }).open()
        )
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle(this.engine.hasRuler() ? "Hide ruler" : "Ruler")
        .setIcon("ruler")
        .setChecked(this.engine.hasRuler())
        .onClick(() => this.engine.toggleRuler())
    );
    menu.addItem((i) =>
      i
        .setTitle("Sticker / emoji")
        .setIcon("smile")
        .onClick(() => this.stickerPicker?.toggle(this.insertBtn))
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Insert image")
        .setIcon("image")
        .onClick((evt) => this.openImageSourceMenu(evt as MouseEvent))
    );
    menu.addItem((i) =>
      i
        .setTitle("Import PDF")
        .setIcon("file-text")
        .onClick((evt) => this.openPdfSourceMenu(evt as MouseEvent))
    );
    menu.showAtMouseEvent(e);
  }

  private openImageSourceMenu(e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("Image from vault").setIcon("folder").onClick(() => void this.insertImageFlow("vault"))
    );
    menu.addItem((i) =>
      i
        .setTitle(Platform.isMobile ? "Image from gallery" : "Image from device")
        .setIcon("image")
        .onClick(() => void this.insertImageFlow("device"))
    );
    if (Platform.isMobile) {
      menu.addItem((i) =>
        i.setTitle("Take photo").setIcon("camera").onClick(() => void this.insertImageFlow("camera"))
      );
    }
    menu.showAtMouseEvent(e);
  }

  private openPdfSourceMenu(e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("PDF from vault").setIcon("folder").onClick(() => void this.importPdfFlow("vault"))
    );
    menu.addItem((i) =>
      i
        .setTitle("PDF from device")
        .setIcon("smartphone")
        .onClick(() => void this.importPdfFlow("device"))
    );
    menu.showAtMouseEvent(e);
  }

  private openMoreMenu(e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("Convert handwriting to text (AI)")
        .setIcon("file-text")
        .onClick(() => void this.convertHandwritingFlow())
    );
    menu.addItem((i) =>
      i
        .setTitle("Rewrite as calligraphy (AI)…")
        .setIcon("feather")
        .onClick(() => void this.calligraphyFlow())
    );
    menu.addItem((i) =>
      i.setTitle("Tidy up handwriting…").setIcon("wand-2").onClick(() => this.tidyHandwritingFlow())
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Page template…")
        .setIcon("layout-template")
        .onClick(() =>
          new TemplateModal(this.app, this.engine.getPageTemplate(), (t, asDefault) =>
            this.engine.setPageTemplate(t, asDefault)
          ).open()
        )
    );
    menu.addItem((i) =>
      i
        .setTitle("Export as annotated PDF")
        .setIcon("download")
        .onClick(() => this.chooseExport())
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Dark paper")
        .setIcon("moon")
        .setChecked(this.isDarkPaper())
        .onClick(() => {
          this.plugin.settings.paperTheme = this.isDarkPaper() ? "light" : "dark";
          void this.plugin.saveSettings();
          this.refresh();
        })
    );
    menu.addItem((i) =>
      i
        .setTitle(this.strip?.isVisible() ? "Hide page overview" : "Page overview")
        .setIcon("layout-grid")
        .onClick(() => this.toggleOverview())
    );
    menu.addItem((i) =>
      i.setTitle("Clear this page").setIcon("eraser").onClick(() => this.engine.clearPage())
    );
    menu.addItem((i) =>
      i
        .setTitle("Delete this page")
        .setIcon("trash-2")
        .onClick(() => this.confirmDeletePage(this.engine.getPageIndex()))
    );
    menu.showAtMouseEvent(e);
  }

  private openAddPageMenu(e: MouseEvent): void {
    const TEMPLATE_MENU_ICONS: Record<TemplateKind, string> = {
      blank: "file",
      grid: "grid-3x3",
      lined: "align-justify",
      dotted: "more-horizontal",
    };
    const menu = new Menu();
    const current = this.engine.getPageTemplate();
    const spacing = current?.spacing ?? this.doc.defaultTemplate?.spacing ?? "medium";
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
        .onClick(() =>
          new TemplateModal(this.app, current, (t, asDefault) => {
            this.addPageWithTemplate(t);
            if (asDefault) this.engine.setPageTemplate(t, true);
          }).open()
        )
    );
    menu.showAtMouseEvent(e);
  }

  /** Recolour the toolbar's colour chip to the current colour. */
  private updateColorChip(): void {
    const dot = this.colorChip?.querySelector<HTMLElement>(".ink-color-chip-dot");
    if (dot) dot.style.backgroundColor = this.currentColor;
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

  private selectTool(tool: CanvasTool): void {
    if (this.currentTool === "lasso" && tool !== "lasso") {
      this.engine.clearStrokeSelection();
    }
    this.currentTool = tool;
    if (tool !== "select" && tool !== "shape" && tool !== "text" && tool !== "lasso") {
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
    this.updateColorChip();
    this.colorPopover?.refreshIfOpen(this.colorChip);
  }

  private syncToolUI(): void {
    for (const [tool, btn] of this.toolButtons) {
      btn.toggleClass("is-active", tool === this.currentTool);
    }
    // The shape tool lives in the Insert menu, so mirror its active state there.
    this.insertBtn?.toggleClass("is-active", this.currentTool === "shape");
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
    this.updateColorChip();
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

  // --- AI handwriting flows ---------------------------------------------------

  /**
   * The strokes an AI action targets: the lasso selection when one exists,
   * otherwise the whole current page.
   */
  private scopedStrokes(): { strokes: import("../types").Stroke[]; selection: boolean } {
    if (this.engine.hasStrokeSelection()) {
      return { strokes: this.engine.getSelectedStrokes(), selection: true };
    }
    return {
      strokes: this.doc.pages[this.engine.getPageIndex()].strokes,
      selection: false,
    };
  }

  /** Render just these strokes (white background) for the OCR image. */
  private strokesToOcrBase64(strokes: import("../types").Stroke[]): string {
    const canvas = document.createElement("canvas");
    renderStrokesPreview(canvas, strokes, 1100);
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  }

  /** Estimate a text size matching the handwriting (median line height). */
  private estimateTextSize(strokes = this.doc.pages[this.engine.getPageIndex()].strokes): number {
    const lines = clusterLines(strokes);
    const heights = lines
      .map((line) => {
        let minY = Infinity;
        let maxY = -Infinity;
        for (const s of line) {
          const b = strokeBBox(s);
          minY = Math.min(minY, b.minY);
          maxY = Math.max(maxY, b.maxY);
        }
        return maxY - minY;
      })
      .filter((h) => h > 10)
      .sort((a, b) => a - b);
    const median = heights.length ? heights[Math.floor(heights.length / 2)] : 48;
    return Math.max(24, Math.min(64, Math.round(median * 0.7)));
  }

  private geminiKey(): string {
    return this.plugin.settings.geminiApiKey.trim() || flashcardStudioApiKey(this.app);
  }

  /** Option 1: OCR handwriting (lasso selection or page) into a text box. */
  private async convertHandwritingFlow(): Promise<void> {
    const { strokes, selection } = this.scopedStrokes();
    if (strokes.length === 0) {
      new Notice("Ink Studio: there is no handwriting on this page.");
      return;
    }
    if (!this.geminiKey()) {
      new Notice(
        "Ink Studio: no Gemini API key. Add one in Settings → Ink Studio (or install AI Flashcard Studio with a key)."
      );
      return;
    }

    const notice = new Notice("Ink Studio: recognizing handwriting…", 0);
    try {
      const text = await transcribeHandwriting(
        this.geminiKey(),
        this.plugin.settings.geminiModel,
        this.strokesToOcrBase64(strokes)
      );
      notice.hide();

      const size = this.estimateTextSize(strokes);
      new OcrResultModal(this.app, text, (finalText, removeStrokes) => {
        if (selection) {
          this.engine.applyOcrToSelection(finalText, size, this.currentColor, removeStrokes);
        } else {
          this.engine.applyOcrText(finalText, size, this.currentColor, removeStrokes);
        }
        this.selectTool("select");
        new Notice(
          removeStrokes
            ? "Ink Studio: converted — undo restores the handwriting."
            : "Ink Studio: text inserted above the handwriting."
        );
      }).open();
    } catch (e) {
      notice.hide();
      console.error("Ink Studio: OCR failed", e);
      new Notice(
        e instanceof GeminiError
          ? `Ink Studio: ${e.message}`
          : "Ink Studio: handwriting recognition failed. See console for details."
      );
    }
  }

  /**
   * OCR the handwriting (lasso selection or page), then re-render the text as
   * flowing cursive ink strokes — still ink, not a text box.
   */
  private async calligraphyFlow(): Promise<void> {
    const page = this.doc.pages[this.engine.getPageIndex()];
    const { strokes, selection } = this.scopedStrokes();
    if (strokes.length === 0) {
      new Notice("Ink Studio: there is no handwriting on this page.");
      return;
    }
    if (!this.geminiKey()) {
      new Notice(
        "Ink Studio: no Gemini API key. Add one in Settings → Ink Studio (or install AI Flashcard Studio with a key)."
      );
      return;
    }

    const notice = new Notice("Ink Studio: reading your handwriting…", 0);
    try {
      const text = await transcribeHandwriting(
        this.geminiKey(),
        this.plugin.settings.geminiModel,
        this.strokesToOcrBase64(strokes)
      );
      notice.hide();

      // Lay the rewritten ink where the original writing starts.
      const x = Math.max(
        40,
        Math.min(...strokes.map((s) => Math.min(...s.points.map((p) => p.x))))
      );
      const y = Math.max(
        40,
        Math.min(...strokes.map((s) => Math.min(...s.points.map((p) => p.y))))
      );
      new CalligraphyModal(
        this.app,
        text,
        {
          x,
          y,
          size: this.estimateTextSize(strokes),
          color: this.currentColor,
          strokeSize: Math.max(3, this.plugin.settings.toolSizes.pen),
          maxWidth: page.width - x - 60,
        },
        (generated) => {
          if (selection) this.engine.replaceSelectedStrokes(generated);
          else this.engine.replacePageStrokes(generated);
          new Notice("Ink Studio: rewritten in calligraphy — undo restores the original.");
        }
      ).open();
    } catch (e) {
      notice.hide();
      console.error("Ink Studio: calligraphy flow failed", e);
      new Notice(
        e instanceof GeminiError
          ? `Ink Studio: ${e.message}`
          : "Ink Studio: handwriting recognition failed. See console for details."
      );
    }
  }

  /** Option 2: offline geometric tidy-up (lasso selection or whole page). */
  private tidyHandwritingFlow(): void {
    const { strokes, selection } = this.scopedStrokes();
    if (strokes.length === 0) {
      new Notice("Ink Studio: there is no handwriting on this page.");
      return;
    }
    new TidyModal(this.app, strokes, (tidied) => {
      if (selection) this.engine.replaceSelectedStrokes(tidied);
      else this.engine.replacePageStrokes(tidied);
      new Notice("Ink Studio: handwriting tidied — undo restores the original.");
    }).open();
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
  isDarkPaper(): boolean {
    const t = this.plugin.settings.paperTheme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return document.body.classList.contains("theme-dark");
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
  onTextPlaceRequested(x: number, y: number): void {
    new TextBoxModal(
      this.app,
      { text: "", size: 42, isNew: true },
      (r) => {
        this.engine.addTextBox(r.text, x, y, r.size, this.currentColor);
        this.selectTool("select");
      }
    ).open();
  }
  onTextEditRequested(textId: string): void {
    const t = this.engine.getTextBox(textId);
    if (!t) return;
    new TextBoxModal(
      this.app,
      { text: t.text, size: t.size, isNew: false },
      (r) => this.engine.updateTextBox(textId, { text: r.text, size: r.size }),
      () => this.engine.deleteTextBox(textId)
    ).open();
  }
  onStrokeSelection(count: number, anchor: { x: number; y: number } | null): void {
    if (count === 0 || !anchor) {
      if (count === 0 && anchor === null) {
        new Notice("Ink Studio: no strokes inside the lasso.");
      }
      return;
    }
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle(`Tidy up (${count} strokes)…`)
        .setIcon("wand-2")
        .onClick(() => this.tidyHandwritingFlow())
    );
    menu.addItem((i) =>
      i
        .setTitle("Rewrite as calligraphy (AI)…")
        .setIcon("feather")
        .onClick(() => void this.calligraphyFlow())
    );
    menu.addItem((i) =>
      i
        .setTitle("Convert to text (AI)")
        .setIcon("file-text")
        .onClick(() => void this.convertHandwritingFlow())
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Delete strokes")
        .setIcon("trash-2")
        .onClick(() => this.engine.deleteSelectedStrokes())
    );
    menu.addItem((i) =>
      i
        .setTitle("Deselect")
        .setIcon("x")
        .onClick(() => this.engine.clearStrokeSelection())
    );
    menu.showAtPosition({ x: anchor.x, y: anchor.y });
  }
}
