# Pen engine audit and Phase 1 report

## Baseline pipeline

`PointerEvent` is received by `CanvasEngine`, mapped from client coordinates to
page coordinates, pressure-normalised, stabilised, reduced, converted by
`perfect-freehand` into a filled outline, painted on the live canvas, committed
to the base canvas, added to one undo snapshot, then saved through Obsidian's
`TextFileView.requestSave()` autosave path.

- Two canvases already separate committed content from the active stroke.
- Coalesced pointer events were already read, with a parent-event fallback.
- Rendering was already rAF-limited while input samples were collected eagerly.
- Stroke points were page-space `{x,y,p}` vectors; time and tilt were not used.
- Pen pressure was clamped to `0.03..1`; unsupported input used `0.5`.
- One EMA affected position and pressure together.
- Palm rejection permanently disabled finger drawing after the first pen use.
- DPR scaling already kept the viewport canvases sharp on dense displays.
- Full base redraw remains necessary for pan, zoom, erase and selection edits.

## Phase 1 implementation

### Input and dynamics

- Added four pressure curves: soft, linear, hard and piecewise custom.
- Custom curve data is ready for a future graphical editor.
- Added a pressure-only low-latency EMA, separate from position stabilisation.
- Added real distance/time velocity, guarded against zero, backward and long
  timestamp jumps.
- Added a bounded pressure/speed blend. Pressure remains primary; speed can
  make fast marks at most 28% thinner and slow marks at most 8% thicker.
- Added minimum and maximum pressure/width range controls.
- Added five path smoothing profiles: raw, low, natural, high and drawing.
- Added independent start and end taper. One/two-point marks do not taper away.
- Added conservative corner/pressure-aware point reduction.
- Coalesced samples are time-ordered, exact duplicates are removed, and the
  parent event is included without duplicating its final point.
- `pointercancel` no longer appends a potentially false final coordinate.
- Pencil tilt can optionally influence the baked pressure result. Devices with
  absent or invalid tilt retain normal pressure behaviour.

### Palm rejection and touch

Four policies are available:

1. Pen writes; touch navigates.
2. Pen and finger write.
3. Finger only pans/zooms.
4. Disable touch while a pen is present.

Large touch contacts can be rejected for a configurable time after stylus
activity. Two small deliberate contacts remain available for pan/zoom in the
normal pen modes. Older `fingerDrawing` settings are migrated automatically.

### UI and presets

The pen panel now exposes pressure curve, pressure smoothing, speed effect,
path smoothing, stabilisation, min/max width and independent tapers. It also
ships Quick notes, Natural, Calligraphy, Drawing and Diagram feel presets.
Saved pen-box presets carry the new controls; older presets receive defaults.

### File compatibility and size

Existing `.ink` documents remain valid. New strokes keep processed pressure in
their existing point `p` values and capture only render-time smoothing/taper in
an optional `dynamics` object. Input-only configuration is not repeated per
stroke because it is already baked into the final points. This avoids roughly
253 unnecessary JSON bytes per stroke compared with storing the full input
profile. Old strokes without `dynamics` use their previous rendering fallback.

## Verification

- 16 automated tests pass.
- TypeScript and production bundle build pass.
- Coordinate round-trip, malformed pressure, sample-rate-independent velocity,
  four pressure curves, bounded speed blend, timestamp repair, coalesced-event
  dedupe, corner-preserving reduction and palm policy are covered.
- Synthetic benchmark (`npm run benchmark:ink`), 100,000 samples:
  - Dynamics processing: 17.742 ms total, 0.177 microseconds/sample.
  - Point reduction: 3.780 ms.
  - 43,448 of 100,000 dense samples retained.

The benchmark isolates processing cost; it is not a substitute for Android
WebView frame-time traces on 60/120/240 Hz hardware.

## Remaining phases

### Phase 2 — device input hardening

- Stylus barrel-button mapping and eraser-end detection.
- Hover cursor and eraser-radius preview.
- Predicted points on a disposable visual-only layer, behind a setting.
- `lostpointercapture`, visibility-change and rotation/device tests.
- Capture altitude, azimuth and twist only for tools that use them.

### Phase 3 — renderer scaling

- Instrument event latency, processing time, frame time and redraw count in the
  real Obsidian WebView.
- Stop rebuilding the complete active-stroke outline when long strokes grow.
- Add spatial indexing/culling for committed strokes and eraser hit testing.
- Evaluate dirty-rectangle base updates only after visual-equivalence tests.
- Benchmark and optionally cap DPR on memory-constrained tablets.

### Phase 4 — tool architecture and storage safety

- Independent marker, drawing-pen and richer pencil engines with directional
  nib geometry rather than only width-profile differences.
- Partial eraser, per-stroke bounds/layer order and safe invalidation after
  lasso transforms.
- Atomic recovery copy, malformed-file quarantine and multi-view revision guard
  before any mandatory document migration.
