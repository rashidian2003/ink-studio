import { App, requestUrl } from "obsidian";

// Minimal Gemini vision client for handwriting OCR. Same request pattern as
// AI Flashcard Studio's client (requestUrl → works on mobile, x-goog-api-key
// header), but fully standalone: Ink Studio has its own key setting and only
// *falls back* to the flashcard plugin's key when its own is empty.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export class GeminiError extends Error {
  constructor(
    message: string,
    public readonly kind: "auth" | "quota" | "network" | "api"
  ) {
    super(message);
  }
}

/** The flashcard plugin's key, if that plugin is installed and configured. */
export function flashcardStudioApiKey(app: App): string {
  try {
    const plugins = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } })
      .plugins?.plugins;
    const fc = plugins?.["ai-flashcard-studio"] as
      | { data?: { settings?: { apiKey?: string } }; settings?: { apiKey?: string } }
      | undefined;
    return (fc?.data?.settings?.apiKey ?? fc?.settings?.apiKey ?? "").trim();
  } catch {
    return "";
  }
}

const OCR_PROMPT = [
  "Transcribe the handwritten text in this image exactly as written.",
  "Preserve the line breaks of the handwriting.",
  "The text may be German, English, or Persian (Farsi) — transcribe it in its original language and script.",
  "Mathematical notation should be written in plain linear form (e.g. x^2, a/b, sqrt(x)).",
  "If a word is truly unreadable, write it as [?].",
  "Output ONLY the transcribed text — no commentary, no headings, no code fences.",
].join("\n");

/**
 * OCR a PNG of handwriting via Gemini. `pngBase64` is the raw base64 payload
 * (no data: prefix). Returns the transcribed text.
 */
export async function transcribeHandwriting(
  apiKey: string,
  model: string,
  pngBase64: string
): Promise<string> {
  const key = apiKey.trim();
  if (!key) {
    throw new GeminiError(
      "No Gemini API key configured. Add one in Settings → Ink Studio.",
      "auth"
    );
  }
  const mdl = model.trim() || "gemini-2.0-flash";
  const url = `${API_BASE}/${encodeURIComponent(mdl)}:generateContent`;

  let response;
  try {
    response = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: OCR_PROMPT },
              { inline_data: { mime_type: "image/png", data: pngBase64 } },
            ],
          },
        ],
      }),
      throw: false,
    });
  } catch (e) {
    throw new GeminiError(
      `Network error talking to Gemini: ${(e as Error).message}`,
      "network"
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new GeminiError("Gemini rejected the API key.", "auth");
  }
  if (response.status === 429) {
    throw new GeminiError("Gemini rate limit reached — try again in a moment.", "quota");
  }
  if (response.status >= 400) {
    const msg =
      (response.json as { error?: { message?: string } } | undefined)?.error?.message ??
      `HTTP ${response.status}`;
    throw new GeminiError(`Gemini API error: ${msg}`, "api");
  }

  const json = response.json as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) {
    throw new GeminiError("Gemini returned an empty transcription.", "api");
  }
  return text;
}
