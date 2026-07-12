# Ink Studio

Handwriting / stylus note-taking **inside Obsidian**, built for Android tablets
with a stylus (S Pen and generic Android styluses). The goal is to make Obsidian
your single tool for both typed and handwritten notes — no separate GoodNotes /
Notability / Samsung Notes needed.

This is an independent plugin from *AI Flashcard Studio*; they share no code and
coexist cleanly (different plugin id, no default hotkeys).

## Status

**Deliverables 1–3 plus Addendum 1 (multi-page, PDF import/export, images):**

1. ✅ Base plugin + `.ink` note type with a canvas that captures stylus pointer input.
2. ✅ Pressure sensitivity + full pen toolbar (Pen / Pencil / Highlighter / Eraser, colour picker, per-tool width).
3. ✅ Palm rejection via `pointerType` filtering.
4. ✅ **Multi-page** (Addendum Part C): add page, prev/next arrows + page indicator,
   single-finger swipe to flip pages (palm-guarded), page-overview thumbnail strip
   with tap-to-jump, drag-to-reorder, and per-page delete.
5. ✅ **PDF import & annotated export** (Addendum Part A): import from vault or the
   device's file picker (device copies land in the vault as attachments); each PDF
   page becomes an Ink Studio page rendered via Obsidian's own bundled pdf.js
   (`loadPdfJs`, works on mobile). Source PDFs are never modified; "Export as
   annotated PDF" (⋮ menu) writes a **new** file, copying original pages losslessly
   with `pdf-lib` and stamping the ink layer on top.
6. ✅ **Images** (Addendum Part B): insert from vault / gallery / camera (camera on
   mobile), clipboard paste and drag-drop; move + corner-resize with the select
   tool; ink draws on top of images. Undo/redo covers image operations.
- ✅ Also in: per-page undo/redo history, stroke eraser, autosave.

**Addendum 2 (v0.3.0):**

7. ✅ **Page templates** (Part B): blank / grid / lined / dotted with three
   spacings, per-page + per-note default (`⋮ → Page template…`); new pages
   inherit the note default; export offers "with template" or "ink only".
8. ✅ **Pen panel** (Part A): tap the active tool a second time → popover with a
   live preview squiggle, 5 nib styles (fountain / fine / pencil / colored
   pencil / charcoal — distinct width/opacity/smoothing behaviour), pressure
   sensitivity slider (%, default 70% ≈ old "natural"), thickness slider
   labeled in mm, **stroke stabilization** slider (EMA smoothing of raw input),
   colour swatches + custom colours, and **"Add to pen box"** which saves the
   whole pen as a one-tap preset chip in the toolbar (long-press/right-click a
   chip to remove).
9. ✅ **Shapes / table / ruler** (Part D): shapes button → pick rectangle,
   ellipse, triangle, line or arrow, then drag on the page — committed as
   normal ink strokes (erasable/undoable/exportable); Table… asks rows ×
   columns then drag-to-place a grid; ruler button drops a movable/rotatable
   ruler — strokes starting near its edge snap perfectly straight while keeping
   real pen pressure. Shape *recognition* (draw rough → auto-snap) is a
   planned refinement.
10. ✅ **Stickers** (Part C): emoji picker (curated grid + free input); stickers
    are stored as characters and drawn as text — crisp at any zoom, no
    attachment files — and move/resize/delete exactly like images.

Still to come: infinite-canvas mode + pinch-zoom/two-finger-pan (rest of 4), lasso
selection of strokes with move/resize/rotate/recolor (5), text boxes + editable
table cells (8), vault linking / embeds / search polish (9), autosave &
crash-resilience hardening (10), shape recognition.

## Key design decision — the file model

Ink notes are stored as their own **`.ink` file** in the vault, whose body is
the stroke data serialised as JSON. The file is opened by a custom view that
subclasses Obsidian's **`TextFileView`** (the same base Excalidraw uses).

Why this over the alternatives:

| Option | Verdict |
| --- | --- |
| **`.ink` file + `TextFileView`** (chosen) | Real vault file: shows in the explorer, syncs via Obsidian Sync, is linkable, and plugs into Obsidian's own save/dirty lifecycle — which gives us autosave essentially for free. |
| Markdown "shell" note + sidecar data file | Two files to keep in sync per note; more moving parts, more ways to orphan data. |
| Binary attachment | Not human-diffable, weaker linking story, fights the "looks like a normal note" goal. |

**Trade-off:** because `.ink` is a custom extension, its handwritten content
isn't picked up by Obsidian's built-in text search, and `[[embeds]]` need custom
rendering (both planned for Deliverable 9). Everything else — explorer visibility,
linking by name, sync, autosave — works natively.

## Architecture

```
src/
  main.ts               Plugin: registers the view + .ink extension, ribbon, command, settings.
  types.ts              InkDocument / InkPage / Stroke / InkImage / PageTemplate / ShapeSpec model.
  settings.ts           Settings + tab; PenConfig (nib/pressure/stabilization), pen presets, mm mapping.
  assets.ts             Per-view cache: async PDF-page renders + vault images → sync lookups (LRU-capped).
  importers.ts          Vault & device file pickers, attachment saving, PDF → InkPage[] builder.
  view/InkView.ts       TextFileView subclass: toolbar, flows, paste/drop; is the EngineHost.
  view/penPanel.ts      Per-pen popover: preview squiggle, nibs, sliders, swatches, pen box.
  view/stickerPicker.ts Emoji sticker popover (curated grid + free input).
  view/templateModal.ts Page-template picker with live pattern previews.
  view/thumbnailStrip.ts  Page overview strip: tap to jump, drag to reorder, delete menu.
  canvas/CanvasEngine.ts  Pointer input, palm rejection, pages, select/move/resize, shapes drag,
                          ruler + snapping, input stabilization, per-page undo.
  canvas/strokeRender.ts  perfect-freehand → Path2D; nib profiles; per-stroke pressure thinning.
  canvas/shapes.ts        Point-series generators (rect/ellipse/triangle/line/arrow/table).
  canvas/templates.ts     Grid / lined / dotted paper patterns.
  canvas/pageRender.ts    Offline full-page render (thumbnails, export overlays), emoji drawing.
  pdf/pdfRenderer.ts      Obsidian loadPdfJs wrapper: parsed-doc cache + page → canvas.
  pdf/pdfExport.ts        pdf-lib: copy source pages + stamp ink overlay → new "(annotated).pdf".
```

### Rendering (low latency)

Two stacked canvases:

- **base** — every committed stroke; only fully redrawn on load / undo / erase / resize.
- **live** — just the in-progress stroke, cleared and redrawn each pointer move.

So a pointer move only re-renders the current stroke, never the whole page.
Strokes are turned into smooth, variable-width outlines by
[`perfect-freehand`](https://github.com/steveruizok/perfect-freehand) (bundled).

### Palm rejection (Deliverable 3)

- Only `pen` and `mouse` (and `touch` **only** if you opt into "Draw with finger")
  create ink. Once a stylus has touched a note, touch is locked out of drawing entirely.
- While a stroke is active, any other pointer (a palm landing as a separate
  `touch`) is dropped.
- `touch-action: none` on the drawing surface stops the browser turning
  pen/touch into scroll/zoom.

Pressure is read from `PointerEvent.pressure`; for mouse/touch it's simulated
from velocity by perfect-freehand. `Settings → Pressure sensitivity`
(off / subtle / natural / dramatic) tunes how strongly it maps to width.

## Build

Fish shell (dev machine only):

```fish
cd ~/ink-studio
npm install
npm run build        # typecheck + production bundle -> main.js
# dev watch:
npm run dev
```

Install into a vault by copying `main.js`, `manifest.json`, `styles.css` into
`<vault>/.obsidian/plugins/ink-studio/` (already done for the local vault).

## How to test

1. In Obsidian: **Settings → Community plugins → enable “Ink Studio”** (reload plugins if it's not listed).
2. Click the pen ribbon icon, or run the command **“Create new ink note”**. A new `Ink note.ink` opens with a blank page.
3. Draw with mouse (desktop) or stylus (tablet). Switch Pen/Pencil/Highlighter/Eraser, pick colours, change width.
4. Undo/redo with the toolbar or `Ctrl/Cmd+Z` / `Shift+Ctrl/Cmd+Z`. Close and reopen the note — strokes persist (autosave).
5. **Pages:** `+` adds a page; flip with the arrows, `←`/`→` keys, or a quick
   one-finger horizontal swipe on touch. The grid button opens the page overview:
   tap to jump, drag a thumbnail sideways to reorder, `⋮` on a thumbnail to delete.
6. **PDF:** file-plus button → “PDF from vault” / “PDF from device”, then write on
   the pages. `⋮` → “Export as annotated PDF” writes `<note> (annotated).pdf`
   next to the note; the source PDF is untouched.
7. **Images:** image button → vault / gallery / camera, or paste (`Cmd/Ctrl+V`) /
   drag-drop. Use the select (arrow) tool to move, corner-drag to resize,
   trash button or `Delete` key to remove.
8. **Pen panel:** with the pen active, tap the pen button again — adjust nib,
   pressure %, thickness (mm), stabilization %, colour; "Add to pen box" saves
   the pen as a toolbar chip (long-press / right-click a chip to remove it).
9. **Templates:** `⋮ → Page template…` — pick grid/lined/dotted + spacing,
   optionally as the note default. Export offers "with template" / "ink only".
10. **Shapes & ruler:** shapes button → pick a shape → drag on the page;
    Table… asks rows × columns then drag to place. Ruler button drops the
    ruler — drag its middle to move, ends to rotate; strokes starting near an
    edge come out perfectly straight.
11. **Stickers:** smiley button → tap an emoji (or type any) — it lands on the
    page and behaves like an image (select tool to move/resize).
12. **On the Android tablet (primary target):** rest your palm while writing with
    the S Pen — palm marks should not appear; verify PDF pages render on-device
    (Obsidian's own pdf.js is used, so it should match the built-in PDF viewer);
    verify camera capture and gallery import; try stabilization at 0/50/100% to
    find your feel. Report latency/palm feel — that feedback drives the
    remaining deliverables.
