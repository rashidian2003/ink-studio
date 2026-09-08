import assert from "node:assert/strict";
import test from "node:test";
import type { InkPage, Stroke } from "../src/types";
import { createLinkRegion, duplicatePageWithLinks, hitTestLink, linkForSelection, reconcilePageLinks } from "../src/canvas/linkRegions";

const stroke = (id: string, x = 10): Stroke => ({ id, tool: "pen", color: "#111", size: 4, opacity: 1, points: [{ x, y: 10, p: 0.5 }, { x: x + 10, y: 10, p: 0.6 }] });
const page = (): InkPage => ({ id: "page-a", width: 100, height: 100, images: [], texts: [], strokes: [stroke("a"), stroke("b", 25)], links: [] });

test("creates URL, vault and ink-page link targets", () => {
  const p = page();
  assert.equal(createLinkRegion(p.id, p.strokes, { type: "url", url: "https://chatgpt.com/c/test" }, "u")?.target.type, "url");
  assert.equal(createLinkRegion(p.id, p.strokes, { type: "vault-file", path: "Note.md" }, "v")?.target.type, "vault-file");
  assert.equal(createLinkRegion(p.id, p.strokes, { type: "ink-page", path: "Book.ink", pageId: "p2" }, "i")?.target.type, "ink-page");
});

test("selection matching and two-stage hit testing find linked handwriting", () => {
  const p = page();
  p.links = [createLinkRegion(p.id, p.strokes, { type: "vault-file", path: "Note.md" }, "l")!];
  assert.equal(linkForSelection(p, new Set(["a", "b"]))?.id, "l");
  assert.equal(linkForSelection(p, new Set(["x"])), null);
  assert.equal(hitTestLink(p, 15, 10, 4)?.id, "l");
  assert.equal(hitTestLink(p, 15, 50, 4), null);
});

test("deleting linked strokes rebuilds bounds then removes empty links", () => {
  const p = page();
  p.links = [createLinkRegion(p.id, p.strokes, { type: "url", url: "https://example.com" }, "l")!];
  p.strokes = [p.strokes[1]];
  reconcilePageLinks(p);
  assert.deepEqual(p.links?.[0].strokeIds, ["b"]);
  assert.equal(p.links?.[0].bounds.minX, 25);
  p.strokes = [];
  reconcilePageLinks(p);
  assert.deepEqual(p.links, []);
});

test("move and resize preserve ids while reconciliating bounds", () => {
  const p = page();
  p.links = [createLinkRegion(p.id, [p.strokes[0]], { type: "url", url: "https://example.com" }, "l")!];
  p.strokes[0].points.forEach((point) => { point.x = point.x * 2 + 5; point.y += 7; });
  reconcilePageLinks(p);
  assert.deepEqual(p.links?.[0].strokeIds, ["a"]);
  assert.equal(p.links?.[0].bounds.minX, 25);
  assert.equal(p.links?.[0].bounds.minY, 17);
});

test("duplicate page remaps linked stroke ids and self page target", () => {
  const p = page();
  p.links = [createLinkRegion(p.id, p.strokes, { type: "ink-page", path: "Book.ink", pageId: p.id }, "l")!];
  let index = 0;
  const copy = duplicatePageWithLinks(p, "page-copy", () => `copy-${++index}`);
  assert.deepEqual(copy.links?.[0].strokeIds, ["copy-1", "copy-2"]);
  assert.equal(copy.links?.[0].pageId, "page-copy");
  assert.deepEqual(copy.links?.[0].target, { type: "ink-page", path: "Book.ink", pageId: "page-copy" });
});

test("page reorder is safe because ink links use stable page ids", () => {
  const pages = [page(), { ...page(), id: "page-b" }];
  const target = { type: "ink-page" as const, path: "Book.ink", pageId: "page-b" };
  pages[0].links = [createLinkRegion(pages[0].id, pages[0].strokes, target, "l")!];
  pages.reverse();
  assert.equal(pages[1].links?.[0].target.type === "ink-page" && pages[1].links[0].target.pageId, "page-b");
});
