import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizedPressure,
  pageToScreen,
  screenToPage,
  shouldKeepSample,
  smoothPoint,
} from "../src/canvas/inputMath";

const transform = {
  rectLeft: 20,
  rectTop: 30,
  offsetX: 40,
  offsetY: 50,
  scale: 2,
};

test("screen/page coordinate conversion is reversible", () => {
  const page = screenToPage(260, 480, transform);
  assert.deepEqual(page, { x: 100, y: 200 });
  assert.deepEqual(pageToScreen(page.x, page.y, transform), { x: 260, y: 480 });
});

test("coordinates remain under the pointer across zoom and pan", () => {
  for (const scale of [1, 2, 4]) {
    const transform = { rectLeft: 7, rectTop: 13, offsetX: -80, offsetY: 45, scale };
    const screen = pageToScreen(321, 654, transform);
    const page = screenToPage(screen.x, screen.y, transform);
    assert.ok(Math.abs(page.x - 321) < 1e-9);
    assert.ok(Math.abs(page.y - 654) < 1e-9);
  }
});

test("pressure handles zero, invalid and non-pen input safely", () => {
  assert.equal(normalizedPressure("pen", 0), 0.03);
  assert.equal(normalizedPressure("pen", Number.NaN), 0.5);
  assert.equal(normalizedPressure("pen", 2), 1);
  assert.equal(normalizedPressure("touch", 0.9), 0.5);
});

test("EMA smoothing preserves raw mode and averages stabilized mode", () => {
  const previous = { x: 0, y: 10, p: 0.2 };
  const raw = { x: 10, y: 20, p: 0.8 };
  assert.equal(smoothPoint(previous, raw, 1), raw);
  assert.deepEqual(smoothPoint(previous, raw, 0.5), { x: 5, y: 15, p: 0.5 });
});

test("near-identical samples are reduced but pressure changes are kept", () => {
  const previous = { x: 10, y: 10, p: 0.5 };
  assert.equal(shouldKeepSample(previous, { x: 10.05, y: 10.05, p: 0.5 }, 0.2), false);
  assert.equal(shouldKeepSample(previous, { x: 10.05, y: 10.05, p: 0.7 }, 0.2), true);
  assert.equal(shouldKeepSample(previous, { x: 11, y: 10, p: 0.5 }, 0.2), true);
});
