import { getStroke } from "perfect-freehand";
import type { NibStyle, PressureMode, Stroke, ToolType } from "../types";
import { PRESSURE_THINNING } from "../settings";

// Rendering of vector strokes onto a 2D canvas context, using perfect-freehand
// to turn a list of (x, y, pressure) points into a smooth, variable-width
// outline. We render each stroke as a filled polygon rather than a stroked
// polyline so the width can vary continuously along the stroke.

export interface RenderContext {
  pressureMode: PressureMode;
}

/**
 * How each nib shapes its line. Beyond colour, nibs differ in width multiplier,
 * how much pressure thins the line, opacity, and how "raw" vs smoothed the
 * outline follows the hand.
 */
interface NibProfile {
  sizeMul: number;
  thinningMul: number;
  smoothing: number;
  streamline: number;
  opacity: number;
}

export const NIB_PROFILES: Record<NibStyle, NibProfile> = {
  fountain: { sizeMul: 1, thinningMul: 1, smoothing: 0.5, streamline: 0.5, opacity: 1 },
  fine: { sizeMul: 0.6, thinningMul: 0.8, smoothing: 0.55, streamline: 0.6, opacity: 1 },
  pencil: { sizeMul: 0.9, thinningMul: 0.7, smoothing: 0.4, streamline: 0.32, opacity: 0.85 },
  colored: { sizeMul: 1.2, thinningMul: 0.6, smoothing: 0.42, streamline: 0.35, opacity: 0.72 },
  charcoal: { sizeMul: 1.6, thinningMul: 0.45, smoothing: 0.3, streamline: 0.25, opacity: 0.55 },
};

export const NIB_LABELS: Record<NibStyle, string> = {
  fountain: "Fountain pen",
  fine: "Fine fountain",
  pencil: "Pencil",
  colored: "Colored pencil",
  charcoal: "Charcoal",
};

/** The nib older strokes (and non-pen tools) implicitly used. */
function nibFor(stroke: Stroke): NibProfile {
  if (stroke.nib) return NIB_PROFILES[stroke.nib];
  if (stroke.tool === "pencil") return NIB_PROFILES.pencil;
  return NIB_PROFILES.fountain;
}

/** perfect-freehand options resolved per stroke. */
function strokeOptions(stroke: Stroke, ctx: RenderContext, simulate: boolean) {
  const isHighlighter = stroke.tool === "highlighter";
  const nib = nibFor(stroke);
  // Highlighter keeps a flat, uniform nib (no pressure thinning, flat caps) so
  // it reads like a real marker for underlining. Pen family uses pressure:
  // per-stroke thinning when stored (v0.3+), legacy global mapping otherwise.
  const baseThinning = stroke.thin ?? PRESSURE_THINNING[ctx.pressureMode];
  const thinning = isHighlighter ? 0 : baseThinning * nib.thinningMul;
  return {
    size: stroke.size * (isHighlighter ? 1 : nib.sizeMul),
    thinning,
    smoothing: nib.smoothing,
    streamline: isHighlighter ? 0.5 : nib.streamline,
    simulatePressure: simulate,
    last: true,
    start: { cap: !isHighlighter },
    end: { cap: !isHighlighter },
  };
}

/** Turn perfect-freehand outline points into an SVG path string. */
function outlineToSvgPath(points: number[][]): string {
  if (points.length === 0) return "";
  const d = points.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ["M", ...points[0], "Q"] as (string | number)[]
  );
  d.push("Z");
  return d.join(" ");
}

/**
 * Build a Path2D for a stroke. `simulate` should be true for input without
 * real pressure (mouse, or touch) so perfect-freehand infers pressure from
 * velocity instead of drawing a flat line.
 */
export function strokePath(
  stroke: Stroke,
  ctx: RenderContext,
  simulate: boolean
): Path2D | null {
  const input = stroke.points.map((pt) => [pt.x, pt.y, pt.p] as number[]);
  const outline = getStroke(input, strokeOptions(stroke, ctx, simulate));
  if (outline.length === 0) return null;
  return new Path2D(outlineToSvgPath(outline));
}

// Committed strokes never mutate (undo/redo swaps in fresh clones), so their
// Path2D can be cached per stroke object. Paths live in page coordinates and
// scale through the canvas transform, so one cached path serves every zoom
// level, thumbnail and export — this is what keeps pinch-zoom redraws cheap.
const pathCache = new WeakMap<Stroke, { sig: string; path: Path2D | null }>();

/**
 * Draw a single stroke onto the given context. Pass `cache: true` for
 * committed strokes; leave it off for the live, still-growing stroke.
 */
export function drawStroke(
  c2d: CanvasRenderingContext2D,
  stroke: Stroke,
  ctx: RenderContext,
  simulate: boolean,
  cache = false
): void {
  let path: Path2D | null;
  if (cache) {
    // First-point coords in the signature invalidate the cache when a stroke
    // is translated in place (lasso move) without allocating new objects.
    const p0 = stroke.points[0];
    const sig = `${ctx.pressureMode}|${simulate ? 1 : 0}|${stroke.points.length}|${
      stroke.size
    }|${p0 ? `${p0.x.toFixed(1)},${p0.y.toFixed(1)}` : ""}`;
    const hit = pathCache.get(stroke);
    if (hit && hit.sig === sig) {
      path = hit.path;
    } else {
      path = strokePath(stroke, ctx, simulate);
      pathCache.set(stroke, { sig, path });
    }
  } else {
    path = strokePath(stroke, ctx, simulate);
  }
  if (!path) return;
  c2d.save();
  c2d.fillStyle = stroke.color;
  c2d.globalAlpha = stroke.opacity;
  // Highlighter should darken where it overlaps other ink but not build up on
  // itself; "multiply" gives a believable marker look on white pages.
  c2d.globalCompositeOperation =
    stroke.tool === "highlighter" ? "multiply" : "source-over";
  c2d.fill(path);
  c2d.restore();
}

/** Default opacity for a freshly created stroke of the given tool + nib. */
export function defaultOpacity(tool: ToolType, nib?: NibStyle): number {
  if (tool === "highlighter") return 0.4;
  if (nib) return NIB_PROFILES[nib].opacity;
  if (tool === "pencil") return 0.85;
  return 1;
}
