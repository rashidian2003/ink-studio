import { setToolIcon } from "./icons";
import type {
  NibStyle,
  PressureCurveMode,
  Stroke,
  StrokeSmoothing,
  ToolType,
} from "../types";
import { makeId } from "../types";
import {
  InkStudioSettings,
  PenPreset,
  pressurePctToThinning,
  unitsToMm,
} from "../settings";
import { drawStroke, defaultOpacity, NIB_LABELS } from "../canvas/strokeRender";
import {
  applyPressureCurve,
  constrainPressureRange,
  smoothPressure,
} from "../canvas/inkProcessing";

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

const PEN_FEEL_PRESETS: Array<{
  label: string;
  config: Partial<InkStudioSettings["penConfigs"]["pen"]>;
}> = [
  {
    label: "Quick notes",
    config: {
      nib: "fine",
      pressureCurve: "linear",
      pressurePct: 55,
      pressureSmoothingPct: 16,
      speedEffectPct: 6,
      smoothing: "low",
      stabilizationPct: 8,
      taperStartPct: 3,
      taperEndPct: 5,
    },
  },
  {
    label: "Natural",
    config: {
      nib: "fountain",
      pressureCurve: "soft",
      pressurePct: 70,
      pressureSmoothingPct: 28,
      speedEffectPct: 10,
      smoothing: "natural",
      stabilizationPct: 18,
      taperStartPct: 8,
      taperEndPct: 12,
    },
  },
  {
    label: "Calligraphy",
    config: {
      nib: "fountain",
      pressureCurve: "hard",
      pressurePct: 90,
      pressureSmoothingPct: 34,
      speedEffectPct: 28,
      smoothing: "natural",
      stabilizationPct: 24,
      taperStartPct: 28,
      taperEndPct: 38,
    },
  },
  {
    label: "Drawing",
    config: {
      nib: "pencil",
      pressureCurve: "linear",
      pressurePct: 82,
      pressureSmoothingPct: 24,
      speedEffectPct: 16,
      smoothing: "high",
      stabilizationPct: 34,
      taperStartPct: 5,
      taperEndPct: 10,
      useTilt: true,
    },
  },
  {
    label: "Diagram",
    config: {
      nib: "fine",
      pressureCurve: "linear",
      pressurePct: 0,
      pressureSmoothingPct: 0,
      speedEffectPct: 0,
      smoothing: "high",
      stabilizationPct: 30,
      taperStartPct: 0,
      taperEndPct: 0,
    },
  },
];

export interface PenPanelHost {
  settings: InkStudioSettings;
  getColor(): string;
  setColor(color: string, remember: boolean): void;
  /** Persist settings + re-render whatever depends on them. */
  onConfigChanged(): void;
  addPreset(preset: PenPreset): void;
  /** Keep toolbar expanded/open state in sync with the floating panel. */
  onOpenChange?(open: boolean, tool: ToolType): void;
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
    const wasOpen = this.el !== null;
    document.removeEventListener("pointerdown", this.dismiss, true);
    this.el?.remove();
    this.el = null;
    this.previewCanvas = null;
    if (wasOpen) this.host.onOpenChange?.(false, this.tool);
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
    panel.style.visibility = "hidden";

    const isPenFamily = tool === "pen" || tool === "pencil";
    const cfg = isPenFamily ? this.host.settings.penConfigs[tool] : null;

    const header = panel.createDiv({ cls: "ink-panel-header" });
    const heading = header.createDiv({ cls: "ink-panel-heading" });
    heading.createDiv({
      cls: "ink-panel-title",
      text: tool === "highlighter" ? "Highlighter" : tool === "eraser" ? "Eraser" : tool === "pencil" ? "Pencil" : "Pen",
    });
    heading.createDiv({
      cls: "ink-panel-subtitle",
      text: tool === "eraser" ? "Adjust eraser width" : "Tune the feel of your stroke",
    });

    // --- live preview ---
    if (tool !== "eraser") {
      this.previewCanvas = panel.createEl("canvas", { cls: "ink-pen-preview" });
      this.previewCanvas.width = 300;
      this.previewCanvas.height = 64;
    }

    // --- nib row ---
    if (isPenFamily && cfg) {
      panel.createDiv({ cls: "ink-section-label", text: "Nib style" });
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

    if (isPenFamily && cfg) {
      panel.createDiv({ cls: "ink-section-label", text: "Writing feel" });
      const feelRow = panel.createDiv({ cls: "ink-feel-row" });
      for (const preset of PEN_FEEL_PRESETS) {
        const button = feelRow.createEl("button", {
          cls: "ink-feel-btn",
          text: preset.label,
          attr: { type: "button", title: `Apply ${preset.label} settings` },
        });
        button.onclick = () => {
          Object.assign(cfg, preset.config);
          this.host.onConfigChanged();
          this.close();
          this.open(anchor, tool);
        };
      }
    }

    // --- sliders ---
    panel.createDiv({ cls: "ink-section-label", text: "Stroke controls" });
    const sliders = panel.createDiv({ cls: "ink-pen-sliders" });

    if (isPenFamily && cfg) {
      this.select(
        sliders,
        "Pressure curve",
        {
          soft: "Soft",
          linear: "Linear",
          hard: "Hard",
          custom: "Custom",
        },
        cfg.pressureCurve,
        (value) => {
          cfg.pressureCurve = value as PressureCurveMode;
          this.host.onConfigChanged();
          this.paintPreview();
        }
      );
      this.slider(sliders, "Pressure sensitivity", 0, 100, cfg.pressurePct, (v, label) => {
        cfg.pressurePct = v;
        label.setText(`${v}%`);
        this.host.onConfigChanged();
        this.paintPreview();
      }, `${cfg.pressurePct}%`);

      this.slider(sliders, "Pressure smoothing", 0, 100, cfg.pressureSmoothingPct, (v, label) => {
        cfg.pressureSmoothingPct = v;
        label.setText(`${v}%`);
        this.host.onConfigChanged();
        this.paintPreview();
      }, `${cfg.pressureSmoothingPct}%`);

      this.slider(sliders, "Speed effect", 0, 100, cfg.speedEffectPct, (v, label) => {
        cfg.speedEffectPct = v;
        label.setText(`${v}%`);
        this.host.onConfigChanged();
      }, `${cfg.speedEffectPct}%`);
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
      this.select(
        sliders,
        "Path smoothing",
        {
          raw: "Raw",
          low: "Low",
          natural: "Natural",
          high: "High",
          drawing: "Drawing",
        },
        cfg.smoothing,
        (value) => {
          cfg.smoothing = value as StrokeSmoothing;
          this.host.onConfigChanged();
          this.paintPreview();
        }
      );
      this.slider(sliders, "Stroke stabilization", 0, 100, cfg.stabilizationPct, (v, label) => {
        cfg.stabilizationPct = v;
        label.setText(`${v}%`);
        this.host.onConfigChanged();
      }, `${cfg.stabilizationPct}%`);

      this.slider(sliders, "Minimum width", 0, 100, cfg.minWidthPct, (v, label) => {
        cfg.minWidthPct = Math.min(v, cfg.maxWidthPct);
        label.setText(`${cfg.minWidthPct}%`);
        this.host.onConfigChanged();
        this.paintPreview();
      }, `${cfg.minWidthPct}%`);

      this.slider(sliders, "Maximum width", 1, 100, cfg.maxWidthPct, (v, label) => {
        cfg.maxWidthPct = Math.max(v, cfg.minWidthPct);
        label.setText(`${cfg.maxWidthPct}%`);
        this.host.onConfigChanged();
        this.paintPreview();
      }, `${cfg.maxWidthPct}%`);

      this.slider(sliders, "Start taper", 0, 100, cfg.taperStartPct, (v, label) => {
        cfg.taperStartPct = v;
        label.setText(`${v}%`);
        this.host.onConfigChanged();
        this.paintPreview();
      }, `${cfg.taperStartPct}%`);

      this.slider(sliders, "End taper", 0, 100, cfg.taperEndPct, (v, label) => {
        cfg.taperEndPct = v;
        label.setText(`${v}%`);
        this.host.onConfigChanged();
        this.paintPreview();
      }, `${cfg.taperEndPct}%`);
    }

    // --- colours ---
    if (tool !== "eraser") {
      panel.createDiv({ cls: "ink-section-label", text: "Colour" });
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
          ...cfg,
          customPressureCurve: cfg.customPressureCurve.map((point) => ({ ...point })),
          id: makeId("pp-"),
          color: this.host.getColor(),
          size: sizes[tool],
        });
        boxBtn.setText("Added ✓");
        window.setTimeout(() => boxBtn.setText("Add to pen box"), 1200);
      };
    }

    this.paintPreview();
    this.positionNear(anchor);
    panel.style.removeProperty("visibility");
    this.host.onOpenChange?.(true, tool);
    // Defer so the opening tap doesn't immediately dismiss the panel.
    window.setTimeout(
      () => document.addEventListener("pointerdown", this.dismiss, true),
      0
    );
  }

  /** Place the panel above or below its anchor and keep it inside the note. */
  private positionNear(anchor: HTMLElement): void {
    const panel = this.el;
    if (!panel) return;
    const margin = 8;
    const gap = 8;
    const rootRect = this.root.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const maxLeft = Math.max(margin, rootRect.width - panelRect.width - margin);
    const left = Math.max(
      margin,
      Math.min(anchorRect.left - rootRect.left, maxLeft)
    );
    const below = rootRect.bottom - anchorRect.bottom - gap;
    const above = anchorRect.top - rootRect.top - gap;
    const preferredTop =
      panelRect.height <= below || below >= above
        ? anchorRect.bottom - rootRect.top + gap
        : anchorRect.top - rootRect.top - panelRect.height - gap;
    const maxTop = Math.max(margin, rootRect.height - panelRect.height - margin);
    panel.style.left = `${left}px`;
    panel.style.top = `${Math.max(margin, Math.min(preferredTop, maxTop))}px`;
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

  private select(
    parent: HTMLElement,
    name: string,
    options: Record<string, string>,
    value: string,
    onChange: (value: string) => void
  ): void {
    const row = parent.createDiv({ cls: "ink-slider-row ink-select-row" });
    const head = row.createDiv({ cls: "ink-slider-head" });
    head.createSpan({ cls: "ink-slider-name", text: name });
    const select = row.createEl("select", { cls: "dropdown ink-pen-select" });
    for (const [optionValue, label] of Object.entries(options)) {
      const option = select.createEl("option", {
        text: label,
        attr: { value: optionValue },
      });
      option.selected = optionValue === value;
    }
    select.onchange = () => onChange(select.value);
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
    let previousPressure: number | null = null;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = 16 + t * (canvas.width - 32);
      const y =
        canvas.height / 2 +
        Math.sin(t * Math.PI * 2.2) * (canvas.height / 2 - 14);
      // Pressure ramps up then eases off, so thinning is visible end-to-end.
      let p = 0.25 + 0.65 * Math.sin(t * Math.PI);
      if (cfg) {
        p = applyPressureCurve(p, cfg.pressureCurve, cfg.customPressureCurve);
        p = smoothPressure(previousPressure, p, cfg.pressureSmoothingPct);
        previousPressure = p;
        p = constrainPressureRange(p, cfg.minWidthPct, cfg.maxWidthPct);
      }
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
      dynamics: cfg
        ? {
            smoothing: cfg.smoothing,
            taperStartPct: cfg.taperStartPct,
            taperEndPct: cfg.taperEndPct,
          }
        : undefined,
      points,
    };
    drawStroke(ctx, stroke, { pressureMode: this.host.settings.pressureMode }, false);
  }
}
