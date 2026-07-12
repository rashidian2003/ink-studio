import type { PageTemplate, TemplateKind, TemplateSpacing } from "../types";

// Paper-pattern rendering (grid / lined / dotted). Drawn between the white
// paper fill and the ink, only on pages without a PDF background. Excluded
// from PDF export unless the user opts in.

const GRID_SPACING: Record<TemplateSpacing, number> = {
  small: 32,
  medium: 44,
  large: 60,
};

const LINE_SPACING: Record<TemplateSpacing, number> = {
  small: 48,
  medium: 66,
  large: 90,
};

const GRID_COLOR = "#c9d8ea";
const LINE_COLOR = "#b9cce4";
const DOT_COLOR = "#a9b8cc";

export const TEMPLATE_LABELS: Record<TemplateKind, string> = {
  blank: "Blank",
  grid: "Grid",
  lined: "Lined",
  dotted: "Dotted",
};

export const SPACING_LABELS: Record<TemplateSpacing, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

export function drawTemplate(
  ctx: CanvasRenderingContext2D,
  template: PageTemplate,
  width: number,
  height: number
): void {
  if (template.kind === "blank") return;
  ctx.save();

  if (template.kind === "grid") {
    const s = GRID_SPACING[template.spacing];
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let x = s; x < width; x += s) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = s; y < height; y += s) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  } else if (template.kind === "lined") {
    const s = LINE_SPACING[template.spacing];
    const topMargin = s * 1.5;
    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let y = topMargin; y < height - s * 0.4; y += s) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  } else if (template.kind === "dotted") {
    const s = GRID_SPACING[template.spacing];
    ctx.fillStyle = DOT_COLOR;
    for (let x = s; x < width; x += s) {
      for (let y = s; y < height; y += s) {
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.restore();
}
