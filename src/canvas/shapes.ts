import type { ShapeSpec, StrokePoint } from "../types";

// Point-series generators for the shape tool. Shapes are committed as regular
// ink strokes (uniform width, thin=0), so they are erasable, undoable,
// exportable and lasso-able exactly like handwriting — no separate shape
// object type to maintain.

const STEP = 7; // sampling distance along edges, page units

function seg(
  out: StrokePoint[],
  x0: number,
  y0: number,
  x1: number,
  y1: number
): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.round(len / STEP));
  for (let i = 0; i <= n; i++) {
    out.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n, p: 0.5 });
  }
}

function polyline(pts: Array<[number, number]>): StrokePoint[] {
  const out: StrokePoint[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    seg(out, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
  }
  return out;
}

/**
 * Build the point series for a shape dragged from (x0,y0) to (x1,y1).
 * Returns one array per stroke — most shapes are one stroke, arrows are two
 * (shaft + head), tables are one per grid line.
 */
export function shapeStrokes(
  spec: ShapeSpec,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): StrokePoint[][] {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);

  switch (spec.kind) {
    case "rect":
      return [
        polyline([
          [left, top],
          [left + w, top],
          [left + w, top + h],
          [left, top + h],
          [left, top],
        ]),
      ];

    case "ellipse": {
      const cx = left + w / 2;
      const cy = top + h / 2;
      const out: StrokePoint[] = [];
      const n = 72;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        out.push({ x: cx + (w / 2) * Math.cos(a), y: cy + (h / 2) * Math.sin(a), p: 0.5 });
      }
      return [out];
    }

    case "triangle":
      return [
        polyline([
          [left + w / 2, top],
          [left + w, top + h],
          [left, top + h],
          [left + w / 2, top],
        ]),
      ];

    case "line":
      return [polyline([[x0, y0], [x1, y1]])];

    case "arrow": {
      const angle = Math.atan2(y1 - y0, x1 - x0);
      const len = Math.hypot(x1 - x0, y1 - y0);
      const headLen = Math.min(48, Math.max(18, len * 0.22));
      const spread = Math.PI / 7;
      const wing = (da: number): [number, number] => [
        x1 - headLen * Math.cos(angle + da),
        y1 - headLen * Math.sin(angle + da),
      ];
      // Shaft, then the head as a single left-wing → tip → right-wing polyline.
      return [
        polyline([[x0, y0], [x1, y1]]),
        polyline([wing(spread), [x1, y1], wing(-spread)]),
      ];
    }

    case "table": {
      const rows = Math.max(1, spec.rows ?? 3);
      const cols = Math.max(1, spec.cols ?? 3);
      const out: StrokePoint[][] = [];
      for (let r = 0; r <= rows; r++) {
        const y = top + (h * r) / rows;
        const line: StrokePoint[] = [];
        seg(line, left, y, left + w, y);
        out.push(line);
      }
      for (let c = 0; c <= cols; c++) {
        const x = left + (w * c) / cols;
        const line: StrokePoint[] = [];
        seg(line, x, top, x, top + h);
        out.push(line);
      }
      return out;
    }
  }
}
