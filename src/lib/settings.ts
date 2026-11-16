import { api, type Provider } from "./api";

export interface Settings {
  providers: Record<string, Provider>;
  chatProvider: string;
  translateProvider: string;
  proxy: string;
  asrModel: string;
  asrLanguage: string;
  mirrorFirst: boolean;
  autoTranslate: boolean;
  subtitleMode: "bilingual" | "original" | "translation";
  playbackRate: number;
}

// Model names are suggestions; every field stays editable because providers rename models often.
export const PRESETS: Provider[] = [
  { id: "deepseek", name: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", needsKey: true, keyUrl: "https://platform.deepseek.com/api_keys", models: ["deepseek-flash", "deepseek-v4-pro", "deepseek-chat"] },
  { id: "siliconflow", name: "硅基流动", protocol: "openai", baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3", needsKey: true, keyUrl: "https://cloud.siliconflow.cn/account/ak", models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen3-235B-A22B-Instruct-2507"] },
  { id: "moonshot", name: "Kimi（月之暗面）", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k3", needsKey: true, keyUrl: "https://platform.moonshot.cn/console/api-keys", models: ["kimi-k3", "kimi-k2.6"] },
  { id: "anthropic", name: "Claude（Anthropic）", protocol: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", needsKey: true, keyUrl: "https://console.anthropic.com/settings/keys", models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] },
  { id: "openai", name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-luna", needsKey: true, keyUrl: "https://platform.openai.com/api-keys", models: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"] },
  { id: "openrouter", name: "OpenRouter", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-5.5", needsKey: true, keyUrl: "https://openrouter.ai/keys" },
  { id: "ollama", name: "Ollama（本机）", protocol: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3.5", needsKey: false, models: ["qwen3.5", "gemma4", "gpt-oss:20b"] },
  { id: "custom", name: "其他（OpenAI 兼容）", protocol: "openai", baseUrl: "", model: "", needsKey: true },
];

export const DEFAULTS: Settings = {
  providers: Object.fromEntries(PRESETS.map((p) => [p.id, p])),
  chatProvider: "deepseek",
  translateProvider: "deepseek",
  proxy: "",
  asrModel: "qwen3-asr",
  asrLanguage: "auto",
  mirrorFirst: true,
  autoTranslate: true,
  subtitleMode: "bilingual",
  playbackRate: 1,
};

export async function loadSettings(): Promise<Settings> {
  const raw = (await api.getSettings()) as Partial<Settings> | null;
  if (!raw) return structuredClone(DEFAULTS);
  // Keep presets' metadata (key links, suggestions) current while keeping what the user edited.
  const providers: Record<string, Provider> = {};
  for (const p of PRESETS) providers[p.id] = { ...p, ...(raw.providers?.[p.id] ?? {}), keyUrl: p.keyUrl, models: p.models, needsKey: p.needsKey, name: p.name };
  return { ...DEFAULTS, ...raw, providers };
}
