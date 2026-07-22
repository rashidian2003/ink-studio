import { Menu } from "obsidian";
import { setToolIcon } from "./icons";
import type { InkPage, PressureMode } from "../types";
import { renderPageToCanvas } from "../canvas/pageRender";

// Horizontal page-overview strip: tap to jump, drag horizontally to reorder,
// per-page menu for delete. Rendering is tiny (fixed thumb width), so a full
// re-render on change is cheap.

const THUMB_WIDTH = 92;
/** Pixels of horizontal movement before a press becomes a drag. */
const DRAG_THRESHOLD = 12;

export interface StripHost {
  getPages(): InkPage[];
  getCurrentIndex(): number;
  getPressureMode(): PressureMode;
  getDark(): boolean;
  resolveBackground(page: InkPage): CanvasImageSource | null;
  resolveImage(path: string): CanvasImageSource | null;
  onSelect(index: number): void;
  onDelete(index: number): void;
  onDuplicate(index: number): void;
  onRename(index: number): void;
  onAdd(event: MouseEvent): void;
  onMove(from: number, to: number): void;
  onVisibilityChange?(visible: boolean): void;
}

export class ThumbnailStrip {
  private host: StripHost;
  private el: HTMLElement;
  private body: HTMLElement;
  private scrim: HTMLElement;
  private countEl: HTMLElement;
  private visible = false;

  constructor(parent: HTMLElement, host: StripHost) {
    this.host = host;
    this.scrim = parent.createDiv({ cls: "ink-page-drawer-scrim" });
    this.scrim.onclick = () => this.setVisible(false);
    this.scrim.hide();
    this.el = parent.createDiv({ cls: "ink-thumb-strip ink-page-drawer" });
    const header = this.el.createDiv({ cls: "ink-page-drawer-header" });
    const heading = header.createDiv({ cls: "ink-page-drawer-heading" });
    heading.createDiv({ cls: "ink-page-drawer-title", text: "Pages" });
    this.countEl = heading.createDiv({ cls: "ink-page-drawer-count", text: "1 page" });
    const actions = header.createDiv({ cls: "ink-page-drawer-actions" });
    const add = actions.createEl("button", {
      cls: "ink-page-drawer-action",
      attr: { type: "button", title: "Add page", "aria-label": "Add page" },
    });
    setToolIcon(add, "plus");
    add.onclick = (event) => this.host.onAdd(event);
    const close = actions.createEl("button", {
      cls: "ink-page-drawer-action",
      attr: { type: "button", title: "Close pages", "aria-label": "Close pages" },
    });
    setToolIcon(close, "chevron-right");
    close.onclick = () => this.setVisible(false);
    this.body = this.el.createDiv({ cls: "ink-page-drawer-body" });
    this.el.hide();
  }

  isVisible(): boolean {
    return this.visible;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (v) {
      this.render();
      this.scrim.show();
      this.el.show();
      window.requestAnimationFrame(() => this.el.addClass("is-open"));
    } else {
      this.el.removeClass("is-open");
      this.el.hide();
      this.scrim.hide();
    }
    this.host.onVisibilityChange?.(v);
  }

  /** Rebuild all thumbnails. Cheap at thumb size; call on any change. */
  render(): void {
    if (!this.visible) return;
    this.body.empty();
    const pages = this.host.getPages();
    const current = this.host.getCurrentIndex();
    this.countEl.setText(`${pages.length} ${pages.length === 1 ? "page" : "pages"}`);

    pages.forEach((page, index) => {
      const item = this.body.createDiv({ cls: "ink-thumb" });
      if (index === current) item.addClass("is-current");

      const canvas = renderPageToCanvas(page, {
        width: THUMB_WIDTH * (window.devicePixelRatio || 1),
        pressureMode: this.host.getPressureMode(),
        includeBackground: true,
        includeTemplate: true,
        dark: this.host.getDark(),
        resolveBackground: (p) => this.host.resolveBackground(p),
        resolveImage: (p) => this.host.resolveImage(p),
      });
      canvas.addClass("ink-thumb-canvas");
      canvas.style.width = `${THUMB_WIDTH}px`;
      item.appendChild(canvas);

      item.createDiv({ cls: "ink-thumb-label", text: String(index + 1) });
      item.createDiv({
        cls: "ink-thumb-name",
        text: page.name || `Page ${index + 1}`,
      });

      const menuBtn = item.createDiv({ cls: "ink-thumb-menu" });
      setToolIcon(menuBtn, "more-vertical");
      menuBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const menu = new Menu();
        menu.addItem((mi) =>
          mi
            .setTitle("Rename page…")
            .setIcon("pencil")
            .onClick(() => this.host.onRename(index))
        );
        menu.addItem((mi) =>
          mi
            .setTitle("Duplicate page")
            .setIcon("copy")
            .onClick(() => this.host.onDuplicate(index))
        );
        menu.addSeparator();
        menu.addItem((mi) =>
          mi
            .setTitle("Delete page")
            .setIcon("trash-2")
            .onClick(() => this.host.onDelete(index))
        );
        menu.showAtMouseEvent(e as MouseEvent);
      });

      this.attachPressHandlers(item, index);
    });
  }

  /** Tap = select; horizontal drag = reorder. Pointer-based so it works on touch. */
  private attachPressHandlers(item: HTMLElement, index: number): void {
    item.addEventListener("pointerdown", (e: PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const vertical = getComputedStyle(this.body).flexDirection === "column";
        const delta = vertical ? dy : dx;
        if (!dragging && Math.abs(delta) > DRAG_THRESHOLD) {
          dragging = true;
          item.addClass("is-dragging");
          item.setPointerCapture(e.pointerId);
        }
        if (dragging) {
          item.style.transform = vertical
            ? `translateY(${dy}px)`
            : `translateX(${dx}px)`;
        }
      };

      const onUp = (ev: PointerEvent) => {
        item.removeEventListener("pointermove", onMove);
        item.removeEventListener("pointerup", onUp);
        item.removeEventListener("pointercancel", onUp);
        item.style.transform = "";
        item.removeClass("is-dragging");
        if (!dragging) {
          if (ev.type === "pointerup") this.host.onSelect(index);
          return;
        }
        const target = this.indexAtPoint(ev.clientX, ev.clientY);
        if (target !== null && target !== index) {
          this.host.onMove(index, target);
        } else {
          this.render();
        }
      };

      item.addEventListener("pointermove", onMove);
      item.addEventListener("pointerup", onUp);
      item.addEventListener("pointercancel", onUp);
    });
  }

  /** Which slot does a client-x fall on? Uses thumb midpoints. */
  private indexAtPoint(clientX: number, clientY: number): number | null {
    const thumbs = Array.from(this.body.querySelectorAll<HTMLElement>(".ink-thumb"));
    if (thumbs.length === 0) return null;
    const vertical = getComputedStyle(this.body).flexDirection === "column";
    for (let i = 0; i < thumbs.length; i++) {
      const r = thumbs[i].getBoundingClientRect();
      if (vertical ? clientY < r.top + r.height / 2 : clientX < r.left + r.width / 2) {
        return i;
      }
    }
    return thumbs.length - 1;
  }
}
