import type { InkBounds, InkLinkRegion, InkLinkTarget, InkPage, Stroke } from "../types";

export function boundsForStrokes(strokes: Stroke[]): InkBounds | null {
  if (strokes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const stroke of strokes) for (const point of stroke.points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export function createLinkRegion(
  pageId: string,
  strokes: Stroke[],
  target: InkLinkTarget,
  id: string,
  label?: string
): InkLinkRegion | null {
  const bounds = boundsForStrokes(strokes);
  if (!bounds) return null;
  return { id, pageId, strokeIds: strokes.map((s) => s.id), bounds, target, label, createdAt: Date.now() };
}

export function reconcilePageLinks(page: InkPage): void {
  const byId = new Map(page.strokes.map((stroke) => [stroke.id, stroke]));
  page.links = (page.links ?? []).flatMap((link) => {
    const strokeIds = link.strokeIds.filter((id) => byId.has(id));
    const bounds = boundsForStrokes(strokeIds.map((id) => byId.get(id)!));
    return bounds ? [{ ...link, strokeIds, bounds }] : [];
  });
}

export function linkForSelection(page: InkPage, selectedIds: Set<string>): InkLinkRegion | null {
  let best: { link: InkLinkRegion; ratio: number } | null = null;
  for (const link of page.links ?? []) {
    const matched = link.strokeIds.filter((id) => selectedIds.has(id)).length;
    const ratio = matched / Math.max(1, link.strokeIds.length);
    if (ratio >= 0.6 && (!best || ratio > best.ratio)) best = { link, ratio };
  }
  return best?.link ?? null;
}

export function hitTestLink(
  page: InkPage,
  x: number,
  y: number,
  padding: number
): InkLinkRegion | null {
  for (let index = (page.links?.length ?? 0) - 1; index >= 0; index--) {
    const link = page.links![index];
    const b = link.bounds;
    if (x < b.minX - padding || x > b.maxX + padding || y < b.minY - padding || y > b.maxY + padding) continue;
    const strokes = page.strokes.filter((stroke) => link.strokeIds.includes(stroke.id));
    const close = strokes.some((stroke) => stroke.points.some((point) => Math.hypot(point.x - x, point.y - y) <= padding * 1.8));
    if (close) return link;
  }
  return null;
}

export function duplicatePageWithLinks(source: InkPage, pageId: string, makeStrokeId: () => string): InkPage {
  const copy = JSON.parse(JSON.stringify(source)) as InkPage;
  const idMap = new Map<string, string>();
  copy.id = pageId;
  copy.strokes = copy.strokes.map((stroke) => {
    const id = makeStrokeId();
    idMap.set(stroke.id, id);
    return { ...stroke, id };
  });
  copy.links = (copy.links ?? []).map((link) => ({
    ...link,
    id: `${link.id}-copy-${pageId}`,
    pageId,
    strokeIds: link.strokeIds.map((id) => idMap.get(id)).filter((id): id is string => !!id),
    target: link.target.type === "ink-page" && link.target.pageId === source.id
      ? { ...link.target, pageId }
      : link.target,
  }));
  reconcilePageLinks(copy);
  return copy;
}
