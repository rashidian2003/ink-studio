import type {
  PressureCurveMode,
  PressureCurvePoint,
  StrokePoint,
} from "../types";
import type { InputMode } from "../settings";

export interface TimedPoint {
  x: number;
  y: number;
  t: number;
}

export interface PointerSampleLike {
  clientX: number;
  clientY: number;
  pressure: number;
  timeStamp: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** Map hardware pressure through a predictable preset or a future-editable
 * piecewise custom curve. */
export function applyPressureCurve(
  pressure: number,
  mode: PressureCurveMode,
  custom: PressureCurvePoint[] = []
): number {
  const p = clamp01(Number.isFinite(pressure) ? pressure : 0.5);
  if (mode === "soft") return Math.sqrt(p);
  if (mode === "hard") return Math.pow(p, 1.8);
  if (mode !== "custom" || custom.length < 2) return p;

  const points = custom
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: clamp01(point.x), y: clamp01(point.y) }))
    .sort((a, b) => a.x - b.x);
  if (points.length < 2) return p;
  if (p <= points[0].x) return points[0].y;
  for (let index = 1; index < points.length; index++) {
    const left = points[index - 1];
    const right = points[index];
    if (p > right.x) continue;
    const span = Math.max(0.0001, right.x - left.x);
    const amount = (p - left.x) / span;
    return clamp01(left.y + (right.y - left.y) * amount);
  }
  return points[points.length - 1].y;
}

/** Independent low-latency pressure EMA. Position is deliberately untouched. */
export function smoothPressure(
  previous: number | null,
  pressure: number,
  smoothingPct: number
): number {
  const current = clamp01(pressure);
  if (previous === null) return current;
  const amount = clamp01(smoothingPct / 100);
  const alpha = 1 - amount * 0.88;
  return clamp01(previous + (current - previous) * alpha);
}

/** Real distance / real elapsed time, independent of event/sample rate. */
export function pointVelocity(previous: TimedPoint | null, current: TimedPoint): number {
  if (!previous) return 0;
  const dt = current.t - previous.t;
  if (!Number.isFinite(dt) || dt <= 0 || dt > 250) return 0;
  return Math.hypot(current.x - previous.x, current.y - previous.y) / dt;
}

/** Pressure remains primary. Speed only adds a bounded secondary modulation:
 * slow movement gets at most 8% thicker, fast movement at most 28% thinner. */
export function combinePressureAndSpeed(
  pressure: number,
  velocity: number,
  speedEffectPct: number
): number {
  const effect = clamp01(speedEffectPct / 100);
  if (effect === 0 || !Number.isFinite(velocity) || velocity < 0) return clamp01(pressure);
  const speed = velocity / (velocity + 0.85);
  const factor = 1 + effect * (0.08 * (1 - speed) - 0.28 * speed);
  return Math.max(0.03, Math.min(1, pressure * factor));
}

export function constrainPressureRange(
  pressure: number,
  minWidthPct: number,
  maxWidthPct: number
): number {
  const min = clamp01(minWidthPct / 100);
  const max = Math.max(min, clamp01(maxWidthPct / 100));
  return min + (max - min) * clamp01(pressure);
}

/** Produce monotonic sample time while neutralising broken zero/backward jumps
 * and long pauses that would otherwise distort velocity. */
export function monotonicTimestamp(
  timestamp: number,
  previous: number | null,
  fallbackNow: number
): number {
  let next = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallbackNow;
  if (previous === null) return Number.isFinite(next) ? next : 0;
  if (!Number.isFinite(next) || next <= previous) return previous + 1;
  if (next - previous > 250) return previous + 16.67;
  return next;
}

export function isPenRecent(lastPenTime: number, now: number, guardMs: number): boolean {
  return lastPenTime > 0 && now - lastPenTime < Math.max(0, guardMs);
}

export function shouldRejectTouchContact(
  mode: InputMode,
  width: number,
  height: number,
  lastPenTime: number,
  now: number,
  contactThreshold: number,
  guardMs: number
): boolean {
  const recent = isPenRecent(lastPenTime, now, guardMs);
  if (mode === "disable-touch-with-pen" && recent) return true;
  const contactSize = Math.max(
    Number.isFinite(width) ? width : 0,
    Number.isFinite(height) ? height : 0
  );
  return recent && contactSize >= Math.max(18, contactThreshold);
}

/** Coalesced batches occasionally repeat the parent event. Sort by hardware
 * time and remove only exact-equivalent samples; geometric reduction happens
 * later with page/zoom-aware thresholds. */
export function orderedUniqueSamples<T extends PointerSampleLike>(samples: T[]): T[] {
  const ordered = samples
    .map((sample, index) => ({ sample, index }))
    .sort((a, b) => {
      const at = Number.isFinite(a.sample.timeStamp) ? a.sample.timeStamp : Infinity;
      const bt = Number.isFinite(b.sample.timeStamp) ? b.sample.timeStamp : Infinity;
      return at === bt ? a.index - b.index : at - bt;
    })
    .map(({ sample }) => sample);
  return ordered.filter((sample, index) => {
    if (index === 0) return true;
    const previous = ordered[index - 1];
    return !(
      sample.timeStamp === previous.timeStamp &&
      Math.abs(sample.clientX - previous.clientX) < 0.001 &&
      Math.abs(sample.clientY - previous.clientY) < 0.001 &&
      Math.abs(sample.pressure - previous.pressure) < 0.001
    );
  });
}

/** Conservative, corner-aware point reduction for committed strokes. */
export function reduceStrokePoints(
  points: StrokePoint[],
  minDistance: number,
  cornerDegrees = 22
): StrokePoint[] {
  if (points.length <= 2) return points.slice();
  const kept: StrokePoint[] = [points[0]];
  const cornerCos = Math.cos((cornerDegrees * Math.PI) / 180);
  for (let index = 1; index < points.length - 1; index++) {
    const previous = kept[kept.length - 1];
    const current = points[index];
    const next = points[index + 1];
    const d = Math.hypot(current.x - previous.x, current.y - previous.y);
    const ax = current.x - previous.x;
    const ay = current.y - previous.y;
    const bx = next.x - current.x;
    const by = next.y - current.y;
    const lengths = Math.hypot(ax, ay) * Math.hypot(bx, by);
    const cosine = lengths > 0 ? (ax * bx + ay * by) / lengths : 1;
    const pressureChanged = Math.abs(current.p - previous.p) >= 0.02;
    if (d >= minDistance || cosine < cornerCos || pressureChanged) kept.push(current);
  }
  kept.push(points[points.length - 1]);
  return kept;
}
