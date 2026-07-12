import type { InkImage, InkPage, InkText, PressureMode } from "../types";
import { drawStroke } from "./strokeRender";
import { drawTemplate } from "./templates";

/** Font stack used for typed text boxes (canvas needs concrete families). */
export function textFont(size: number): string {
  return `400 ${size}px -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Vazirmatn", sans-serif`;
}

const LINE_HEIGHT = 1.32;

/** Draw a text box (multi-line via \n), anchored at its top-left. */
export function drawTextBox(ctx: CanvasRenderingContext2D, t: InkText): void {
  ctx.save();
  ctx.font = textFont(t.size);
  ctx.fillStyle = t.color;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const lines = t.text.split("\n");
  lines.forEach((line, i) => {
    ctx.fillText(line, t.x, t.y + i * t.size * LINE_HEIGHT);
  });
  ctx.restore();
}

/** Measure a text box's bounding box (page units). */
export function measureTextBox(
  ctx: CanvasRenderingContext2D,
  t: InkText
): { x: number; y: number; w: number; h: number } {
  ctx.save();
  ctx.font = textFont(t.size);
  const lines = t.text.split("\n");
  let w = 0;
  for (const line of lines) {
    w = Math.max(w, ctx.measureText(line).width);
  }
  ctx.restore();
  return { x: t.x, y: t.y, w: Math.max(w, t.size), h: lines.length * t.size * LINE_HEIGHT };
}

// Offline rendering of a full page to a standalone canvas. Shared by the
// thumbnail strip (small, with background) and the annotated-PDF exporter
// (large, transparent overlay of just images + ink).

/** Draw an emoji sticker as text — crisp at any size, no asset file needed. */
export function drawEmoji(ctx: CanvasRenderingContext2D, img: InkImage): void {
  if (!img.emoji) return;
  ctx.save();
  ctx.font = `${Math.round(img.h * 0.9)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(img.emoji, img.x + img.w / 2, img.y + img.h / 2 + img.h * 0.05);
  ctx.restore();
}

export interface PageRenderOptions {
  /** Output canvas width in pixels; height follows the page aspect ratio. */
  width: number;
  pressureMode: PressureMode;
  /** Paint white paper + PDF background. Off for transparent export overlays. */
  includeBackground: boolean;
  /** Draw the paper template (grid/lined/dotted). Export can exclude it. */
  includeTemplate: boolean;
  resolveBackground: (page: InkPage) => CanvasImageSource | null;
  resolveImage: (path: string) => CanvasImageSource | null;
}

export function renderPageToCanvas(
  page: InkPage,
  opts: PageRenderOptions
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const scale = opts.width / page.width;
  canvas.width = Math.max(1, Math.round(page.width * scale));
  canvas.height = Math.max(1, Math.round(page.height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  if (opts.includeBackground) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, page.width, page.height);
    if (page.bg) {
      const bg = opts.resolveBackground(page);
      if (bg) ctx.drawImage(bg, 0, 0, page.width, page.height);
    }
  }
  if (opts.includeTemplate && !page.bg && page.template) {
    drawTemplate(ctx, page.template, page.width, page.height);
  }

  for (const img of page.images) {
    if (img.emoji) {
      drawEmoji(ctx, img);
      continue;
    }
    const src = opts.resolveImage(img.path);
    if (src) ctx.drawImage(src, img.x, img.y, img.w, img.h);
  }

  for (const t of page.texts ?? []) {
    drawTextBox(ctx, t);
  }

  const rc = { pressureMode: opts.pressureMode };
  for (const stroke of page.strokes) {
    drawStroke(ctx, stroke, rc, !!stroke.sim, true);
  }

  return canvas;
}
