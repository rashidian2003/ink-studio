import { App, TFile, loadPdfJs } from "obsidian";

// PDF page rendering via Obsidian's own bundled pdf.js (loadPdfJs). Obsidian
// ships pdf.js for its native PDF viewer on both desktop and mobile, so this
// works inside the Capacitor WebView with zero bundling/worker setup — far
// more robust than shipping our own copy.

let pdfjsPromise: Promise<any> | null = null;

function getPdfJs(): Promise<any> {
  if (!pdfjsPromise) pdfjsPromise = loadPdfJs();
  return pdfjsPromise;
}

// One parsed PDFDocumentProxy per source path, shared by every page render.
const docCache = new Map<string, Promise<any>>();

export function getPdfDocument(app: App, path: string): Promise<any> {
  let cached = docCache.get(path);
  if (!cached) {
    cached = (async () => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        throw new Error(`Ink Studio: PDF not found in vault: ${path}`);
      }
      const buf = await app.vault.readBinary(file);
      const pdfjs = await getPdfJs();
      // Copy the buffer: pdf.js transfers (detaches) the one it's given.
      return await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    })();
    // Drop failed loads from the cache so a fixed file can be retried.
    cached.catch(() => docCache.delete(path));
    docCache.set(path, cached);
  }
  return cached;
}

/** Page sizes (pdf.js viewport units at scale 1, rotation applied). */
export async function getPdfPageSizes(
  app: App,
  path: string
): Promise<Array<{ width: number; height: number }>> {
  const doc = await getPdfDocument(app, path);
  const sizes: Array<{ width: number; height: number }> = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    sizes.push({ width: vp.width, height: vp.height });
  }
  return sizes;
}

/** Render one PDF page (1-based) to a canvas of roughly targetWidth pixels. */
export async function renderPdfPageToCanvas(
  app: App,
  path: string,
  pageNum: number,
  targetWidth: number
): Promise<HTMLCanvasElement> {
  const doc = await getPdfDocument(app, path);
  const page = await doc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: targetWidth / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d")!;
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

/** Free all parsed PDFs (called on plugin unload). */
export function clearPdfCache(): void {
  for (const p of docCache.values()) {
    p.then((d) => d?.destroy?.()).catch(() => {});
  }
  docCache.clear();
  pdfjsPromise = null;
}
