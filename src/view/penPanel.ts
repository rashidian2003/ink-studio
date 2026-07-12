import { setToolIcon } from "./icons";
import type { NibStyle, Stroke, ToolType } from "../types";
import { makeId } from "../types";
import {
  InkStudioSettings,
  PenPreset,
  pressurePctToThinning,
  unitsToMm,
} from "../settings";
import { drawStroke, defaultOpacity, NIB_LABELS } from "../canvas/strokeRender";

// The per-pen settings popover, opened by tapping the active tool a second
// time. Live preview squiggle + nib picker + pressure / thickness /
// stabilization sliders + colour swatches + "Add to pen box".

const NIB_ICONS: Record<NibStyle, string> = {
  fountain: "pen-tool",
  fine: "pen-line",
  pencil: "pencil",
  colored: "palette",
  charcoal: "brush",
};

export interface PenPanelHost {
  settings: InkStudioSettings;
  getColor(): string;
  setColor(color: string, remember: boolean): void;
  /** Persist settings + re-render whatever depends on them. */
  onConfigChanged(): void;
  addPreset(preset: PenPreset): void;
}

export class PenPanel {
  private host: PenPanelHost;
  private root: HTMLElement;
  private el: HTMLElement | null = null;
  private tool: ToolType = "pen";
  private previewCanvas: HTMLCanvasElement | null = null;
  private dismiss = (e: PointerEvent): void => {
    if (!this.el) return;
    const t = e.target as Node;
    if (this.el.contains(t)) return;
    this.close();
  };

  constructor(root: HTMLElement, host: PenPanelHost) {
    this.root = root;
    this.host = host;
  }

  isOpen(): boolean {
    return this.el !== null;
  }

  close(): void {
    document.removeEventListener("pointerdown", this.dismiss, true);
    this.el?.remove();
    this.el = null;
    this.previewCanvas = null;
  }

  toggle(anchor: HTMLElement, tool: ToolType): void {
    if (this.el && this.tool === tool) {
      this.close();
      return;
    }
    this.close();
    this.open(anchor, tool);
  }

  open(anchor: HTMLElement, tool: ToolType): void {
    this.tool = tool;
    const panel = this.root.createDiv({ cls: "ink-pen-panel" });
    this.el = panel;

    // Anchor below the button, clamped to the view.
    const rootRect = this.root.getBoundingClientRect();
    const aRect = anchor.getBoundingClientRect();
    panel.style.top = `${aRect.bottom - rootRect.top + 6}px`;
    panel.style.left = `${Math.max(8, Math.min(aRect.left - rootRect.left, rootRect.width - 340))}px`;

    const isPenFamily = tool === "pen" || tool === "pencil";
    const cfg = isPenFamily ? this.host.settings.penConfigs[tool] : null;

    // --- live preview ---
    if (tool !== "eraser") {
      this.previewCanvas = panel.createEl("canvas", { cls: "ink-pen-preview" });
      this.previewCanvas.width = 300;
      this.previewCanvas.height = 64;
    }

    // --- nib row ---
    if (isPenFamily && cfg) {
      const nibRow = panel.createDiv({ cls: "ink-nib-row" });
      (Object.keys(NIB_LABELS) as NibStyle[]).forEach((nib) => {
        const btn = nibRow.createEl("button", {
          cls: "ink-tb-btn ink-nib-btn",
          attr: { title: NIB_LABELS[nib], "aria-label": NIB_LABELS[nib] },
        });
        setToolIcon(btn, NIB_ICONS[nib]);
        btn.toggleClass("is-active", cfg.nib === nib);
        btn.onclick = () => {
          cfg.nib = nib;
          nibRow
            .querySelectorAll(".ink-nib-btn")
            .forEach((b, i) =>
              (b as HTMLElement).toggleClass(
                "is-active",
                (Object.keys(NIB_LABELS) as NibStyle[])[i] === nib
              )
            );
          this.host.onConfigChanged();
          this.paintPreview();
        };
      });
    }

    // --- sliders ---
    const sliders = panel.createDiv({ cls: "ink-pen-sliders" });

    if (isPenFamily && cfg) {
      this.slider(sliders, "Pressure sensitivity", 0, 100, cfg.pressurePct, (v, label) => {
        cfg.pressurePct = v;
        label.setText(`${v}%`);
        this.host.onConfigChanged();
        this.paintPreview();
      }, `${cfg.pressurePct}%`);
    }

    const sizes = this.host.settings.toolSizes;
    const maxSize = tool === "highlighter" || tool === "eraser" ? 80 : 24;
    this.slider(sliders, "Thickness", 1, maxSize, sizes[tool], (v, label) => {
      sizes[tool] = v;
      label.setText(`${unitsToMm(v).toFixed(2)}mm`);
      this.host.onConfigChanged();
      this.paintPreview();
    }, `${unitsToMm(sizes[tool]).toFixed(2)}mm`);

    if (isPenFamily && cfg) {
      this.slider(sliders, "Stroke stabilization", 0, 100, cfg.stabilizationPct, (v, label) => {
        cfg.stabilizationPct = v;
        label.setText(`${v}%`);
        this.host.onConfigChanged();
      }, `${cfg.stabilizationPct}%`);
    }

    // --- colours ---
    if (tool !== "eraser") {
      const swatchRow = panel.createDiv({ cls: "ink-pen-swatches" });
      for (const color of this.host.settings.recentColors) {
        const sw = swatchRow.createEl("button", {
          cls: "ink-swatch",
          attr: { title: color },
        });
        sw.style.backgroundColor = color;
        sw.toggleClass(
          "is-active",
          color.toLowerCase() === this.host.getColor().toLowerCase()
        );
        sw.onclick = () => {
          this.host.setColor(color, false);
          swatchRow.querySelectorAll(".ink-swatch").forEach((b) => {
            (b as HTMLElement).toggleClass(
              "is-active",
              (b as HTMLElement).style.backgroundColor === sw.style.backgroundColor
            );
          });
          this.paintPreview();
        };
      }
      const addColor = swatchRow.createEl("button", {
        cls: "ink-swatch ink-swatch-add",
        attr: { title: "Add custom colour", "aria-label": "Add custom colour" },
      });
      setToolIcon(addColor, "plus");
      const hidden = swatchRow.createEl("input", {
        attr: { type: "color" },
        cls: "ink-hidden-color-input",
      }) as HTMLInputElement;
      hidden.value = this.host.getColor();
      addColor.onclick = () => hidden.click();
      hidden.oninput = () => {
        this.host.setColor(hidden.value, true);
        this.paintPreview();
        // Re-open to refresh the swatch row with the new colour first.
        const anchorNow = anchor;
        this.close();
        this.open(anchorNow, tool);
      };
    }

    // --- pen box ---
    if (isPenFamily && cfg) {
      const boxBtn = panel.createEl("button", {
        cls: "ink-pen-box-btn mod-cta",
        text: "Add to pen box",
      });
      boxBtn.onclick = () => {
        this.host.addPreset({
          id: makeId("pp-"),
          nib: cfg.nib,
          color: this.host.getColor(),
          size: sizes[tool],
          pressurePct: cfg.pressurePct,
          stabilizationPct: cfg.stabilizationPct,
        });
        boxBtn.setText("Added ✓");
        window.setTimeout(() => boxBtn.setText("Add to pen box"), 1200);
      };
    }

    this.paintPreview();
    // Defer so the opening tap doesn't immediately dismiss the panel.
    window.setTimeout(
      () => document.addEventListener("pointerdown", this.dismiss, true),
      0
    );
  }

  private slider(
    parent: HTMLElement,
    name: string,
    min: number,
    max: number,
    value: number,
    onInput: (v: number, valueLabel: HTMLElement) => void,
    initialLabel: string
  ): void {
    const row = parent.createDiv({ cls: "ink-slider-row" });
    const head = row.createDiv({ cls: "ink-slider-head" });
    head.createSpan({ cls: "ink-slider-name", text: name });
    const valueLabel = head.createSpan({ cls: "ink-slider-value", text: initialLabel });
    const input = row.createEl("input", {
      attr: { type: "range", min: String(min), max: String(max), step: "1" },
      cls: "ink-pen-slider",
    }) as HTMLInputElement;
    input.value = String(value);
    input.oninput = () => onInput(parseInt(input.value, 10), valueLabel);
  }

  /** Squiggle preview reflecting nib, size, colour and pressure mapping. */
  private paintPreview(): void {
    const canvas = this.previewCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const tool = this.tool;
    const isPenFamily = tool === "pen" || tool === "pencil";
    const cfg = isPenFamily ? this.host.settings.penConfigs[tool] : null;
    const points = [];
    const n = 60;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = 16 + t * (canvas.width - 32);
      const y =
        canvas.height / 2 +
        Math.sin(t * Math.PI * 2.2) * (canvas.height / 2 - 14);
      // Pressure ramps up then eases off, so thinning is visible end-to-end.
      const p = 0.25 + 0.65 * Math.sin(t * Math.PI);
      points.push({ x, y, p });
    }
    const stroke: Stroke = {
      id: "preview",
      tool: tool === "eraser" ? "pen" : tool,
      color: this.host.getColor(),
      size: this.host.settings.toolSizes[tool],
      opacity: defaultOpacity(tool, cfg?.nib),
      sim: false,
      nib: cfg?.nib,
      thin: cfg ? pressurePctToThinning(cfg.pressurePct) : 0,
      points,
    };
    drawStroke(ctx, stroke, { pressureMode: this.host.settings.pressureMode }, false);
  }
}
