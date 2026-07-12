import { Menu, setIcon } from "obsidian";
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
  resolveBackground(page: InkPage): CanvasImageSource | null;
  resolveImage(path: string): CanvasImageSource | null;
  onSelect(index: number): void;
  onDelete(index: number): void;
  onMove(from: number, to: number): void;
}

export class ThumbnailStrip {
  private host: StripHost;
  private el: HTMLElement;
  private visible = false;

  constructor(parent: HTMLElement, host: StripHost) {
    this.host = host;
    this.el = parent.createDiv({ cls: "ink-thumb-strip" });
    this.el.hide();
  }

  isVisible(): boolean {
    return this.visible;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (v) {
      this.render();
      this.el.show();
    } else {
      this.el.hide();
    }
  }

  /** Rebuild all thumbnails. Cheap at thumb size; call on any change. */
  render(): void {
    if (!this.visible) return;
    this.el.empty();
    const pages = this.host.getPages();
    const current = this.host.getCurrentIndex();

    pages.forEach((page, index) => {
      const item = this.el.createDiv({ cls: "ink-thumb" });
      if (index === current) item.addClass("is-current");

      const canvas = renderPageToCanvas(page, {
        width: THUMB_WIDTH * (window.devicePixelRatio || 1),
        pressureMode: this.host.getPressureMode(),
        includeBackground: true,
        includeTemplate: true,
        resolveBackground: (p) => this.host.resolveBackground(p),
        resolveImage: (p) => this.host.resolveImage(p),
      });
      canvas.addClass("ink-thumb-canvas");
      canvas.style.width = `${THUMB_WIDTH}px`;
      item.appendChild(canvas);

      item.createDiv({ cls: "ink-thumb-label", text: String(index + 1) });

      const menuBtn = item.createDiv({ cls: "ink-thumb-menu" });
      setIcon(menuBtn, "more-vertical");
      menuBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const menu = new Menu();
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
      let dragging = false;

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        if (!dragging && Math.abs(dx) > DRAG_THRESHOLD) {
          dragging = true;
          item.addClass("is-dragging");
          item.setPointerCapture(e.pointerId);
        }
        if (dragging) {
          item.style.transform = `translateX(${dx}px)`;
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
        const target = this.indexAtX(ev.clientX);
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
  private indexAtX(clientX: number): number | null {
    const thumbs = Array.from(this.el.querySelectorAll<HTMLElement>(".ink-thumb"));
    if (thumbs.length === 0) return null;
    for (let i = 0; i < thumbs.length; i++) {
      const r = thumbs[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return thumbs.length - 1;
  }
}
