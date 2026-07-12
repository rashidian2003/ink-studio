import type {
  CanvasTool,
  InkDocument,
  InkImage,
  InkPage,
  PressureMode,
  ShapeSpec,
  Stroke,
  StrokePoint,
  ToolType,
} from "../types";
import { makeId, newPage } from "../types";
import { drawStroke, defaultOpacity } from "./strokeRender";
import { drawTemplate } from "./templates";
import { drawEmoji } from "./pageRender";
import { shapeStrokes } from "./shapes";
import { pressurePctToThinning, type PenConfig } from "../settings";

/**
 * The host (InkView) supplies tool state, resolves external assets (PDF page
 * backgrounds, images) and receives change notifications. Keeping this behind
 * an interface means the engine never has to know about Obsidian or the DOM
 * toolbar.
 */
export interface EngineHost {
  getTool(): CanvasTool;
  getColor(): string;
  getSize(tool: ToolType): number;
  getPressureMode(): PressureMode;
  /** Nib/pressure/stabilization for the pen-family tools. */
  getToolConfig(tool: "pen" | "pencil"): PenConfig;
  /** Which shape the shape tool draws (null when the tool is inactive). */
  getActiveShape(): ShapeSpec | null;
  isFingerDrawing(): boolean;
  /**
   * Synchronously return a renderable background / image from the host's
   * cache, or null while it loads. The host triggers engine.refresh() once an
   * asset finishes loading, so pages fill in as assets arrive.
   */
  resolveBackground(page: InkPage): CanvasImageSource | null;
  resolveImage(path: string): CanvasImageSource | null;
  /** Called when document content changed and should be autosaved. */
  onChange(): void;
  /** Called when the undo/redo availability changed. */
  onHistoryChange(): void;
  /** Called after the visible page or the page count changed. */
  onPageChanged(index: number, count: number): void;
  /** Called when the image selection appears/disappears. */
  onSelectionChange(hasSelection: boolean): void;
}

const HISTORY_LIMIT = 60;

/** Everything undo/redo restores for a page: its ink and its images. */
interface PageSnapshot {
  strokes: Stroke[];
  images: InkImage[];
}

interface PageHistory {
  undo: PageSnapshot[];
  redo: PageSnapshot[];
}

/** In-flight image manipulation with the select tool. */
interface ImageGesture {
  kind: "move" | "resize";
  imageId: string;
  /** Image rect at gesture start. */
  start: { x: number; y: number; w: number; h: number };
  /** Pointer position at gesture start, page units. */
  px: number;
  py: number;
  /** For resize: which corner is being dragged (0=NW,1=NE,2=SE,3=SW). */
  corner: number;
}

/** Touch-swipe tracking for page navigation. */
interface SwipeTrack {
  pointerId: number;
  x: number;
  y: number;
  t: number;
}

/** In-flight drag of the shape tool. */
interface ShapeDrag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The on-canvas ruler guide (transient view state, not persisted). */
interface RulerState {
  cx: number;
  cy: number;
  /** Radians. */
  angle: number;
  len: number;
}

interface RulerGesture {
  mode: "move" | "rotate";
  /** Pointer position at gesture start, page units. */
  px: number;
  py: number;
  start: RulerState;
}

/** Ruler bar thickness in page units. */
const RULER_H = 56;
/** Strokes starting within this distance of a ruler edge snap to it. */
const RULER_SNAP_DIST = 34;

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Owns the drawing surface for a single note and renders one page at a time.
 * Uses two stacked canvases:
 *  - `base`  holds background + images + every committed stroke; fully redrawn
 *            only on structural change (page switch, undo, erase, resize,
 *            image drag).
 *  - `live`  holds just the in-progress stroke or the selection chrome,
 *            cleared and redrawn on each pointer move. This keeps input
 *            latency low: inking only re-renders the current stroke.
 */
export class CanvasEngine {
  private host: EngineHost;
  private doc: InkDocument;
  private pageIndex = 0;

  private wrapper!: HTMLElement;
  private base!: HTMLCanvasElement;
  private live!: HTMLCanvasElement;
  private baseCtx!: CanvasRenderingContext2D;
  private liveCtx!: CanvasRenderingContext2D;

  private dpr = 1;
  private scale = 1; // page units -> CSS pixels
  private resizeObserver: ResizeObserver | null = null;

  // Active stroke state
  private activePointerId: number | null = null;
  private current: Stroke | null = null;
  private simulate = false;
  private penEverUsed = false;
  private penLastSeen = 0;
  private erasing = false;
  private gestureChanged = false;
  private snapshotBeforeGesture: PageSnapshot | null = null;

  // Select-tool state
  private selectedImageId: string | null = null;
  private imageGesture: ImageGesture | null = null;
  private baseRedrawQueued = false;

  // Shape tool
  private shapeDrag: ShapeDrag | null = null;

  // Ruler guide
  private ruler: RulerState | null = null;
  private rulerGesture: RulerGesture | null = null;
  /** Edge offset (±RULER_H/2 in ruler-local y) the active stroke snaps to. */
  private rulerSnapEdge: number | null = null;

  // Input stabilization (EMA smoothing of raw points)
  private stabAlpha = 1;
  private stabLast: StrokePoint | null = null;

  // Touch swipe navigation
  private swipe: SwipeTrack | null = null;

  // Undo / redo, tracked per page so switching pages never corrupts history.
  private history = new Map<string, PageHistory>();

  private boundHandlers: Array<[string, EventListener]> = [];

  constructor(host: EngineHost, doc: InkDocument) {
    this.host = host;
    this.doc = doc;
  }

  // --- lifecycle -----------------------------------------------------------

  mount(container: HTMLElement): void {
    this.wrapper = container.createDiv({ cls: "ink-canvas-wrapper" });
    this.base = this.wrapper.createEl("canvas", { cls: "ink-canvas ink-canvas-base" });
    this.live = this.wrapper.createEl("canvas", { cls: "ink-canvas ink-canvas-live" });
    this.baseCtx = this.base.getContext("2d")!;
    this.liveCtx = this.live.getContext("2d")!;

    const add = (t: string, fn: EventListener) => {
      this.live.addEventListener(t, fn, { passive: false });
      this.boundHandlers.push([t, fn]);
    };
    add("pointerdown", this.onPointerDown as EventListener);
    add("pointermove", this.onPointerMove as EventListener);
    add("pointerup", this.onPointerUp as EventListener);
    // pointercancel fires when the OS steals the pointer (e.g. a palm triggers
    // a gesture) — treat it as a normal end so the stroke is still committed.
    add("pointercancel", this.onPointerUp as EventListener);
    // NB: no pointerleave handler. We use setPointerCapture, so pointerup is
    // always delivered here even when the pen lifts past the page edge; a
    // pointerleave end-trigger would truncate strokes drawn to the margin.
    // Stop the browser hijacking pen/touch for scrolling or context menus.
    add("contextmenu", ((e: Event) => e.preventDefault()) as EventListener);

    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(container);
    this.layout();
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const [t, fn] of this.boundHandlers) this.live?.removeEventListener(t, fn);
    this.boundHandlers = [];
  }

  /** Replace the document (e.g. when the file is reloaded from disk). */
  setDocument(doc: InkDocument): void {
    this.doc = doc;
    this.pageIndex = Math.max(0, Math.min(this.pageIndex, doc.pages.length - 1));
    this.history.clear();
    this.selectedImageId = null;
    this.host.onHistoryChange();
    this.host.onSelectionChange(false);
    this.layout();
    this.host.onPageChanged(this.pageIndex, doc.pages.length);
  }

  get page(): InkPage {
    return this.doc.pages[this.pageIndex];
  }

  // --- page management -----------------------------------------------------

  getPageIndex(): number {
    return this.pageIndex;
  }

  getPageCount(): number {
    return this.doc.pages.length;
  }

  goToPage(index: number): void {
    const clamped = Math.max(0, Math.min(index, this.doc.pages.length - 1));
    if (clamped === this.pageIndex) return;
    this.cancelActiveGesture();
    this.pageIndex = clamped;
    this.setSelection(null);
    this.layout();
    this.host.onHistoryChange();
    this.host.onPageChanged(this.pageIndex, this.doc.pages.length);
  }

  /** Append a blank page after the given index (defaults to current). */
  addPage(afterIndex = this.pageIndex): void {
    const ref = this.doc.pages[afterIndex] ?? this.page;
    const pg = newPage(ref.width, ref.height);
    // New pages inherit the note's default paper template.
    if (this.doc.defaultTemplate && this.doc.defaultTemplate.kind !== "blank") {
      pg.template = { ...this.doc.defaultTemplate };
    }
    this.doc.pages.splice(afterIndex + 1, 0, pg);
    this.pageIndex = afterIndex + 1;
    this.setSelection(null);
    this.layout();
    this.host.onHistoryChange();
    this.host.onPageChanged(this.pageIndex, this.doc.pages.length);
    this.host.onChange();
  }

  /** Insert fully-formed pages (used by PDF import). */
  insertPages(pages: InkPage[], atIndex: number): void {
    this.doc.pages.splice(atIndex, 0, ...pages);
    this.pageIndex = atIndex;
    this.setSelection(null);
    this.layout();
    this.host.onHistoryChange();
    this.host.onPageChanged(this.pageIndex, this.doc.pages.length);
    this.host.onChange();
  }

  deletePage(index: number): void {
    if (index < 0 || index >= this.doc.pages.length) return;
    const removed = this.doc.pages.splice(index, 1)[0];
    if (removed) this.history.delete(removed.id);
    // A note always has at least one page.
    if (this.doc.pages.length === 0) this.doc.pages.push(newPage());
    this.pageIndex = Math.max(0, Math.min(this.pageIndex, this.doc.pages.length - 1));
    this.setSelection(null);
    this.layout();
    this.host.onHistoryChange();
    this.host.onPageChanged(this.pageIndex, this.doc.pages.length);
    this.host.onChange();
  }

  movePage(from: number, to: number): void {
    const n = this.doc.pages.length;
    if (from === to || from < 0 || from >= n || to < 0 || to >= n) return;
    const currentId = this.page.id;
    const [pg] = this.doc.pages.splice(from, 1);
    this.doc.pages.splice(to, 0, pg);
    // Keep following the page the user was looking at.
    this.pageIndex = this.doc.pages.findIndex((p) => p.id === currentId);
    this.layout();
    this.host.onPageChanged(this.pageIndex, this.doc.pages.length);
    this.host.onChange();
  }

  getPages(): InkPage[] {
    return this.doc.pages;
  }

  // --- layout & rendering --------------------------------------------------

  private layout(): void {
    if (!this.wrapper?.parentElement) return;
    const container = this.wrapper.parentElement;
    const availW = container.clientWidth;
    const availH = container.clientHeight;
    if (availW <= 0 || availH <= 0) return;

    const page = this.page;
    const margin = 8;
    // Contain the whole page in the viewport so it's fully visible/drawable.
    // (Zoom & pan for larger-than-viewport work arrives with gesture support.)
    this.scale = Math.min(
      (availW - margin * 2) / page.width,
      (availH - margin * 2) / page.height
    );
    if (!isFinite(this.scale) || this.scale <= 0) this.scale = 1;

    const cssW = page.width * this.scale;
    const cssH = page.height * this.scale;
    this.dpr = window.devicePixelRatio || 1;

    for (const c of [this.base, this.live]) {
      c.style.width = `${cssW}px`;
      c.style.height = `${cssH}px`;
      c.width = Math.round(cssW * this.dpr);
      c.height = Math.round(cssH * this.dpr);
    }
    const k = this.scale * this.dpr;
    this.baseCtx.setTransform(k, 0, 0, k, 0, 0);
    this.liveCtx.setTransform(k, 0, 0, k, 0, 0);

    this.redrawBase();
    this.drawLive();
  }

  private clearCanvas(ctx: CanvasRenderingContext2D, c: HTMLCanvasElement): void {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.restore();
  }

  private redrawBase(): void {
    const page = this.page;
    this.clearCanvas(this.baseCtx, this.base);

    // 1. Background: white paper, then paper template or PDF page render.
    this.baseCtx.save();
    this.baseCtx.fillStyle = "#ffffff";
    this.baseCtx.fillRect(0, 0, page.width, page.height);
    if (page.bg) {
      const bg = this.host.resolveBackground(page);
      if (bg) this.baseCtx.drawImage(bg, 0, 0, page.width, page.height);
    } else if (page.template) {
      drawTemplate(this.baseCtx, page.template, page.width, page.height);
    }
    this.baseCtx.restore();

    // 2. Images and stickers (under ink, so strokes annotate on top of them).
    for (const img of page.images) {
      if (img.emoji) {
        drawEmoji(this.baseCtx, img);
        continue;
      }
      const src = this.host.resolveImage(img.path);
      if (src) {
        this.baseCtx.drawImage(src, img.x, img.y, img.w, img.h);
      } else {
        // Placeholder while the asset loads.
        this.baseCtx.save();
        this.baseCtx.strokeStyle = "rgba(0,0,0,0.2)";
        this.baseCtx.setLineDash([6, 6]);
        this.baseCtx.strokeRect(img.x, img.y, img.w, img.h);
        this.baseCtx.restore();
      }
    }

    // 3. Ink.
    const rc = { pressureMode: this.host.getPressureMode() };
    for (const stroke of page.strokes) {
      drawStroke(this.baseCtx, stroke, rc, !!stroke.sim);
    }
  }

  /** rAF-throttled base redraw for continuous ops like image dragging. */
  private queueBaseRedraw(): void {
    if (this.baseRedrawQueued) return;
    this.baseRedrawQueued = true;
    requestAnimationFrame(() => {
      this.baseRedrawQueued = false;
      this.redrawBase();
    });
  }

  private drawLive(): void {
    this.clearCanvas(this.liveCtx, this.live);
    if (this.current) {
      drawStroke(
        this.liveCtx,
        this.current,
        { pressureMode: this.host.getPressureMode() },
        this.simulate
      );
    }
    if (this.shapeDrag) {
      for (const stroke of this.buildShapeStrokes(this.shapeDrag)) {
        drawStroke(this.liveCtx, stroke, { pressureMode: this.host.getPressureMode() }, false);
      }
    }
    this.drawRulerChrome();
    this.drawSelectionChrome();
  }

  /** Materialise the active shape drag into stroke objects. */
  private buildShapeStrokes(drag: ShapeDrag): Stroke[] {
    const spec = this.host.getActiveShape();
    if (!spec) return [];
    if (Math.abs(drag.x1 - drag.x0) < 4 && Math.abs(drag.y1 - drag.y0) < 4) return [];
    const pointSets = shapeStrokes(spec, drag.x0, drag.y0, drag.x1, drag.y1);
    const size = spec.kind === "table" ? 2.5 : this.host.getSize("pen");
    return pointSets.map((points) => ({
      id: makeId("st-"),
      tool: "pen" as ToolType,
      color: this.host.getColor(),
      size,
      opacity: 1,
      sim: false,
      thin: 0, // uniform width: shapes should look drafted, not hand-inked
      points,
    }));
  }

  /** Re-render after an external state change (settings, asset loaded, etc.). */
  refresh(): void {
    this.redrawBase();
    this.drawLive();
  }

  // --- selection chrome ----------------------------------------------------

  private get selectedImage(): InkImage | null {
    if (!this.selectedImageId) return null;
    return this.page.images.find((i) => i.id === this.selectedImageId) ?? null;
  }

  private setSelection(id: string | null): void {
    if (this.selectedImageId === id) return;
    this.selectedImageId = id;
    this.host.onSelectionChange(id !== null);
    this.drawLive();
  }

  hasSelection(): boolean {
    return this.selectedImageId !== null;
  }

  /** Corner handle positions for an image: NW, NE, SE, SW. */
  private handlePositions(img: InkImage): Array<[number, number]> {
    return [
      [img.x, img.y],
      [img.x + img.w, img.y],
      [img.x + img.w, img.y + img.h],
      [img.x, img.y + img.h],
    ];
  }

  private drawSelectionChrome(): void {
    const img = this.selectedImage;
    if (!img || this.host.getTool() !== "select") return;
    const c = this.liveCtx;
    const px = 1 / this.scale; // one CSS pixel in page units
    c.save();
    c.strokeStyle = "#3b82f6";
    c.lineWidth = 2 * px;
    c.setLineDash([8 * px, 5 * px]);
    c.strokeRect(img.x, img.y, img.w, img.h);
    c.setLineDash([]);
    const hs = 7 * px; // handle half-size
    c.fillStyle = "#ffffff";
    for (const [hx, hy] of this.handlePositions(img)) {
      c.beginPath();
      c.arc(hx, hy, hs, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }
    c.restore();
  }

  // --- ruler guide -----------------------------------------------------------

  hasRuler(): boolean {
    return this.ruler !== null;
  }

  toggleRuler(): void {
    if (this.ruler) {
      this.ruler = null;
      this.rulerSnapEdge = null;
    } else {
      const page = this.page;
      this.ruler = {
        cx: page.width / 2,
        cy: page.height / 2,
        angle: 0,
        len: page.width * 0.72,
      };
    }
    this.drawLive();
  }

  /** Page coords → ruler-local coords (x along the bar, y across it). */
  private toRulerLocal(x: number, y: number): { lx: number; ly: number } {
    const r = this.ruler!;
    const dx = x - r.cx;
    const dy = y - r.cy;
    const cos = Math.cos(-r.angle);
    const sin = Math.sin(-r.angle);
    return { lx: dx * cos - dy * sin, ly: dx * sin + dy * cos };
  }

  private rulerHit(x: number, y: number): "move" | "rotate" | null {
    if (!this.ruler) return null;
    const { lx, ly } = this.toRulerLocal(x, y);
    const r = this.ruler;
    if (Math.abs(ly) > RULER_H / 2 || Math.abs(lx) > r.len / 2) return null;
    // Grabbing the outer 18% of either end rotates; the middle moves.
    return Math.abs(lx) > r.len / 2 - r.len * 0.18 ? "rotate" : "move";
  }

  /**
   * If a stroke starts near a ruler edge, lock onto that edge; subsequent
   * points are projected onto it, producing a clean straight line that still
   * carries the pen's real pressure.
   */
  private rulerEdgeFor(x: number, y: number): number | null {
    if (!this.ruler) return null;
    const { lx, ly } = this.toRulerLocal(x, y);
    if (Math.abs(lx) > this.ruler.len / 2 + RULER_SNAP_DIST) return null;
    const edge = ly >= 0 ? RULER_H / 2 : -RULER_H / 2;
    return Math.abs(ly - edge) <= RULER_SNAP_DIST ? edge : null;
  }

  private projectToRulerEdge(x: number, y: number, edge: number): { x: number; y: number } {
    const r = this.ruler!;
    const { lx } = this.toRulerLocal(x, y);
    const cos = Math.cos(r.angle);
    const sin = Math.sin(r.angle);
    return {
      x: r.cx + lx * cos - edge * sin,
      y: r.cy + lx * sin + edge * cos,
    };
  }

  private drawRulerChrome(): void {
    const r = this.ruler;
    if (!r) return;
    const c = this.liveCtx;
    const px = 1 / this.scale;
    c.save();
    c.translate(r.cx, r.cy);
    c.rotate(r.angle);
    c.fillStyle = "rgba(196, 208, 226, 0.6)";
    c.strokeStyle = "rgba(90, 110, 140, 0.9)";
    c.lineWidth = 1.5 * px;
    c.beginPath();
    // roundRect may be missing in older WebViews; a plain rect is fine then.
    if (typeof c.roundRect === "function") {
      c.roundRect(-r.len / 2, -RULER_H / 2, r.len, RULER_H, 6);
    } else {
      c.rect(-r.len / 2, -RULER_H / 2, r.len, RULER_H);
    }
    c.fill();
    c.stroke();
    // Tick marks every 50 units, longer every 100.
    c.beginPath();
    c.lineWidth = 1 * px;
    for (let t = -Math.floor(r.len / 2 / 50) * 50; t <= r.len / 2; t += 50) {
      const tall = Math.round(Math.abs(t)) % 100 === 0;
      c.moveTo(t, -RULER_H / 2);
      c.lineTo(t, -RULER_H / 2 + (tall ? 18 : 10));
    }
    c.stroke();
    // Rotation grips at the ends.
    c.fillStyle = "rgba(90, 110, 140, 0.9)";
    for (const ex of [-r.len / 2 + 16, r.len / 2 - 16]) {
      c.beginPath();
      c.arc(ex, 0, 7, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  /** Remove the selected image (bound to a toolbar button / Delete key). */
  deleteSelectedImage(): void {
    const img = this.selectedImage;
    if (!img) return;
    this.pushHistory();
    this.page.images = this.page.images.filter((i) => i.id !== img.id);
    this.setSelection(null);
    this.redrawBase();
    this.host.onChange();
  }

  /** Apply a paper template to the current page (and optionally the note). */
  setPageTemplate(
    template: import("../types").PageTemplate,
    asNoteDefault: boolean
  ): void {
    this.page.template = template.kind === "blank" ? undefined : { ...template };
    if (asNoteDefault) {
      this.doc.defaultTemplate = template.kind === "blank" ? undefined : { ...template };
    }
    this.redrawBase();
    this.host.onChange();
  }

  getPageTemplate(): import("../types").PageTemplate | undefined {
    return this.page.template;
  }

  /** Drop an emoji sticker on the current page, centred, select-ready. */
  addSticker(emoji: string): void {
    const page = this.page;
    const size = Math.min(150, page.width * 0.15);
    const img: InkImage = {
      id: makeId("im-"),
      path: "",
      emoji,
      x: (page.width - size) / 2,
      y: (page.height - size) / 2,
      w: size,
      h: size,
    };
    this.pushHistory();
    page.images.push(img);
    this.selectedImageId = img.id;
    this.host.onSelectionChange(true);
    this.redrawBase();
    this.drawLive();
    this.host.onChange();
  }

  /** Insert an image on the current page, centred, scaled to fit. */
  addImage(path: string, naturalW: number, naturalH: number): void {
    const page = this.page;
    const maxW = page.width * 0.5;
    const maxH = page.height * 0.5;
    const s = Math.min(maxW / naturalW, maxH / naturalH, 1);
    const w = Math.max(24, naturalW * s);
    const h = Math.max(24, naturalH * s);
    const img: InkImage = {
      id: makeId("im-"),
      path,
      x: (page.width - w) / 2,
      y: (page.height - h) / 2,
      w,
      h,
    };
    this.pushHistory();
    page.images.push(img);
    this.selectedImageId = img.id;
    this.host.onSelectionChange(true);
    this.redrawBase();
    this.drawLive();
    this.host.onChange();
  }

  // --- coordinate mapping --------------------------------------------------

  private toPage(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.live.getBoundingClientRect();
    const sx = this.page.width / rect.width;
    const sy = this.page.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  private pressureOf(e: PointerEvent): number {
    if (e.pointerType === "pen" && e.pressure > 0) return e.pressure;
    return 0.5; // mouse/touch or a pen not reporting pressure
  }

  // --- input & palm rejection ---------------------------------------------

  private isDrawInput(e: PointerEvent): boolean {
    if (e.pointerType === "pen") return true;
    if (e.pointerType === "mouse") return e.button === 0 || e.buttons === 1;
    // touch: only when finger drawing is enabled AND no pen has ever been used
    // in this note. Once a stylus touches the screen we lock touch out, which
    // is what makes palm rejection reliable.
    if (e.pointerType === "touch") {
      return this.host.isFingerDrawing() && !this.penEverUsed;
    }
    return false;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === "pen") {
      this.penEverUsed = true;
      this.penLastSeen = Date.now();
    }

    // Palm rejection: while a gesture is active, ignore every other pointer.
    // A palm landing mid-stroke arrives as a separate 'touch' pointer and is
    // dropped here; the pen keeps drawing uninterrupted.
    if (this.activePointerId !== null) return;

    const tool = this.host.getTool();

    // The ruler bar catches any pointer that lands on it (like a physical
    // ruler lying on the page) — except for the select tool, which keeps
    // manipulating images.
    if (this.ruler && tool !== "select") {
      const pt = this.toPage(e);
      const hit = this.rulerHit(pt.x, pt.y);
      if (hit) {
        e.preventDefault();
        this.live.setPointerCapture(e.pointerId);
        this.activePointerId = e.pointerId;
        this.rulerGesture = { mode: hit, px: pt.x, py: pt.y, start: { ...this.ruler } };
        return;
      }
    }

    // Select tool: any single pointer (pen, mouse, finger) manipulates images.
    // Deliberate finger taps are fine here — you aren't resting a palm while
    // repositioning an image.
    if (tool === "select") {
      if (this.beginSelectGesture(e)) return;
      // Nothing hit: fall through so a touch can still swipe between pages.
    }

    if (tool === "shape" && this.isDrawInput(e)) {
      e.preventDefault();
      this.live.setPointerCapture(e.pointerId);
      this.activePointerId = e.pointerId;
      this.gestureChanged = false;
      this.snapshotBeforeGesture = this.clonePageSnapshot();
      const pt = this.toPage(e);
      this.shapeDrag = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
      return;
    }

    if (tool !== "select" && tool !== "shape" && this.isDrawInput(e)) {
      this.beginStroke(e, tool as ToolType);
      return;
    }

    // Unclaimed touch: candidate for a page-flip swipe.
    if (e.pointerType === "touch") {
      this.swipe = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now() };
    }
  };

  private beginSelectGesture(e: PointerEvent): boolean {
    const pt = this.toPage(e);
    const img = this.selectedImage;

    // 1. Corner handles of the current selection take priority.
    if (img) {
      const grabR = 18 / this.scale; // ~18 CSS px grab radius
      const handles = this.handlePositions(img);
      for (let c = 0; c < handles.length; c++) {
        if (Math.hypot(handles[c][0] - pt.x, handles[c][1] - pt.y) <= grabR) {
          this.startImageGesture(e, {
            kind: "resize",
            imageId: img.id,
            start: { x: img.x, y: img.y, w: img.w, h: img.h },
            px: pt.x,
            py: pt.y,
            corner: c,
          });
          return true;
        }
      }
    }

    // 2. Hit-test images topmost-first.
    for (let i = this.page.images.length - 1; i >= 0; i--) {
      const im = this.page.images[i];
      if (pt.x >= im.x && pt.x <= im.x + im.w && pt.y >= im.y && pt.y <= im.y + im.h) {
        this.setSelection(im.id);
        this.startImageGesture(e, {
          kind: "move",
          imageId: im.id,
          start: { x: im.x, y: im.y, w: im.w, h: im.h },
          px: pt.x,
          py: pt.y,
          corner: -1,
        });
        return true;
      }
    }

    // 3. Tap on empty space: deselect.
    this.setSelection(null);
    return false;
  }

  private startImageGesture(e: PointerEvent, gesture: ImageGesture): void {
    e.preventDefault();
    this.live.setPointerCapture(e.pointerId);
    this.activePointerId = e.pointerId;
    this.imageGesture = gesture;
    this.gestureChanged = false;
    this.snapshotBeforeGesture = this.clonePageSnapshot();
  }

  private beginStroke(e: PointerEvent, tool: ToolType): void {
    e.preventDefault();
    this.live.setPointerCapture(e.pointerId);
    this.activePointerId = e.pointerId;
    this.simulate = e.pointerType !== "pen";
    this.gestureChanged = false;
    this.snapshotBeforeGesture = this.clonePageSnapshot();

    let pt = this.toPage(e);

    if (tool === "eraser") {
      this.erasing = true;
      this.eraseAt(pt.x, pt.y);
      return;
    }

    // Pen-family config: nib + how pressure and stabilization apply.
    const isPenFamily = tool === "pen" || tool === "pencil";
    const config = isPenFamily ? this.host.getToolConfig(tool) : null;
    const thin = config ? pressurePctToThinning(config.pressurePct) : 0;
    const stabPct = config ? config.stabilizationPct : 0;
    // EMA smoothing: 0% → raw input, 100% → heavy averaging (smooth but laggy).
    this.stabAlpha = 1 - 0.9 * (Math.max(0, Math.min(100, stabPct)) / 100);
    this.stabLast = null;

    // Ruler: a stroke starting near an edge locks to it for its whole length.
    this.rulerSnapEdge = this.rulerEdgeFor(pt.x, pt.y);
    if (this.rulerSnapEdge !== null) {
      pt = this.projectToRulerEdge(pt.x, pt.y, this.rulerSnapEdge);
    }

    this.erasing = false;
    this.current = {
      id: makeId("st-"),
      tool,
      color: this.host.getColor(),
      size: this.host.getSize(tool),
      opacity: defaultOpacity(tool, config?.nib),
      sim: this.simulate,
      nib: config?.nib,
      thin,
      points: [{ x: pt.x, y: pt.y, p: this.pressureOf(e) }],
    };
    this.drawLive();
  }

  /** Apply stabilization + ruler snapping to one raw input point. */
  private processPoint(raw: StrokePoint): StrokePoint {
    let pt = raw;
    if (this.rulerSnapEdge !== null && this.ruler) {
      const proj = this.projectToRulerEdge(pt.x, pt.y, this.rulerSnapEdge);
      pt = { x: proj.x, y: proj.y, p: pt.p };
    }
    if (this.stabAlpha < 1) {
      if (!this.stabLast) {
        this.stabLast = pt;
      } else {
        const a = this.stabAlpha;
        this.stabLast = {
          x: this.stabLast.x + (pt.x - this.stabLast.x) * a,
          y: this.stabLast.y + (pt.y - this.stabLast.y) * a,
          p: this.stabLast.p + (pt.p - this.stabLast.p) * a,
        };
      }
      pt = { ...this.stabLast };
    }
    return pt;
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === "pen") this.penLastSeen = Date.now();
    if (e.pointerId !== this.activePointerId) return;
    e.preventDefault();

    if (this.imageGesture) {
      this.updateImageGesture(e);
      return;
    }

    if (this.rulerGesture) {
      this.updateRulerGesture(e);
      return;
    }

    if (this.shapeDrag) {
      const pt = this.toPage(e);
      this.shapeDrag.x1 = pt.x;
      this.shapeDrag.y1 = pt.y;
      this.drawLive();
      return;
    }

    // Use coalesced events so fast strokes keep every intermediate sample the
    // OS captured between animation frames — critical for smooth ink.
    const events =
      typeof e.getCoalescedEvents === "function" && e.getCoalescedEvents().length
        ? e.getCoalescedEvents()
        : [e];

    if (this.erasing) {
      for (const ev of events) {
        const pt = this.toPage(ev);
        this.eraseAt(pt.x, pt.y);
      }
      return;
    }

    if (!this.current) return;
    for (const ev of events) {
      const pt = this.toPage(ev);
      this.current.points.push(
        this.processPoint({ x: pt.x, y: pt.y, p: this.pressureOf(ev) })
      );
    }
    this.drawLive();
  };

  private updateRulerGesture(e: PointerEvent): void {
    const g = this.rulerGesture!;
    if (!this.ruler) return;
    const pt = this.toPage(e);
    if (g.mode === "move") {
      this.ruler.cx = g.start.cx + (pt.x - g.px);
      this.ruler.cy = g.start.cy + (pt.y - g.py);
    } else {
      const a0 = Math.atan2(g.py - g.start.cy, g.px - g.start.cx);
      const a1 = Math.atan2(pt.y - this.ruler.cy, pt.x - this.ruler.cx);
      this.ruler.angle = g.start.angle + (a1 - a0);
    }
    this.drawLive();
  }

  private updateImageGesture(e: PointerEvent): void {
    const g = this.imageGesture!;
    const img = this.page.images.find((i) => i.id === g.imageId);
    if (!img) return;
    const pt = this.toPage(e);
    const dx = pt.x - g.px;
    const dy = pt.y - g.py;

    if (g.kind === "move") {
      img.x = g.start.x + dx;
      img.y = g.start.y + dy;
    } else {
      // Corner resize, aspect ratio preserved, anchored at opposite corner.
      const aspect = g.start.w / g.start.h;
      const anchorX = g.corner === 0 || g.corner === 3 ? g.start.x + g.start.w : g.start.x;
      const anchorY = g.corner === 0 || g.corner === 1 ? g.start.y + g.start.h : g.start.y;
      let w = Math.abs(pt.x - anchorX);
      let h = w / aspect;
      if (Math.abs(pt.y - anchorY) > h) {
        h = Math.abs(pt.y - anchorY);
        w = h * aspect;
      }
      w = Math.max(24, w);
      h = Math.max(24 / aspect, w / aspect);
      img.w = w;
      img.h = h;
      img.x = pt.x < anchorX ? anchorX - w : anchorX;
      img.y = pt.y < anchorY ? anchorY - h : anchorY;
    }

    this.gestureChanged = true;
    this.queueBaseRedraw();
    this.drawLive();
  }

  private onPointerUp = (e: PointerEvent): void => {
    // Swipe-to-flip pages: a quick, mostly-horizontal single-finger flick.
    // Guarded against palms: never while inking, and not shortly after any
    // pen contact (a resting palm lingers; a deliberate flick is fast).
    if (this.swipe && e.pointerId === this.swipe.pointerId) {
      const dx = e.clientX - this.swipe.x;
      const dy = e.clientY - this.swipe.y;
      const dt = Date.now() - this.swipe.t;
      this.swipe = null;
      const penRecently = Date.now() - this.penLastSeen < 700;
      if (
        e.type === "pointerup" &&
        this.activePointerId === null &&
        !penRecently &&
        dt < 450 &&
        Math.abs(dx) > 90 &&
        Math.abs(dy) < 70
      ) {
        this.goToPage(this.pageIndex + (dx < 0 ? 1 : -1));
      }
      return;
    }

    if (e.pointerId !== this.activePointerId) return;
    try {
      this.live.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    this.activePointerId = null;

    if (this.imageGesture) {
      this.imageGesture = null;
      this.finishGesture();
      return;
    }

    if (this.rulerGesture) {
      // Ruler position is transient view state: no snapshot, no save.
      this.rulerGesture = null;
      this.snapshotBeforeGesture = null;
      return;
    }

    if (this.shapeDrag) {
      const committed = this.buildShapeStrokes(this.shapeDrag);
      this.shapeDrag = null;
      if (committed.length > 0) {
        this.page.strokes.push(...committed);
        this.gestureChanged = true;
        this.redrawBase();
      }
      this.drawLive();
      this.finishGesture();
      return;
    }

    if (this.erasing) {
      this.erasing = false;
      this.finishGesture();
      return;
    }

    if (this.current) {
      // Ignore a lone tap that produced no real stroke.
      if (this.current.points.length >= 1) {
        this.page.strokes.push(this.current);
        drawStroke(
          this.baseCtx,
          this.current,
          { pressureMode: this.host.getPressureMode() },
          this.simulate
        );
        this.gestureChanged = true;
      }
      this.current = null;
      this.rulerSnapEdge = null;
      this.stabLast = null;
      this.drawLive();
    }
    this.finishGesture();
  };

  private cancelActiveGesture(): void {
    this.activePointerId = null;
    this.current = null;
    this.erasing = false;
    this.imageGesture = null;
    this.shapeDrag = null;
    this.rulerGesture = null;
    this.rulerSnapEdge = null;
    this.stabLast = null;
    this.swipe = null;
    this.snapshotBeforeGesture = null;
    this.gestureChanged = false;
  }

  private finishGesture(): void {
    if (this.gestureChanged && this.snapshotBeforeGesture) {
      const h = this.pageHistory();
      h.undo.push(this.snapshotBeforeGesture);
      if (h.undo.length > HISTORY_LIMIT) h.undo.shift();
      h.redo = [];
      this.host.onHistoryChange();
      this.host.onChange();
    }
    this.snapshotBeforeGesture = null;
    this.gestureChanged = false;
  }

  private eraseAt(x: number, y: number): void {
    const radius = this.host.getSize("eraser") / 2;
    const strokes = this.page.strokes;
    let removed = false;
    for (let i = strokes.length - 1; i >= 0; i--) {
      if (this.strokeHit(strokes[i], x, y, radius)) {
        strokes.splice(i, 1);
        removed = true;
      }
    }
    if (removed) {
      this.gestureChanged = true;
      this.redrawBase();
    }
  }

  private strokeHit(stroke: Stroke, x: number, y: number, radius: number): boolean {
    const pad = radius + stroke.size / 2;
    const pts = stroke.points;
    if (pts.length === 1) {
      return Math.hypot(pts[0].x - x, pts[0].y - y) <= pad;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (distToSegment(x, y, a.x, a.y, b.x, b.y) <= pad) return true;
    }
    return false;
  }

  // --- history -------------------------------------------------------------

  private pageHistory(): PageHistory {
    let h = this.history.get(this.page.id);
    if (!h) {
      h = { undo: [], redo: [] };
      this.history.set(this.page.id, h);
    }
    return h;
  }

  private clonePageSnapshot(): PageSnapshot {
    return JSON.parse(
      JSON.stringify({ strokes: this.page.strokes, images: this.page.images })
    ) as PageSnapshot;
  }

  private restoreSnapshot(s: PageSnapshot): void {
    this.page.strokes = s.strokes;
    this.page.images = s.images;
    // Selection may point at an image that no longer exists.
    if (this.selectedImageId && !this.page.images.some((i) => i.id === this.selectedImageId)) {
      this.setSelection(null);
    }
    this.redrawBase();
    this.drawLive();
    this.host.onHistoryChange();
    this.host.onChange();
  }

  /** Push current page state onto undo (for one-shot ops like image insert). */
  private pushHistory(): void {
    const h = this.pageHistory();
    h.undo.push(this.clonePageSnapshot());
    if (h.undo.length > HISTORY_LIMIT) h.undo.shift();
    h.redo = [];
    this.host.onHistoryChange();
  }

  canUndo(): boolean {
    return (this.history.get(this.page.id)?.undo.length ?? 0) > 0;
  }
  canRedo(): boolean {
    return (this.history.get(this.page.id)?.redo.length ?? 0) > 0;
  }

  undo(): void {
    const h = this.pageHistory();
    if (h.undo.length === 0) return;
    h.redo.push(this.clonePageSnapshot());
    this.restoreSnapshot(h.undo.pop()!);
  }

  redo(): void {
    const h = this.pageHistory();
    if (h.redo.length === 0) return;
    h.undo.push(this.clonePageSnapshot());
    this.restoreSnapshot(h.redo.pop()!);
  }

  clearPage(): void {
    if (this.page.strokes.length === 0 && this.page.images.length === 0) return;
    this.pushHistory();
    this.page.strokes = [];
    this.page.images = [];
    this.setSelection(null);
    this.redrawBase();
    this.drawLive();
    this.host.onChange();
  }
}
