import { App, PluginSettingTab, Setting } from "obsidian";
import type InkStudioPlugin from "./main";
import type { NibStyle, PressureMode, ToolType } from "./types";

/** Per-tool nib configuration edited in the pen panel. */
export interface PenConfig {
  nib: NibStyle;
  /** 0–100: how strongly stylus pressure affects width. */
  pressurePct: number;
  /** 0–100: input smoothing (EMA) — higher = smoother, laggier line. */
  stabilizationPct: number;
}

/** A saved "pen box" preset: a fully configured pen restored with one tap. */
export interface PenPreset extends PenConfig {
  id: string;
  color: string;
  /** Base width in page units. */
  size: number;
}

export interface InkStudioSettings {
  /**
   * Legacy global pressure mapping. No longer shown in the settings tab — it
   * only affects strokes drawn before v0.3, which didn't store their own
   * thinning. New strokes carry per-pen pressure from the pen panel.
   */
  pressureMode: PressureMode;
  /** Use pen tilt (when reported) for extra shading. Nice-to-have. */
  tiltEnabled: boolean;
  /**
   * When false, only pen + mouse input draws; single/multi touch is reserved
   * for gestures. This is the palm-rejection-safe default for tablet + stylus.
   * Turn on only if you want to draw with a finger (no stylus).
   */
  fingerDrawing: boolean;
  /** Last used colour, restored on new notes. */
  color: string;
  /** Recently used colours shown as quick swatches in the toolbar. */
  recentColors: string[];
  /** Per-tool base widths (page units), independently adjustable. */
  toolSizes: Record<ToolType, number>;
  /** Nib/pressure/stabilization per pen-family tool. */
  penConfigs: Record<"pen" | "pencil", PenConfig>;
  /** Saved pen presets shown as quick-access chips in the toolbar. */
  penPresets: PenPreset[];
  /** Last selected tool. */
  lastTool: ToolType;
}

export const DEFAULT_SETTINGS: InkStudioSettings = {
  pressureMode: "natural",
  tiltEnabled: false,
  fingerDrawing: false,
  color: "#1a1a1a",
  recentColors: ["#1a1a1a", "#e03131", "#1971c2", "#2f9e44", "#f08c00"],
  toolSizes: {
    pen: 4,
    pencil: 3,
    highlighter: 26,
    eraser: 30,
  },
  penConfigs: {
    pen: { nib: "fountain", pressurePct: 70, stabilizationPct: 25 },
    pencil: { nib: "pencil", pressurePct: 55, stabilizationPct: 15 },
  },
  penPresets: [],
  lastTool: "pen",
};

/** Maps the legacy pressure mode to perfect-freehand's `thinning` parameter. */
export const PRESSURE_THINNING: Record<PressureMode, number> = {
  off: 0,
  subtle: 0.35,
  natural: 0.55,
  dramatic: 0.85,
};

/** Pen-panel percentage → perfect-freehand thinning. 70% ≈ the old "natural". */
export function pressurePctToThinning(pct: number): number {
  return Math.max(0, Math.min(100, pct)) * 0.0085;
}

/**
 * Page units → millimetres for the thickness label. Pages are A4-proportioned:
 * 1240 units span 210 mm.
 */
export function unitsToMm(units: number): number {
  return (units * 210) / 1240;
}

export class InkStudioSettingTab extends PluginSettingTab {
  plugin: InkStudioPlugin;

  constructor(app: App, plugin: InkStudioPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Ink Studio" });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Pen options (nib style, pressure, thickness, stabilization, colours) live in the pen panel: tap the active pen tool a second time inside an ink note.",
    });

    new Setting(containerEl)
      .setName("Tilt shading")
      .setDesc(
        "When your stylus reports tilt, vary shading like a calligraphy pen. Experimental."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.tiltEnabled).onChange(async (v) => {
          this.plugin.settings.tiltEnabled = v;
          await this.plugin.saveSettings();
          this.plugin.refreshOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("Draw with finger")
      .setDesc(
        "Off (recommended for stylus + tablet): only the pen and mouse draw, so your palm never leaves marks. Turn on to draw with a finger on devices without a stylus."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.fingerDrawing).onChange(async (v) => {
          this.plugin.settings.fingerDrawing = v;
          await this.plugin.saveSettings();
          this.plugin.refreshOpenViews();
        })
      );
  }
}
