// Core data model for Ink Studio documents.
//
// Everything is stored as vector data (arrays of points) rather than a raster
// bitmap, so strokes stay crisp at any zoom and remain individually editable,
// erasable and undoable. A document is serialised to JSON and saved as the
// contents of an `.ink` file in the vault (see InkView / main.ts).

export type ToolType = "pen" | "pencil" | "highlighter" | "eraser";

/**
 * Everything selectable in the toolbar. "select" manipulates images/stickers,
 * "shape" drag-draws geometric shapes (committed as ink strokes) — neither is
 * a stroke ToolType.
 */
export type CanvasTool = ToolType | "select" | "shape";

/** Nib styles for the pen family. Each renders with distinct line quality. */
export type NibStyle = "fountain" | "fine" | "pencil" | "colored" | "charcoal";

/** Geometric shapes the shape tool can drag-draw. "table" carries rows/cols. */
export type ShapeKind = "rect" | "ellipse" | "triangle" | "line" | "arrow" | "table";

export interface ShapeSpec {
  kind: ShapeKind;
  rows?: number;
  cols?: number;
}

/** Paper background pattern for a page (not exported unless requested). */
export type TemplateKind = "blank" | "grid" | "lined" | "dotted";
export type TemplateSpacing = "small" | "medium" | "large";

export interface PageTemplate {
  kind: TemplateKind;
  spacing: TemplateSpacing;
}

/** How strongly pen pressure affects stroke width. */
export type PressureMode = "off" | "subtle" | "natural" | "dramatic";

/** A single sampled point along a stroke, in page coordinates. */
export interface StrokePoint {
  x: number;
  y: number;
  /** Normalised pen pressure, 0..1. 0.5 is used when the device can't report it. */
  p: number;
}

/** One continuous mark made between a pointerdown and pointerup. */
export interface Stroke {
  /** Unique id, used for selection / erase / undo bookkeeping. */
  id: string;
  tool: ToolType;
  /** CSS colour string, e.g. "#1a1a1a". */
  color: string;
  /** Base stroke width in page units (before pressure thinning). */
  size: number;
  /** 0..1. Highlighter is semi-transparent; pen/pencil are usually opaque. */
  opacity: number;
  /**
   * True when this stroke's pressure was simulated from velocity (mouse/touch
   * input) rather than reported by a pen. Stored so redraws look identical to
   * the live stroke.
   */
  sim?: boolean;
  /** Nib style used (pen family). Absent on pre-v0.3 strokes → tool default. */
  nib?: NibStyle;
  /**
   * Pressure→width thinning (0..0.85) captured at draw time from the pen's
   * settings. Absent on pre-v0.3 strokes → falls back to the global setting.
   * 0 renders a uniform-width line (used by shapes/tables).
   */
  thin?: number;
  points: StrokePoint[];
}

/**
 * A page background rendered beneath images and ink. For PDF pages the source
 * file stays untouched in the vault; we only reference it and render it at
 * view time, so annotations are always a separate, non-destructive layer.
 */
export interface PdfBackground {
  type: "pdf";
  /** Vault path of the source PDF. */
  path: string;
  /** 1-based page number within the source PDF. */
  page: number;
}

export type PageBackground = PdfBackground;

/**
 * An image or sticker placed on a page, freely positionable/resizable. Ink
 * draws on top. Stickers are stored as an emoji character (no vault file) and
 * rendered as text — crisp at any zoom; `path` is empty for them.
 */
export interface InkImage {
  id: string;
  /** Vault path of the image file. Empty when `emoji` is set. */
  path: string;
  /** When set, this element is an emoji sticker rendered as text. */
  emoji?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One page of a note. Page coordinates run 0..width / 0..height. */
export interface InkPage {
  id: string;
  width: number;
  height: number;
  bg?: PageBackground;
  /** Paper pattern; only drawn when the page has no PDF background. */
  template?: PageTemplate;
  images: InkImage[];
  strokes: Stroke[];
}

export type CanvasMode = "page" | "infinite";

/** The full serialisable document. */
export interface InkDocument {
  version: number;
  app: "ink-studio";
  mode: CanvasMode;
  /** Named page size preset used when adding new pages, e.g. "a4". */
  pageSize: string;
  /** Template applied to newly added pages of this note. */
  defaultTemplate?: PageTemplate;
  pages: InkPage[];
}

/** Current version of the on-disk format. */
export const INK_DOC_VERSION = 1;

// A4 at ~150 DPI, portrait. Logical page units; the canvas scales these to fit
// the viewport, so the number just sets the internal resolution / aspect ratio.
export const A4_WIDTH = 1240;
export const A4_HEIGHT = 1754;

let idCounter = 0;
/** Short, collision-resistant id for pages and strokes. */
export function makeId(prefix = ""): string {
  idCounter = (idCounter + 1) % 1e6;
  return (
    prefix +
    Date.now().toString(36) +
    "-" +
    Math.floor(Math.random() * 1e6).toString(36) +
    "-" +
    idCounter.toString(36)
  );
}

export function newPage(width = A4_WIDTH, height = A4_HEIGHT): InkPage {
  return { id: makeId("pg-"), width, height, images: [], strokes: [] };
}

/** True when a page has no user content (safe to silently replace/delete). */
export function pageIsEmpty(page: InkPage): boolean {
  return page.strokes.length === 0 && page.images.length === 0 && !page.bg;
}

export function emptyDocument(): InkDocument {
  return {
    version: INK_DOC_VERSION,
    app: "ink-studio",
    mode: "page",
    pageSize: "a4",
    pages: [newPage()],
  };
}

/**
 * Parse a raw file body into an InkDocument, tolerating empty / malformed
 * files by falling back to a fresh document. Never throws — losing handwritten
 * content to a parse error would be unacceptable.
 */
export function parseDocument(raw: string): InkDocument {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return emptyDocument();
  try {
    const parsed = JSON.parse(trimmed) as Partial<InkDocument>;
    if (!parsed || parsed.app !== "ink-studio" || !Array.isArray(parsed.pages)) {
      return emptyDocument();
    }
    // Ensure at least one page and fill in any missing fields defensively.
    const pages: InkPage[] =
      parsed.pages.length > 0
        ? parsed.pages.map((pg) => ({
            id: pg.id ?? makeId("pg-"),
            width: pg.width ?? A4_WIDTH,
            height: pg.height ?? A4_HEIGHT,
            bg: pg.bg,
            template: pg.template,
            images: Array.isArray(pg.images) ? pg.images : [],
            strokes: Array.isArray(pg.strokes) ? pg.strokes : [],
          }))
        : [newPage()];
    return {
      version: parsed.version ?? INK_DOC_VERSION,
      app: "ink-studio",
      mode: parsed.mode === "infinite" ? "infinite" : "page",
      pageSize: parsed.pageSize ?? "a4",
      defaultTemplate: parsed.defaultTemplate,
      pages,
    };
  } catch {
    return emptyDocument();
  }
}

export function serializeDocument(doc: InkDocument): string {
  return JSON.stringify(doc);
}
