import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const outputDir = mkdtempSync(join(tmpdir(), "ink-studio-benchmark-"));
const outfile = join(outputDir, "ink-processing.mjs");
await build({
  entryPoints: ["src/canvas/inkProcessing.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
});

const engine = await import(pathToFileURL(outfile).href);
const count = 100_000;
const points = [];
let previousPressure = null;
let previousTimed = null;
const started = performance.now();
for (let index = 0; index < count; index++) {
  const t = index * (1000 / 240);
  const point = {
    x: index * 0.06,
    y: Math.sin(index / 17) * 2,
    t,
  };
  const velocity = engine.pointVelocity(previousTimed, point);
  let pressure = 0.5 + Math.sin(index / 31) * 0.4;
  pressure = engine.applyPressureCurve(pressure, "soft");
  pressure = engine.smoothPressure(previousPressure, pressure, 28);
  previousPressure = pressure;
  pressure = engine.combinePressureAndSpeed(pressure, velocity, 12);
  pressure = engine.constrainPressureRange(pressure, 8, 100);
  points.push({ x: point.x, y: point.y, p: pressure });
  previousTimed = point;
}
const processedMs = performance.now() - started;
const reduceStarted = performance.now();
const reduced = engine.reduceStrokePoints(points, 0.18);
const reducedMs = performance.now() - reduceStarted;

console.log(
  JSON.stringify(
    {
      samples: count,
      processingMs: Number(processedMs.toFixed(3)),
      processingMicrosecondsPerSample: Number(((processedMs * 1000) / count).toFixed(3)),
      reductionMs: Number(reducedMs.toFixed(3)),
      retainedSamples: reduced.length,
    },
    null,
    2
  )
);
