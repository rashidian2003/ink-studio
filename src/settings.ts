import { App, PluginSettingTab, Setting } from "obsidian";
import type InkStudioPlugin from "./main";
import type { NibStyle, PressureMode, ToolType } from "./types";
import type { ToolbarMode, ToolbarPosition } from "./view/floatingToolbar";

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
  /**
   * Gemini API key for handwriting → text conversion. When empty, Ink Studio
   * falls back to AI Flashcard Studio's key if that plugin is installed.
   */
  geminiApiKey: string;
  /** Gemini model id used for OCR. */
  geminiModel: string;
  /**
   * Paper appearance. "auto" follows Obsidian's own light/dark theme; the
   * others force it. Dark paper is a display-only comfort mode — stored ink
   * colours and PDF export are unaffected.
   */
  paperTheme: "auto" | "light" | "dark";
  /** Floating toolbar density and dock position, shared across ink notes. */
  toolbarMode: ToolbarMode;
  toolbarPosition: ToolbarPosition;
  toolbarFloatX: number;
  toolbarFloatY: number;
  /** Maximum per-page undo snapshots retained in memory. */
  historyLimit: number;
  /** Quiet period after a change before asking Obsidian to persist the file. */
  autosaveDelayMs: number;
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
  geminiApiKey: "",
  geminiModel: "gemini-2.0-flash",
  paperTheme: "auto",
  toolbarMode: "full",
  toolbarPosition: "bottom",
  toolbarFloatX: 24,
  toolbarFloatY: 96,
  historyLimit: 60,
  autosaveDelayMs: 350,
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

    containerEl.createEl("h3", { text: "Pen & writing" });

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

    containerEl.createEl("h3", { text: "Input & touch" });

    new Setting(containerEl)
      .setName("Draw with finger")
      .setDesc(
        "Off (recommended for stylus + tablet): only the pen and mouse draw. Touch remains available for page navigation and two-finger zoom."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.fingerDrawing).onChange(async (v) => {
          this.plugin.settings.fingerDrawing = v;
          await this.plugin.saveSettings();
          this.plugin.refreshOpenViews();
        })
      );

    containerEl.createEl("h3", { text: "Appearance" });

    new Setting(containerEl)
      .setName("Paper")
      .setDesc(
        "Dark paper is a night-writing comfort mode: the page turns dark and your ink is shown lighter so it stays visible. Your saved colours and PDF exports are unchanged."
      )
      .addDropdown((d) =>
        d
          .addOptions({ auto: "Auto (follow Obsidian)", light: "Light", dark: "Dark" })
          .setValue(this.plugin.settings.paperTheme)
          .onChange(async (v) => {
            this.plugin.settings.paperTheme = v as "auto" | "light" | "dark";
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("Toolbar density")
      .setDesc("Full shows every control, compact keeps core writing tools, hidden leaves a small restore button.")
      .addDropdown((d) =>
        d
          .addOptions({ full: "Full", compact: "Compact", hidden: "Hidden" })
          .setValue(this.plugin.settings.toolbarMode)
          .onChange(async (v) => {
            this.plugin.settings.toolbarMode = v as ToolbarMode;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("Toolbar position")
      .setDesc("You can also drag the dotted handle; the toolbar snaps to a nearby edge.")
      .addDropdown((d) =>
        d
          .addOptions({
            bottom: "Bottom",
            top: "Top",
            left: "Left",
            right: "Right",
            floating: "Floating",
          })
          .setValue(this.plugin.settings.toolbarPosition)
          .onChange(async (v) => {
            this.plugin.settings.toolbarPosition = v as ToolbarPosition;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    containerEl.createEl("h3", { text: "Performance" });

    new Setting(containerEl)
      .setName("Undo history")
      .setDesc("Maximum steps kept per page. Lower values use less memory in very large notes.")
      .addSlider((slider) =>
        slider
          .setLimits(10, 120, 10)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.historyLimit)
          .onChange(async (value) => {
            this.plugin.settings.historyLimit = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Autosave delay")
      .setDesc("Groups rapid edits before asking Obsidian to save. A final save is requested when the view closes.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            "150": "150 ms (fast)",
            "350": "350 ms (recommended)",
            "700": "700 ms (battery saver)",
          })
          .setValue(String(this.plugin.settings.autosaveDelayMs))
          .onChange(async (value) => {
            this.plugin.settings.autosaveDelayMs = Number(value);
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "AI handwriting (Gemini)" });

    new Setting(containerEl)
      .setName("Gemini API key")
      .setDesc(
        "Used by “Convert handwriting to text”. Leave empty to reuse AI Flashcard Studio's key if that plugin is installed. Get a key at aistudio.google.com."
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("AIza…")
          .setValue(this.plugin.settings.geminiApiKey)
          .onChange(async (v) => {
            this.plugin.settings.geminiApiKey = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Gemini model")
      .setDesc("Any Gemini model id with vision support.")
      .addText((t) =>
        t
          .setPlaceholder("gemini-2.0-flash")
          .setValue(this.plugin.settings.geminiModel)
          .onChange(async (v) => {
            this.plugin.settings.geminiModel = v.trim() || "gemini-2.0-flash";
            await this.plugin.saveSettings();
          })
      );

  }
}
