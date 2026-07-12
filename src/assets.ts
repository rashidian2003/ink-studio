import { App, TFile } from "obsidian";
import type { InkPage } from "./types";
import { renderPdfPageToCanvas } from "./pdf/pdfRenderer";

// Per-view cache that turns async assets (PDF page renders, vault images) into
// the synchronous lookups the render loop needs. A miss kicks off an async
// load and returns null; when the load completes, `onReady` re-renders the
// canvas so the page fills in.

/** Cap on cached PDF page renders (each ~8–14 MB RGBA on tablet). */
const BG_CACHE_LIMIT = 6;

export class AssetCache {
  private app: App;
  private onReady: () => void;

  /** key `${path}#${page}` → canvas, or null while loading / after failure. */
  private bg = new Map<string, HTMLCanvasElement | null>();
  private bgLru: string[] = [];
  /** vault path → element, or null while loading / after failure. */
  private img = new Map<string, HTMLImageElement | null>();
  private blobUrls: string[] = [];

  constructor(app: App, onReady: () => void) {
    this.app = app;
    this.onReady = onReady;
  }

  // --- page backgrounds (PDF) ---------------------------------------------

  resolveBackground(page: InkPage): CanvasImageSource | null {
    if (!page.bg) return null;
    const key = `${page.bg.path}#${page.bg.page}`;
    if (this.bg.has(key)) {
      const hit = this.bg.get(key) ?? null;
      if (hit) this.touchLru(key);
      return hit;
    }
    this.bg.set(key, null); // mark in-flight so we only load once
    const targetWidth = Math.min(Math.round(page.width * 1.25), 1600);
    renderPdfPageToCanvas(this.app, page.bg.path, page.bg.page, targetWidth)
      .then((canvas) => {
        this.bg.set(key, canvas);
        this.touchLru(key);
        this.evictBg();
        this.onReady();
      })
      .catch((err) => {
        // Leave the null entry: renders as blank paper instead of retry-looping.
        console.error("Ink Studio: failed to render PDF page", key, err);
      });
    return null;
  }

  private touchLru(key: string): void {
    const i = this.bgLru.indexOf(key);
    if (i >= 0) this.bgLru.splice(i, 1);
    this.bgLru.push(key);
  }

  private evictBg(): void {
    while (this.bgLru.length > BG_CACHE_LIMIT) {
      const evict = this.bgLru.shift()!;
      this.bg.delete(evict);
    }
  }

  // --- images ----------------------------------------------------------------

  resolveImage(path: string): CanvasImageSource | null {
    if (this.img.has(path)) return this.img.get(path) ?? null;
    this.img.set(path, null);
    this.loadImageElement(path)
      .then((el) => {
        this.img.set(path, el);
        this.onReady();
      })
      .catch((err) => {
        console.error("Ink Studio: failed to load image", path, err);
      });
    return null;
  }

  /** Load a vault image into an HTMLImageElement (also used at insert time). */
  async loadImageElement(path: string): Promise<HTMLImageElement> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new Error(`Image not found in vault: ${path}`);
    }
    const buf = await this.app.vault.readBinary(file);
    const url = URL.createObjectURL(new Blob([buf]));
    this.blobUrls.push(url);
    const el = new Image();
    await new Promise<void>((resolve, reject) => {
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`Could not decode image: ${path}`));
      el.src = url;
    });
    // Cache it for synchronous resolution too.
    this.img.set(path, el);
    return el;
  }

  /** Ensure every image on a page is loaded (used before PDF export). */
  async ensureImagesLoaded(page: InkPage): Promise<void> {
    await Promise.all(
      page.images.map(async (im) => {
        if (this.img.get(im.path)) return;
        try {
          await this.loadImageElement(im.path);
        } catch (e) {
          console.error("Ink Studio: image missing for export", im.path, e);
        }
      })
    );
  }

  destroy(): void {
    for (const url of this.blobUrls) URL.revokeObjectURL(url);
    this.blobUrls = [];
    this.bg.clear();
    this.img.clear();
    this.bgLru = [];
  }
}
