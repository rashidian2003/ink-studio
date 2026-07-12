import { App, FuzzySuggestModal, TFile, normalizePath } from "obsidian";
import { A4_WIDTH, InkPage, makeId } from "./types";
import { getPdfPageSizes } from "./pdf/pdfRenderer";

// File pickers (vault + device) and the PDF → pages import logic.

/** Fuzzy-pick a vault file by extension. Resolves null when dismissed. */
export function pickVaultFile(
  app: App,
  extensions: string[],
  placeholder: string
): Promise<TFile | null> {
  return new Promise((resolve) => {
    const files = app.vault
      .getFiles()
      .filter((f) => extensions.includes(f.extension.toLowerCase()));

    class Picker extends FuzzySuggestModal<TFile> {
      private done = false;
      getItems(): TFile[] {
        return files;
      }
      getItemText(item: TFile): string {
        return item.path;
      }
      onChooseItem(item: TFile): void {
        this.done = true;
        resolve(item);
      }
      onClose(): void {
        super.onClose();
        // Give onChooseItem a chance to run first.
        window.setTimeout(() => {
          if (!this.done) resolve(null);
          this.done = true;
        }, 50);
      }
    }

    const picker = new Picker(app);
    picker.setPlaceholder(placeholder);
    picker.open();
  });
}

/**
 * Open the platform's native file dialog (Android's document/gallery picker,
 * or the camera when `capture` is set). Resolves null on cancel.
 */
export function pickDeviceFile(
  accept: string,
  capture?: string
): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    if (capture) input.setAttribute("capture", capture);
    input.style.display = "none";
    document.body.appendChild(input);

    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };

    input.addEventListener("change", () => finish(input.files?.[0] ?? null));
    // Modern WebViews fire "cancel" on dismissed pickers; also fall back to a
    // focus check so we never leave the promise dangling forever.
    input.addEventListener("cancel", () => finish(null));
    window.addEventListener(
      "focus",
      () => window.setTimeout(() => finish(input.files?.[0] ?? null), 800),
      { once: true }
    );

    input.click();
  });
}

/** Save binary data into the vault as an attachment of `sourcePath`. */
export async function saveBinaryToVault(
  app: App,
  data: ArrayBuffer,
  suggestedName: string,
  sourcePath: string
): Promise<TFile> {
  // Sanitise: vault paths reject a handful of characters.
  const cleaned = suggestedName.replace(/[\\/:*?"<>|#^[\]]/g, "-") || "file";
  let path: string;
  try {
    path = await app.fileManager.getAvailablePathForAttachment(cleaned, sourcePath);
  } catch {
    // Fallback: alongside the note.
    const dot = cleaned.lastIndexOf(".");
    const base = dot > 0 ? cleaned.slice(0, dot) : cleaned;
    const ext = dot > 0 ? cleaned.slice(dot) : "";
    const dir = sourcePath.contains("/")
      ? sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1)
      : "";
    path = uniqueVaultPath(app, `${dir}${base}`, ext);
  }
  return await app.vault.createBinary(normalizePath(path), data);
}

/** First free path of the form `<base><n><ext>`. */
export function uniqueVaultPath(app: App, base: string, ext: string): string {
  for (let i = 0; i < 1000; i++) {
    const candidate = normalizePath(i === 0 ? `${base}${ext}` : `${base} ${i}${ext}`);
    if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
  }
  return normalizePath(`${base}-${Date.now()}${ext}`);
}

/**
 * Build one InkPage per page of a vault PDF, each referencing (never touching)
 * the source file. Page height follows each PDF page's own aspect ratio.
 */
export async function buildPdfPages(app: App, pdfPath: string): Promise<InkPage[]> {
  const sizes = await getPdfPageSizes(app, pdfPath);
  return sizes.map((s, i) => ({
    id: makeId("pg-"),
    width: A4_WIDTH,
    height: Math.max(100, Math.round((A4_WIDTH * s.height) / s.width)),
    bg: { type: "pdf" as const, path: pdfPath, page: i + 1 },
    images: [],
    texts: [],
    strokes: [],
  }));
}
