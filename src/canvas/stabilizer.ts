import type { StrokePoint } from "../types";

export interface StabilizerState {
  output: StrokePoint | null;
  rawPrevious: StrokePoint | null;
  directionX: number;
  directionY: number;
}

export function newStabilizerState(): StabilizerState {
  return { output: null, rawPrevious: null, directionX: 0, directionY: 0 };
}

export function adaptiveAlpha(
  stabilizationPct: number,
  velocity: number,
  turnRadians: number
): number {
  const amount = Math.max(0, Math.min(1, stabilizationPct / 100));
  if (amount === 0) return 1;
  const slowAlpha = 1 - amount * 0.72;
  const speedFollow = Math.max(0, Math.min(1, velocity / 0.9));
  const turnFollow = Math.max(0, Math.min(1, turnRadians / (Math.PI / 3)));
  return Math.max(0.12, Math.min(1, slowAlpha + (1 - slowAlpha) * Math.max(speedFollow, turnFollow)));
}

export function stabilizePoint(
  state: StabilizerState,
  raw: StrokePoint,
  velocity: number,
  stabilizationPct: number
): { point: StrokePoint; alpha: number; turnRadians: number } {
  let turnRadians = 0;
  if (state.rawPrevious) {
    const dx = raw.x - state.rawPrevious.x;
    const dy = raw.y - state.rawPrevious.y;
    const len = Math.hypot(dx, dy);
    if (len > 0.0001 && Math.hypot(state.directionX, state.directionY) > 0.0001) {
      const dot = (dx * state.directionX + dy * state.directionY) /
        (len * Math.hypot(state.directionX, state.directionY));
      turnRadians = Math.acos(Math.max(-1, Math.min(1, dot)));
    }
    if (len > 0.0001) {
      state.directionX = dx;
      state.directionY = dy;
    }
  }
  const alpha = adaptiveAlpha(stabilizationPct, velocity, turnRadians);
  const point = !state.output || alpha >= 0.999
    ? raw
    : {
        x: state.output.x + (raw.x - state.output.x) * alpha,
        y: state.output.y + (raw.y - state.output.y) * alpha,
        p: raw.p,
      };
  state.rawPrevious = raw;
  state.output = point;
  return { point, alpha, turnRadians };
}
