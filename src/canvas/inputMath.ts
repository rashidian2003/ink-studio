import type { StrokePoint } from "../types";

export interface ViewTransform {
  rectLeft: number;
  rectTop: number;
  offsetX: number;
  offsetY: number;
  scale: number;
}

export function screenToPage(
  clientX: number,
  clientY: number,
  transform: ViewTransform
): { x: number; y: number } {
  const scale = Math.max(transform.scale, 0.0001);
  return {
    x: (clientX - transform.rectLeft - transform.offsetX) / scale,
    y: (clientY - transform.rectTop - transform.offsetY) / scale,
  };
}

export function pageToScreen(
  pageX: number,
  pageY: number,
  transform: ViewTransform
): { x: number; y: number } {
  return {
    x: transform.rectLeft + transform.offsetX + pageX * transform.scale,
    y: transform.rectTop + transform.offsetY + pageY * transform.scale,
  };
}

/** Clamp broken device values while preserving genuinely light pressure. */
export function normalizedPressure(pointerType: string, pressure: number): number {
  if (pointerType !== "pen") return 0.5;
  if (!Number.isFinite(pressure)) return 0.5;
  return Math.max(0.03, Math.min(1, pressure));
}

export function smoothPoint(
  previous: StrokePoint | null,
  raw: StrokePoint,
  alpha: number
): StrokePoint {
  if (!previous || alpha >= 1) return raw;
  const a = Math.max(0.01, Math.min(1, alpha));
  return {
    x: previous.x + (raw.x - previous.x) * a,
    y: previous.y + (raw.y - previous.y) * a,
    p: previous.p + (raw.p - previous.p) * a,
  };
}

export function shouldKeepSample(
  previous: StrokePoint | undefined,
  next: StrokePoint,
  minDistance: number,
  minPressureDelta = 0.015
): boolean {
  if (!previous) return true;
  return (
    Math.hypot(next.x - previous.x, next.y - previous.y) >= minDistance ||
    Math.abs(next.p - previous.p) >= minPressureDelta
  );
}
