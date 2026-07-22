# Ink Studio test checklist

Run the automated checks before packaging a release:

```sh
npm test
npm run build
```

## Desktop and mouse

- Create, reopen and rename an ink note.
- Draw a dot, a short stroke and a long fast stroke.
- Verify undo/redo after draw, erase, image move and lasso move.
- Zoom at the pointer with Ctrl/Cmd + wheel and pan with the wheel.
- Open the page manager from the page indicator; add, duplicate, rename,
  reorder and delete pages.
- Drag the toolbar and verify snapping at all four edges.
- Reopen the note and verify toolbar mode/position are restored.
- Enter focus mode and exit with both the fixed button and Escape.

## Android tablet and stylus

- Write slowly and quickly with light and heavy pressure.
- Draw a long curve quickly; check for missing segments or angular gaps.
- Compare stabilization at 0%, 25%, 50% and 100%.
- Rest the palm before and during a pen stroke; no touch marks should appear.
- While not writing, use two fingers to zoom and pan around their midpoint.
- Verify a one-finger touch does not draw when **Draw with finger** is off.
- Test portrait and landscape with toolbar docked bottom, left and right.
- Verify every toolbar target is comfortable with pen and touch.
- Rotate the device while the toolbar is floating; it must remain reachable.
- Open the keyboard for a text box and verify floating panels remain on-screen.

## Rendering and themes

- Switch between Obsidian light/dark mode and at least one custom theme.
- Confirm paper boundary, shadow and surrounding workspace remain distinct.
- Test blank, lined, grid, dotted and PDF-backed pages.
- Verify thumbnails match the current paper mode and page content.
- Check that active tools are identifiable without relying only on colour.
- Enable reduced motion at OS level and confirm UI remains usable.

## Persistence and recovery

- Draw, immediately close the view, and reopen it; the final stroke must exist.
- Make several fast edits and verify the save indicator returns to **Saved**.
- Open notes created by versions before 0.14.0.
- Verify optional page names survive close/reopen and sync.
- Export an annotated PDF and verify page order and source PDF integrity.

## Large-note scenarios

Repeat navigation, draw, erase, undo and zoom checks with approximately 100,
1,000, 5,000 and 10,000 strokes. Watch especially for delay at pointer-down,
eraser stalls and memory growth after 60+ edits. The automated suite includes a
10,000-stroke parse guard; canvas frame rate and device memory still require
manual testing inside Obsidian because they depend on the WebView and GPU.
