import type { Stroke, StrokePoint } from "../types";

// "Tidy up handwriting": pure-geometry regularization of stroke groups.
// No AI, fully offline. Pipeline per the spec: (1) baseline detection &
// alignment, (2) height normalization, (3) horizontal spacing normalization,
// (4) corner-preserving spline smoothing. Each step is individually
// toggleable; the caller applies the result as ONE undoable operation.

export interface TidyOptions {
  alignBaseline: boolean;
  normalizeHeight: boolean;
  fixSpacing: boolean;
  smooth: boolean;
}

export const DEFAULT_TIDY: TidyOptions = {
  alignBaseline: true,
  normalizeHeight: true,
  fixSpacing: true,
  smooth: true,
};

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function strokeBBox(s: Stroke): BBox {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of s.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * q));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function median(values: number[]): number {
  return quantile(
    [...values].sort((a, b) => a - b),
    0.5
  );
}

/** Robust "bottom" of a stroke: 90th-percentile y, so descenders don't skew. */
function strokeBottom(s: Stroke): number {
  const ys = s.points.map((p) => p.y).sort((a, b) => a - b);
  return quantile(ys, 0.9);
}

function translateStroke(s: Stroke, dx: number, dy: number): void {
  for (const p of s.points) {
    p.x += dx;
    p.y += dy;
  }
}

/**
 * Cluster strokes into rough lines of writing by vertical overlap. Returns
 * lines top-to-bottom, each line's strokes left-to-right.
 */
export function clusterLines(strokes: Stroke[]): Stroke[][] {
  const entries = strokes
    .map((s) => ({ s, box: strokeBBox(s) }))
    .sort((a, b) => (a.box.minY + a.box.maxY) / 2 - (b.box.minY + b.box.maxY) / 2);

  const lines: Array<{ minY: number; maxY: number; items: typeof entries }> = [];
  for (const e of entries) {
    const h = Math.max(1, e.box.maxY - e.box.minY);
    let joined = false;
    for (const line of lines) {
      const overlap = Math.min(line.maxY, e.box.maxY) - Math.max(line.minY, e.box.minY);
      const smaller = Math.min(h, Math.max(1, line.maxY - line.minY));
      if (overlap > 0.35 * smaller) {
        line.items.push(e);
        line.minY = Math.min(line.minY, e.box.minY);
        line.maxY = Math.max(line.maxY, e.box.maxY);
        joined = true;
        break;
      }
    }
    if (!joined) lines.push({ minY: e.box.minY, maxY: e.box.maxY, items: [e] });
  }

  return lines.map((line) =>
    line.items.sort((a, b) => a.box.minX - b.box.minX).map((e) => e.s)
  );
}

/** Step 1: shift each stroke so its bottom sits on the line's fitted baseline. */
function alignBaseline(line: Stroke[]): void {
  if (line.length < 2) return;
  const pts = line.map((s) => {
    const box = strokeBBox(s);
    return { x: (box.minX + box.maxX) / 2, y: strokeBottom(s), h: box.maxY - box.minY };
  });
  // Least-squares fit y = a + b*x through the per-stroke baseline points.
  const n = pts.length;
  const sumX = pts.reduce((t, p) => t + p.x, 0);
  const sumY = pts.reduce((t, p) => t + p.y, 0);
  const sumXX = pts.reduce((t, p) => t + p.x * p.x, 0);
  const sumXY = pts.reduce((t, p) => t + p.x * p.y, 0);
  const denom = n * sumXX - sumX * sumX;
  const b = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const a = (sumY - b * sumX) / n;

  const heights = pts.map((p) => p.h).filter((h) => h > 4);
  const maxShift = Math.max(6, median(heights.length ? heights : [20]) * 0.5);

  line.forEach((s, i) => {
    const target = a + b * pts[i].x;
    let dy = target - pts[i].y;
    // Clamp: tiny marks (i-dots, commas) shouldn't be yanked to the baseline.
    dy = Math.max(-maxShift, Math.min(maxShift, dy));
    translateStroke(s, 0, dy);
  });
}

/** Step 2: scale stroke heights 60% toward the line median, baseline-anchored. */
function normalizeHeight(line: Stroke[]): void {
  const boxes = line.map(strokeBBox);
  const heights = boxes.map((b) => b.maxY - b.minY).filter((h) => h > 8);
  if (heights.length < 2) return;
  const med = median(heights);

  line.forEach((s, i) => {
    const h = boxes[i].maxY - boxes[i].minY;
    if (h <= 8) return; // dots & punctuation stay as they are
    let factor = 1 + 0.6 * (med / h - 1);
    factor = Math.max(0.6, Math.min(1.6, factor));
    if (Math.abs(factor - 1) < 0.02) return;
    const anchor = strokeBottom(s);
    for (const p of s.points) {
      p.y = anchor + (p.y - anchor) * factor;
    }
  });
}

/** Step 3: pull outlier gaps between strokes toward the line's median gap. */
function fixSpacing(line: Stroke[]): void {
  if (line.length < 3) return;
  const boxes = line.map(strokeBBox);
  const gaps: number[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    gaps.push(boxes[i + 1].minX - boxes[i].maxX);
  }
  const positive = gaps.filter((g) => g > 0);
  if (positive.length < 2) return;
  const med = median(positive);

  let shift = 0;
  for (let i = 1; i < line.length; i++) {
    const gap = gaps[i - 1];
    if (gap > 0) {
      // Move toward the median, but never change a gap by more than 40%.
      const correction = Math.max(-0.4 * gap, Math.min(0.4 * gap, med - gap));
      shift += correction;
    }
    if (shift !== 0) translateStroke(line[i], shift, 0);
  }
}

// --- Step 4: corner-preserving smoothing ------------------------------------

/** Ramer-Douglas-Peucker simplification; keeps high-curvature points. */
function rdp(points: StrokePoint[], epsilon: number): StrokePoint[] {
  if (points.length < 3) return points.slice();
  const first = points[0];
  const last = points[points.length - 1];
  let maxDist = -1;
  let index = -1;
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const dist = Math.abs(dy * p.x - dx * p.y + last.x * first.y - last.y * first.x) / len;
    if (dist > maxDist) {
      maxDist = dist;
      index = i;
    }
  }
  if (maxDist > epsilon) {
    const left = rdp(points.slice(0, index + 1), epsilon);
    const right = rdp(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

/** Centripetal-ish Catmull-Rom through the keypoints, pressure interpolated. */
function catmullRom(keys: StrokePoint[], step: number): StrokePoint[] {
  if (keys.length < 3) return keys.slice();
  const out: StrokePoint[] = [keys[0]];
  for (let i = 0; i < keys.length - 1; i++) {
    const p0 = keys[Math.max(0, i - 1)];
    const p1 = keys[i];
    const p2 = keys[i + 1];
    const p3 = keys[Math.min(keys.length - 1, i + 2)];
    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const n = Math.max(1, Math.round(segLen / step));
    for (let j = 1; j <= n; j++) {
      const t = j / n;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        p: p1.p + (p2.p - p1.p) * t,
      });
    }
  }
  return out;
}

/** Smooth one stroke: RDP keeps letter corners, Catmull-Rom removes wobble. */
function smoothStroke(s: Stroke): void {
  if (s.points.length < 5) return;
  const epsilon = Math.max(0.9, s.size * 0.22);
  const keys = rdp(s.points, epsilon);
  if (keys.length < 3) return;
  s.points = catmullRom(keys, 5);
}

/**
 * Run the tidy pipeline over a deep copy of the given strokes. The input is
 * never mutated — callers preview the result, then swap it in as one undo step.
 */
export function tidyStrokes(strokes: Stroke[], opts: TidyOptions): Stroke[] {
  const copy = JSON.parse(JSON.stringify(strokes)) as Stroke[];
  const lines = clusterLines(copy);

  for (const line of lines) {
    if (opts.alignBaseline) alignBaseline(line);
    if (opts.normalizeHeight) normalizeHeight(line);
    if (opts.fixSpacing) fixSpacing(line);
  }
  if (opts.smooth) {
    for (const s of copy) smoothStroke(s);
  }
  return copy;
}
