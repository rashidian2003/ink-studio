import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument, serializeDocument } from "../src/types";

test("legacy ink documents open with defensive defaults", () => {
  const document = parseDocument(
    JSON.stringify({
      version: 1,
      app: "ink-studio",
      mode: "page",
      pageSize: "a4",
      pages: [{ id: "old-page", width: 1240, height: 1754, strokes: [] }],
    })
  );
  assert.equal(document.pages.length, 1);
  assert.deepEqual(document.pages[0].images, []);
  assert.deepEqual(document.pages[0].texts, []);
  assert.equal(document.pages[0].name, undefined);
});

test("optional page names survive serialization", () => {
  const document = parseDocument(
    JSON.stringify({
      version: 1,
      app: "ink-studio",
      mode: "page",
      pageSize: "a4",
      pages: [
        {
          id: "named-page",
          name: "Lecture notes",
          width: 1240,
          height: 1754,
          images: [],
          texts: [],
          strokes: [],
        },
      ],
    })
  );
  assert.equal(document.pages[0].name, "Lecture notes");
  assert.equal(JSON.parse(serializeDocument(document)).pages[0].name, "Lecture notes");
});

test("new render dynamics round-trip without affecting legacy strokes", () => {
  const raw = JSON.stringify({
    version: 1,
    app: "ink-studio",
    mode: "page",
    pageSize: "a4",
    pages: [
      {
        id: "mixed-page",
        width: 1240,
        height: 1754,
        images: [],
        texts: [],
        strokes: [
          {
            id: "legacy",
            tool: "pen",
            color: "#111111",
            size: 4,
            opacity: 1,
            points: [{ x: 1, y: 2, p: 0.5 }],
          },
          {
            id: "new",
            tool: "pen",
            color: "#111111",
            size: 4,
            opacity: 1,
            dynamics: { smoothing: "natural", taperStartPct: 8, taperEndPct: 12 },
            points: [{ x: 2, y: 3, p: 0.6 }],
          },
        ],
      },
    ],
  });
  const document = parseDocument(raw);
  assert.equal(document.pages[0].strokes[0].dynamics, undefined);
  assert.deepEqual(document.pages[0].strokes[1].dynamics, {
    smoothing: "natural",
    taperStartPct: 8,
    taperEndPct: 12,
  });
  assert.deepEqual(JSON.parse(serializeDocument(document)).pages[0].strokes[1].dynamics, {
    smoothing: "natural",
    taperStartPct: 8,
    taperEndPct: 12,
  });
});

test("malformed content fails safe to a usable empty document", () => {
  const document = parseDocument("{broken");
  assert.equal(document.app, "ink-studio");
  assert.equal(document.pages.length, 1);
});

test("a 10,000-stroke document remains practical to parse", () => {
  const strokes = Array.from({ length: 10_000 }, (_, index) => ({
    id: `stroke-${index}`,
    tool: "pen",
    color: "#111111",
    size: 4,
    opacity: 1,
    points: [
      { x: index % 1000, y: Math.floor(index / 1000), p: 0.4 },
      { x: (index % 1000) + 3, y: Math.floor(index / 1000) + 2, p: 0.6 },
    ],
  }));
  const raw = JSON.stringify({
    version: 1,
    app: "ink-studio",
    mode: "page",
    pageSize: "a4",
    pages: [
      { id: "large-page", width: 1240, height: 1754, images: [], texts: [], strokes },
    ],
  });
  const started = Date.now();
  const document = parseDocument(raw);
  const elapsed = Date.now() - started;
  assert.equal(document.pages[0].strokes.length, 10_000);
  // Generous enough for CI and slower tablets while still catching accidental
  // quadratic migrations in the parser.
  assert.ok(elapsed < 5_000, `parse took ${elapsed}ms`);
});
