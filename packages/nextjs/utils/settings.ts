/** AI provider settings (docs/PROTOCOL.md section 7). Stored in the browser only. */
export type AiProvider = "off" | "anthropic" | "openai-compatible";

export type AiSettings = {
  provider: AiProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
};

const KEY = "iw.ai.v1";
export const DEFAULT_AI: AiSettings = { provider: "off", baseUrl: "https://api.openai.com/v1", apiKey: "", model: "" };

export function readAiSettings(): AiSettings {
  if (typeof window === "undefined") return DEFAULT_AI;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_AI, ...(JSON.parse(raw) as Partial<AiSettings>) } : DEFAULT_AI;
  } catch {
    return DEFAULT_AI;
  }
}

export function writeAiSettings(s: AiSettings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

/** Headers for /api/intent: the BYO key rides per request and is never stored server-side. */
export function aiHeaders(s: AiSettings): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", "x-ai-provider": s.provider };
  if (s.provider === "openai-compatible") {
    h["x-ai-base-url"] = s.baseUrl;
    h["x-ai-key"] = s.apiKey;
    h["x-ai-model"] = s.model;
  }
  return h;
}

/** User display name (for "Good morning, Austin"). */
const NAME_KEY = "iw.name";
export function readName(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(NAME_KEY) ?? "";
}
export function writeName(n: string) {
  localStorage.setItem(NAME_KEY, n.trim().slice(0, 40));
}
