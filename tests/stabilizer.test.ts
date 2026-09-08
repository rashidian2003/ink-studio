import assert from "node:assert/strict";
import test from "node:test";
import { adaptiveAlpha, newStabilizerState, stabilizePoint } from "../src/canvas/stabilizer";

test("adaptive stabilization follows fast movement with less lag", () => {
  assert.ok(adaptiveAlpha(70, 1.5, 0) > adaptiveAlpha(70, 0.05, 0));
});

test("sharp direction changes temporarily reduce smoothing", () => {
  const state = newStabilizerState();
  stabilizePoint(state, { x: 0, y: 0, p: 0.5 }, 0.1, 70);
  stabilizePoint(state, { x: 10, y: 0, p: 0.5 }, 0.1, 70);
  const straight = stabilizePoint(state, { x: 20, y: 0, p: 0.5 }, 0.1, 70);
  const corner = stabilizePoint(state, { x: 20, y: 10, p: 0.5 }, 0.1, 70);
  assert.ok(corner.alpha > straight.alpha);
  assert.ok(corner.point.y > 8);
});
