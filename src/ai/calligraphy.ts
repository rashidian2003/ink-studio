import type { Stroke, StrokePoint } from "../types";
import { makeId } from "../types";
import { SCRIPT_FACE, SCRIPT_GLYPHS } from "./scriptFont";

// Renders text as genuine ink strokes in a single-stroke cursive font — the
// "rewrite my handwriting as calligraphy, but keep it handwriting" feature.
// The output is ordinary Stroke data: erasable, undoable, exported like ink.

export interface CalligraphyOptions {
  /** Top-left of the text block, page units. */
  x: number;
  y: number;
  /** Cap height of the rendered writing, page units. */
  size: number;
  color: string;
  /** Base stroke width, page units. */
  strokeSize: number;
  /** Wrap lines to this width (page units). */
  maxWidth: number;
}

/** Substitutions for characters the plotter font lacks. */
const FALLBACK: Record<string, string> = {
  "„": '"',
  "‚": "'",
  "’": "'",
  "‘": "'",
  "…": "...",
  "\t": "  ",
};

const LINE_GAP = 1.75; // multiples of cap height, roomy like real handwriting

function lookupChar(ch: string) {
  if (SCRIPT_GLYPHS[ch]) return SCRIPT_GLYPHS[ch];
  // Strip diacritics the font doesn't cover (é → e), then give up.
  const stripped = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return SCRIPT_GLYPHS[stripped] ?? null;
}

/**
 * Calligraphic pressure: downstrokes (pen moving down the page) press hard,
 * upstrokes stay light — the classic split-nib look, rendered through the
 * existing pressure-sensitive stroke renderer.
 */
function calligraphicPressure(points: StrokePoint[]): void {
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const down = Math.max(0, dy / len); // y grows downwards
    points[i].p = 0.38 + 0.5 * down;
  }
}

/** Resample a polyline to roughly even spacing so strokes render smoothly. */
function resample(points: StrokePoint[], step: number): StrokePoint[] {
  if (points.length < 2) return points;
  const out: StrokePoint[] = [points[0]];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const seg = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    let d = step - acc;
    while (d < seg) {
      const t = d / seg;
      out.push({ x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t, p: 0.5 });
      d += step;
    }
    acc = (acc + seg) % step;
  }
  out.push(points[points.length - 1]);
  return out;
}

export class UnsupportedScriptError extends Error {}

/**
 * Lay text out as cursive ink strokes. Throws UnsupportedScriptError when the
 * text is mostly outside the font's Latin coverage (e.g. Persian) — the
 * offline "Tidy up" path is the right tool there.
 */
export function textToCalligraphyStrokes(
  text: string,
  opts: CalligraphyOptions
): Stroke[] {
  const scale = opts.size / SCRIPT_FACE.capHeight;
  const lineAdvance = opts.size * LINE_GAP;
  const spaceAdv = (SCRIPT_GLYPHS[" "]?.adv ?? SCRIPT_FACE.defaultAdv) * scale;

  let known = 0;
  let unknown = 0;
  const strokes: Stroke[] = [];
  // First baseline sits one cap height below the block's top.
  let baseline = opts.y + opts.size;

  const flushGlyph = (glyph: { lines: number[][] }, cursorX: number) => {
    for (const line of glyph.lines) {
      const pts: StrokePoint[] = [];
      for (let i = 0; i < line.length; i += 2) {
        pts.push({
          x: cursorX + line[i] * scale,
          // Font coordinates are y-up around the baseline; the page is y-down.
          y: baseline - line[i + 1] * scale,
          p: 0.5,
        });
      }
      const sampled = resample(pts, Math.max(3, opts.size / 9));
      calligraphicPressure(sampled);
      strokes.push({
        id: makeId("st-"),
        tool: "pen",
        color: opts.color,
        size: opts.strokeSize,
        opacity: 1,
        sim: false,
        nib: "fountain",
        thin: 0.72, // strong pressure→width mapping sells the nib look
        points: sampled,
      });
    }
  };

  for (const rawLine of text.split("\n")) {
    let cursorX = opts.x;
    const words = rawLine.split(" ");
    words.forEach((word, wi) => {
      // Measure the word for wrapping.
      let wordAdv = 0;
      for (const ch of word) {
        const mapped = FALLBACK[ch] ?? ch;
        for (const c of mapped) {
          wordAdv += (lookupChar(c)?.adv ?? SCRIPT_FACE.defaultAdv) * scale;
        }
      }
      if (wi > 0) cursorX += spaceAdv;
      if (cursorX + wordAdv > opts.x + opts.maxWidth && cursorX > opts.x) {
        cursorX = opts.x;
        baseline += lineAdvance;
      }
      for (const ch of word) {
        const mapped = FALLBACK[ch] ?? ch;
        for (const c of mapped) {
          const glyph = lookupChar(c);
          if (!glyph) {
            unknown++;
            cursorX += SCRIPT_FACE.defaultAdv * scale;
            continue;
          }
          known++;
          flushGlyph(glyph, cursorX);
          cursorX += glyph.adv * scale;
        }
      }
    });
    baseline += lineAdvance;
  }

  if (known === 0 || unknown > known) {
    throw new UnsupportedScriptError(
      "This text is outside the calligraphy font's Latin coverage."
    );
  }
  return strokes;
}
