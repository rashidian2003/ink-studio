import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPressureCurve,
  combinePressureAndSpeed,
  constrainPressureRange,
  monotonicTimestamp,
  orderedUniqueSamples,
  pointVelocity,
  reduceStrokePoints,
  shouldRejectTouchContact,
  smoothPressure,
} from "../src/canvas/inkProcessing";

test("pressure curves provide soft, linear, hard and custom responses", () => {
  assert.ok(applyPressureCurve(0.25, "soft") > 0.25);
  assert.equal(applyPressureCurve(0.25, "linear"), 0.25);
  assert.ok(applyPressureCurve(0.25, "hard") < 0.25);
  assert.equal(
    applyPressureCurve(0.5, "custom", [
      { x: 0, y: 0 },
      { x: 1, y: 0.8 },
    ]),
    0.4
  );
});

test("pressure smoothing is independent and range limits remain valid", () => {
  assert.equal(smoothPressure(null, 0.2, 100), 0.2);
  const smoothed = smoothPressure(0.2, 1, 50);
  assert.ok(smoothed > 0.2 && smoothed < 1);
  assert.equal(constrainPressureRange(0, 20, 80), 0.2);
  assert.equal(constrainPressureRange(1, 20, 80), 0.8);
});

test("velocity uses distance and time rather than number of samples", () => {
  const direct = pointVelocity({ x: 0, y: 0, t: 0 }, { x: 120, y: 0, t: 120 });
  const sampled = pointVelocity({ x: 60, y: 0, t: 60 }, { x: 120, y: 0, t: 120 });
  assert.equal(direct, 1);
  assert.equal(sampled, 1);
  assert.equal(pointVelocity({ x: 0, y: 0, t: 5 }, { x: 10, y: 0, t: 5 }), 0);
});

test("speed influence is bounded and secondary to pressure", () => {
  const slow = combinePressureAndSpeed(0.6, 0, 100);
  const fast = combinePressureAndSpeed(0.6, 10, 100);
  assert.ok(slow > 0.6);
  assert.ok(fast < 0.6);
  assert.ok(fast > 0.4);
  assert.equal(combinePressureAndSpeed(0.6, 10, 0), 0.6);
});

test("timestamps become monotonic and coalesced duplicates are removed", () => {
  assert.equal(monotonicTimestamp(0, 10, 20), 20);
  assert.equal(monotonicTimestamp(8, 10, 20), 11);
  assert.equal(monotonicTimestamp(1000, 10, 20), 26.67);
  const a = { clientX: 1, clientY: 2, pressure: 0.3, timeStamp: 2 };
  const b = { clientX: 2, clientY: 3, pressure: 0.4, timeStamp: 3 };
  assert.deepEqual(orderedUniqueSamples([b, a, { ...a }]), [a, b]);
});

test("point reduction removes redundant samples but preserves corners", () => {
  const reduced = reduceStrokePoints(
    [
      { x: 0, y: 0, p: 0.5 },
      { x: 0.05, y: 0, p: 0.5 },
      { x: 1, y: 0, p: 0.5 },
      { x: 1, y: 1, p: 0.5 },
    ],
    0.2
  );
  assert.deepEqual(reduced, [
    { x: 0, y: 0, p: 0.5 },
    { x: 1, y: 0, p: 0.5 },
    { x: 1, y: 1, p: 0.5 },
  ]);
});

test("palm policy blocks large or guarded touch near pen activity", () => {
  assert.equal(
    shouldRejectTouchContact("pen-only", 50, 30, 1000, 1200, 34, 900),
    true
  );
  assert.equal(
    shouldRejectTouchContact("pen-only", 12, 12, 1000, 1200, 34, 900),
    false
  );
  assert.equal(
    shouldRejectTouchContact(
      "disable-touch-with-pen",
      12,
      12,
      1000,
      1200,
      34,
      900
    ),
    true
  );
  assert.equal(
    shouldRejectTouchContact("pen-only", 50, 50, 1000, 2200, 34, 900),
    false
  );
});
