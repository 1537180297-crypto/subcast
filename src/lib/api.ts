import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Show {
  id: string;
  kind: "youtube" | "podcast" | "xiaoyuzhou" | "single";
  title: string;
  author?: string;
  cover?: string;
  feedUrl: string;
  link?: string;
  description?: string;
  updatedAt: number;
  unplayed: number;
}

export interface Episode {
  id: string;
  showId: string;
  guid: string;
  title: string;
  published?: number;
  duration?: number;
  audioUrl?: string;
  videoId?: string;
  link?: string;
  cover?: string;
  notes?: string;
  transcriptUrl?: string;
  transcriptType?: string;
  progress: number;
  hasTranscript: boolean;
  showTitle?: string;
}

export interface Segment { start: number; end: number; text: string }
export interface Transcript { episodeId: string; source: string; language: string; segments: Segment[] }
export interface SearchResult { title: string; author: string; cover?: string; feedUrl: string; genre?: string; episodes?: number }
export interface ModelInfo { id: string; name: string; sizeMb: number; note: string; installed: boolean }
export interface Provider { id: string; name: string; protocol: "openai" | "anthropic"; baseUrl: string; model: string; needsKey: boolean; keyUrl?: string; models?: string[] }
export interface ChatMessage { role: "user" | "assistant"; content: string }

export interface AsrEvent { episodeId: string; stage: "download" | "transcribe" | "segment" | "done" | "error"; progress: number; message?: string; segment?: Segment }

export const api = {
  addSubscription: (input: string) => invoke<{ show?: Show; episode?: Episode }>("add_subscription", { input }),
  refreshShow: (id: string) => invoke<Show>("refresh_show", { id }),
  refreshAll: () => invoke<number>("refresh_all"),
  listShows: () => invoke<Show[]>("list_shows"),
  listEpisodes: (showId?: string, limit?: number) => invoke<Episode[]>("list_episodes", { showId, limit }),
  recentEpisodes: () => invoke<Episode[]>("recent_episodes"),
  getEpisode: (id: string) => invoke<Episode | null>("get_episode", { id }),
  removeShow: (id: string) => invoke<void>("remove_show", { id }),
  setProgress: (id: string, seconds: number) => invoke<void>("set_progress", { id, seconds }),
  searchPodcasts: (term: string, country?: string) => invoke<SearchResult[]>("search_podcasts", { term, country }),
  loadTranscript: (episodeId: string) => invoke<Transcript | null>("load_transcript", { episodeId }),
  fetchOfficialTranscript: (episodeId: string) => invoke<Transcript | null>("fetch_official_transcript", { episodeId }),
  transcribe: (episodeId: string, model: string, language: string) => invoke<Transcript>("transcribe", { episodeId, model, language }),
  cancelJob: (id: string) => invoke<void>("cancel_job", { id }),
  asrModels: () => invoke<ModelInfo[]>("asr_models"),
  downloadModel: (id: string, mirrorFirst: boolean) => invoke<void>("download_model", { id, mirrorFirst }),
  deleteModel: (id: string) => invoke<void>("delete_model", { id }),
  getBlob: (episodeId: string, kind: string) => invoke<string | null>("get_blob", { episodeId, kind }),
  setBlob: (episodeId: string, kind: string, data: string) => invoke<void>("set_blob", { episodeId, kind, data }),
  getSettings: () => invoke<unknown>("get_settings"),
  setSettings: (settings: unknown) => invoke<void>("set_settings", { settings }),
  setApiKey: (provider: string, key: string) => invoke<void>("set_api_key", { provider, key }),
  hasApiKey: (provider: string) => invoke<boolean>("has_api_key", { provider }),
};

let llmCounter = 0;

/** Streams one model reply. `onDelta` receives the text so far. */
export async function llmChat(opts: {
  provider: Provider;
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  jsonMode?: boolean;
  onDelta?: (full: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const requestId = `llm-${Date.now()}-${llmCounter++}`;
  let full = "";
  let unlisten: UnlistenFn | undefined;
  if (opts.onDelta) {
    unlisten = await listen<{ requestId: string; delta: string }>("llm", (ev) => {
      if (ev.payload.requestId !== requestId) return;
      full += ev.payload.delta;
      opts.onDelta!(full);
    });
  }
  const abort = () => void api.cancelJob(requestId);
  opts.signal?.addEventListener("abort", abort);
  try {
    const { id, protocol, baseUrl, model } = opts.provider;
    return await invoke<string>("llm_chat", {
      requestId,
      provider: { id, protocol, baseUrl, model },
      system: opts.system,
      messages: opts.messages,
      maxTokens: opts.maxTokens,
      jsonMode: opts.jsonMode,
    });
  } finally {
    unlisten?.();
    opts.signal?.removeEventListener("abort", abort);
  }
}

export const errorText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
