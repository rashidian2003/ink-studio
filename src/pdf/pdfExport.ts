import { App, TFile } from "obsidian";
import { PDFDocument } from "pdf-lib";
import type { InkDocument, PressureMode } from "../types";
import { renderPageToCanvas } from "../canvas/pageRender";
import type { AssetCache } from "../assets";
import { uniqueVaultPath } from "../importers";

// Export the whole note as a new, flattened PDF. PDF-backed pages are copied
// from their source file with pdf-lib (vector quality preserved) and the ink +
// image layer is stamped on top as a transparent PNG. The source PDFs and the
// .ink note are never modified — this always writes a brand-new file.

/** Width of the rasterised ink overlay per page, px. */
const OVERLAY_WIDTH = 1800;
/** Blank pages export at A4 width in PDF points. */
const A4_POINTS_WIDTH = 595.28;

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png")
  );
  if (!blob) throw new Error("Could not encode overlay PNG");
  return new Uint8Array(await blob.arrayBuffer());
}

export interface ExportOptions {
  /** Include the paper template (grid/lined/dotted) on blank pages. */
  includeTemplates: boolean;
}

/**
 * Flatten `doc` into a new PDF next to the note. Returns the created path.
 */
export async function exportAnnotatedPdf(
  app: App,
  doc: InkDocument,
  notePath: string,
  assets: AssetCache,
  pressureMode: PressureMode,
  options: ExportOptions = { includeTemplates: true },
  onProgress?: (done: number, total: number) => void
): Promise<string> {
  const out = await PDFDocument.create();
  const sources = new Map<string, PDFDocument>();

  const loadSource = async (path: string): Promise<PDFDocument> => {
    let src = sources.get(path);
    if (!src) {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        throw new Error(`Source PDF missing from vault: ${path}`);
      }
      const bytes = await app.vault.readBinary(file);
      src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      sources.set(path, src);
    }
    return src;
  };

  const total = doc.pages.length;
  for (let i = 0; i < total; i++) {
    const page = doc.pages[i];

    let pdfPage;
    if (page.bg) {
      const src = await loadSource(page.bg.path);
      const [copied] = await out.copyPages(src, [page.bg.page - 1]);
      pdfPage = out.addPage(copied);
    } else {
      const w = A4_POINTS_WIDTH;
      const h = (w * page.height) / page.width;
      pdfPage = out.addPage([w, h]);
    }

    const wantsTemplate =
      options.includeTemplates && !page.bg && page.template?.kind !== undefined;
    if (
      page.strokes.length > 0 ||
      page.images.length > 0 ||
      (page.texts?.length ?? 0) > 0 ||
      wantsTemplate
    ) {
      await assets.ensureImagesLoaded(page);
      const overlay = renderPageToCanvas(page, {
        width: Math.min(OVERLAY_WIDTH, page.width * 2),
        pressureMode,
        includeBackground: false, // transparent: the PDF page shows through
        includeTemplate: options.includeTemplates,
        resolveBackground: () => null,
        resolveImage: (p) => assets.resolveImage(p),
      });
      const png = await out.embedPng(await canvasToPngBytes(overlay));
      const size = pdfPage.getSize();
      // NB: assumes the copied page's aspect matches the ink page's (true for
      // pages we imported ourselves, since their size came from the same
      // viewport). Rotated exotic PDFs may need per-page transforms later.
      pdfPage.drawImage(png, { x: 0, y: 0, width: size.width, height: size.height });
    }

    onProgress?.(i + 1, total);
  }

  const bytes = await out.save();
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;

  const dot = notePath.lastIndexOf(".");
  const base = dot > 0 ? notePath.slice(0, dot) : notePath;
  const outPath = uniqueVaultPath(app, `${base} (annotated)`, ".pdf");
  await app.vault.createBinary(outPath, buffer);
  return outPath;
}
