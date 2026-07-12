import { App, Modal, Setting } from "obsidian";
import type { Stroke } from "../types";
import { DEFAULT_TIDY, TidyOptions, tidyStrokes, strokeBBox } from "../canvas/tidy";
import { drawStroke } from "../canvas/strokeRender";

// Dialogs for the two AI-handwriting actions. Both preview before applying:
// OCR shows the recognized (editable) text; Tidy shows before/after renders.

/** Editable preview of a Gemini transcription, with explicit apply choices. */
export class OcrResultModal extends Modal {
  private text: string;
  private onApply: (text: string, removeStrokes: boolean) => void;

  constructor(app: App, text: string, onApply: (text: string, removeStrokes: boolean) => void) {
    super(app);
    this.text = text;
    this.onApply = onApply;
  }

  onOpen(): void {
    this.titleEl.setText("Convert handwriting to text");
    const { contentEl } = this;

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Check the transcription below (OCR can misread words) and edit it if needed. Undo restores the handwriting at any time.",
    });

    const area = contentEl.createEl("textarea", {
      cls: "ink-text-modal-area",
      attr: { rows: "8" },
    }) as HTMLTextAreaElement;
    area.value = this.text;
    area.oninput = () => (this.text = area.value);

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Insert, keep handwriting").onClick(() => {
          if (this.text.trim()) this.onApply(this.text.trim(), false);
          this.close();
        })
      )
      .addButton((b) =>
        b
          .setButtonText("Insert & remove handwriting")
          .setCta()
          .onClick(() => {
            if (this.text.trim()) this.onApply(this.text.trim(), true);
            this.close();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Render a stroke group into a preview canvas, cropped to its bounding box. */
function renderStrokesPreview(
  canvas: HTMLCanvasElement,
  strokes: Stroke[],
  cssWidth: number
): void {
  if (strokes.length === 0) return;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const s of strokes) {
    const b = strokeBBox(s);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  const pad = 14;
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  const scale = cssWidth / w;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(h * scale * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${h * scale}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, (pad - minX) * scale * dpr, (pad - minY) * scale * dpr);
  for (const s of strokes) {
    drawStroke(ctx, s, { pressureMode: "natural" }, !!s.sim);
  }
}

/**
 * "Tidy up handwriting": step toggles + live before/after preview. Nothing is
 * changed until Apply; the caller swaps strokes in as one undo step.
 */
export class TidyModal extends Modal {
  private opts: TidyOptions = { ...DEFAULT_TIDY };
  private strokes: Stroke[];
  private preview: Stroke[];
  private afterCanvas!: HTMLCanvasElement;
  private onApply: (tidied: Stroke[]) => void;

  constructor(app: App, strokes: Stroke[], onApply: (tidied: Stroke[]) => void) {
    super(app);
    this.strokes = strokes;
    this.preview = tidyStrokes(strokes, this.opts);
    this.onApply = onApply;
  }

  onOpen(): void {
    this.titleEl.setText("Tidy up handwriting");
    const { contentEl } = this;

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Straightens the writing line, evens out letter size and spacing, and smooths jitter — your handwriting style stays yours. One undo restores the original.",
    });

    const previews = contentEl.createDiv({ cls: "ink-tidy-previews" });
    const beforeWrap = previews.createDiv({ cls: "ink-tidy-preview" });
    beforeWrap.createDiv({ cls: "ink-tidy-label", text: "Before" });
    const beforeCanvas = beforeWrap.createEl("canvas");
    const afterWrap = previews.createDiv({ cls: "ink-tidy-preview" });
    afterWrap.createDiv({ cls: "ink-tidy-label", text: "After" });
    this.afterCanvas = afterWrap.createEl("canvas");

    renderStrokesPreview(beforeCanvas, this.strokes, 250);
    this.repaint();

    const toggles: Array<[keyof TidyOptions, string]> = [
      ["alignBaseline", "Align baseline"],
      ["normalizeHeight", "Normalize size"],
      ["fixSpacing", "Fix spacing"],
      ["smooth", "Smooth strokes"],
    ];
    for (const [key, label] of toggles) {
      new Setting(contentEl).setName(label).addToggle((t) =>
        t.setValue(this.opts[key]).onChange((v) => {
          this.opts[key] = v;
          this.preview = tidyStrokes(this.strokes, this.opts);
          this.repaint();
        })
      );
    }

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Apply")
        .setCta()
        .onClick(() => {
          this.onApply(this.preview);
          this.close();
        })
    );
  }

  private repaint(): void {
    renderStrokesPreview(this.afterCanvas, this.preview, 250);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
