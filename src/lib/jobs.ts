// Long-running work that outlives any one screen: transcription and translation of an episode.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api, rawErrorText, type AsrEvent, type Episode, type Segment, type Transcript } from "./api";
import { batches, translateBatch } from "./ai";
import { isChinese } from "./format";
import { providerFor, useStore } from "../store";

// Messages and errors are kept as the backend wrote them (so they can be matched) and translated with tr() where shown.
export interface AsrJob { stage: "download" | "transcribe" | "done" | "error"; progress: number; message?: string; live: Segment[] }
/** youtube: the publisher's own Chinese subtitles, paired with the original lines by the backend. */
export type TranslateEngine = "llm" | "google" | "youtube";
export interface TranslationJob { items: (string | null)[]; running: boolean; error?: string; failed: number; engine?: TranslateEngine }

interface Jobs {
  transcripts: Record<string, Transcript | null | undefined>;
  officialChecked: Record<string, "searching" | "none" | "error" | "found">;
  officialError: Record<string, string>;
  asr: Record<string, AsrJob>;
  translations: Record<string, TranslationJob>;
}

export const useJobs = create<Jobs>(() => ({ transcripts: {}, officialChecked: {}, officialError: {}, asr: {}, translations: {} }));
const patch = <K extends keyof Jobs>(key: K, id: string, value: Jobs[K][string]) => useJobs.setState((s) => ({ [key]: { ...s[key], [id]: value } }) as Partial<Jobs>);

let listening = false;
export function startJobListeners() {
  if (listening) return;
  listening = true;
  listen<AsrEvent>("asr", ({ payload: p }) => {
    const job = useJobs.getState().asr[p.episodeId] ?? { stage: "download", progress: 0, live: [] };
    if (p.stage === "segment" && p.segment) patch("asr", p.episodeId, { ...job, live: [...job.live, p.segment] });
    else patch("asr", p.episodeId, { ...job, stage: p.stage as AsrJob["stage"], progress: p.progress, message: p.message ?? undefined });
  });
}

/** Cached transcript, else the publisher's subtitles. */
export async function loadTranscript(ep: Episode) {
  const s = useJobs.getState();
  if (s.transcripts[ep.id] || s.officialChecked[ep.id] === "searching") return;
  const cached = await api.loadTranscript(ep.id);
  // Before 0.2.1 a Chinese video that also had English subtitles opened in English: fetch those again.
  const stale = cached?.source.startsWith("youtube") && /[\u4e00-\u9fff].*[\u4e00-\u9fff]/.test(ep.title) && !/[\u3040-\u30ff]/.test(ep.title) && !cached.language.toLowerCase().startsWith("zh");
  if (cached && (!stale || (await api.getBlob(ep.id, "track-picked")))) { patch("transcripts", ep.id, cached); return; }
  if (!ep.videoId && !ep.transcriptUrl && ep.transcriptType !== "qiaomu") { patch("officialChecked", ep.id, "none"); return; }
  patch("officialChecked", ep.id, "searching");
  try {
    const t = await api.fetchOfficialTranscript(ep.id);
    if (t) {
      patch("transcripts", ep.id, t); patch("officialChecked", ep.id, "found");
      // Still not Chinese (a Chinese title over an English video): settled, don't check again on every open.
      if (stale && !t.language.toLowerCase().startsWith("zh")) void api.setBlob(ep.id, "track-picked", "auto");
    } else if (cached) { patch("transcripts", ep.id, cached); patch("officialChecked", ep.id, "found"); }
    else patch("officialChecked", ep.id, "none");
  } catch (e) {
    if (cached) { patch("transcripts", ep.id, cached); patch("officialChecked", ep.id, "found"); return; }
    patch("officialError", ep.id, rawErrorText(e));
    patch("officialChecked", ep.id, "error");
  }
}

export async function generateTranscript(ep: Episode, model: string, language: string) {
  patch("asr", ep.id, { stage: "download", progress: 0, live: [] });
  try {
    const { settings } = useStore.getState();
    const cloud = settings.asrEngine !== "local" ? settings.cloudAsr[settings.asrEngine] : undefined;
    const t = await api.transcribe(ep.id, model, language, cloud);
    patch("transcripts", ep.id, t);
    patch("translations", ep.id, { items: [], running: false, failed: 0 });
    void useStore.getState().reloadShows();
  } catch (e) {
    const job = useJobs.getState().asr[ep.id];
    patch("asr", ep.id, { ...(job ?? { live: [], progress: 0 }), stage: "error", message: rawErrorText(e) });
  }
}

const controllers = new Map<string, AbortController>();
const saveTimers = new Map<string, number>();

export async function loadTranslation(id: string, total: number) {
  if (useJobs.getState().translations[id]) return;
  const raw = await api.getBlob(id, "zh");
  let items: (string | null)[] = [];
  try { items = raw ? JSON.parse(raw) : []; } catch { items = []; }
  if (items.length !== total) items = Array.from({ length: total }, (_, i) => items[i] ?? null);
  const engine = ((await api.getBlob(id, "zh-engine")) as TranslateEngine | null) ?? undefined;
  patch("translations", id, { items, running: false, failed: 0, engine });
}

export function needsTranslation(t: Transcript) {
  return !isChinese(t.language, t.segments.slice(0, 5).map((s) => s.text).join(""));
}

/** Whether the user's own model is ready for translation; otherwise free Google translation is used. */
export async function llmReady(use: "chat" | "translate"): Promise<boolean> {
  const settings = useStore.getState().settings;
  if (use === "translate" && settings.translateMode === "google") return false;
  const p = providerFor(settings, use);
  return Boolean(p?.model && p.baseUrl !== "" && (!p.needsKey || (await api.hasApiKey(p.id))));
}

export async function translateEpisode(ep: Episode, t: Transcript, force?: TranslateEngine) {
  const { settings } = useStore.getState();
  const provider = providerFor(settings, "translate");
  const engine: TranslateEngine = force ?? ((await llmReady("translate")) ? "llm" : "google");
  await loadTranslation(ep.id, t.segments.length);
  const job = useJobs.getState().translations[ep.id];
  if (job.running) return;
  const controller = new AbortController();
  controllers.set(ep.id, controller);
  // Switching engine retranslates everything so one episode never mixes two translators. The publisher's own
  // Chinese is the exception: it stays, and only the lines it doesn't cover are machine-translated.
  const official = job.engine === "youtube" && force == null;
  let items = job.engine && job.engine !== engine && !official ? t.segments.map(() => null) : [...job.items];
  const label: TranslateEngine = official ? "youtube" : engine;
  patch("translations", ep.id, { items, running: true, failed: 0, engine: label });
  void api.setBlob(ep.id, "zh-engine", label);
  const save = () => {
    window.clearTimeout(saveTimers.get(ep.id));
    saveTimers.set(ep.id, window.setTimeout(() => void api.setBlob(ep.id, "zh", JSON.stringify(useJobs.getState().translations[ep.id].items)), 800));
  };
  const merge = (result: Map<number, string>) => {
    items = [...useJobs.getState().translations[ep.id].items];
    for (const [i, text] of result) items[i] = text;
    patch("translations", ep.id, { ...useJobs.getState().translations[ep.id], items });
    save();
  };
  const queue = batches(t.segments, items);
  let failed = 0, lastError = "";
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      if (controller.signal.aborted) return;
      try {
        if (engine === "google") {
          const out = await api.translateTexts(b.ids.map((i) => t.segments[i].text));
          merge(new Map(b.ids.map((id, j) => [id, out[j] ?? ""])));
          continue;
        }
        let result: Map<number, string>;
        try { result = await translateBatch(provider, t.segments, b, ep.title, controller.signal); }
        catch (err) {
          if (controller.signal.aborted) return;
          // One retry, in halves: long batches are what usually trip a model's JSON.
          const half = Math.ceil(b.ids.length / 2);
          if (b.ids.length < 4) throw err;
          const [a, c] = [{ ids: b.ids.slice(0, half) }, { ids: b.ids.slice(half) }];
          result = new Map([...(await translateBatch(provider, t.segments, a, ep.title, controller.signal)), ...(await translateBatch(provider, t.segments, c, ep.title, controller.signal))]);
        }
        merge(result);
      } catch (err) {
        failed++; lastError = rawErrorText(err);
        // A bad key or exhausted quota fails every batch; stop instead of hammering the service.
        if (/API Key|权限|额度|不存在|连不上|网络/.test(lastError)) { controller.abort(); }
      }
    }
  };
  await Promise.all(engine === "google" ? [worker(), worker()] : [worker(), worker(), worker()]);
  controllers.delete(ep.id);
  const final = useJobs.getState().translations[ep.id];
  await api.setBlob(ep.id, "zh", JSON.stringify(final.items));
  patch("translations", ep.id, { ...final, running: false, failed, error: failed ? lastError : undefined });
}

/** Starts translating a foreign-language episode as soon as its transcript is there, whichever tab is open:
 *  the subtitles on the video need the Chinese lines too. */
export function autoTranslate(ep: Episode) {
  const t = useJobs.getState().transcripts[ep.id];
  if (!t || !useStore.getState().settings.autoTranslate || !needsTranslation(t)) return;
  void loadTranslation(ep.id, t.segments.length).then(() => {
    const job = useJobs.getState().translations[ep.id];
    if (!job || job.running || job.error || job.items.every((x) => x != null)) return;
    void translateEpisode(ep, t).catch((e) => patch("translations", ep.id, { ...useJobs.getState().translations[ep.id], running: false, error: rawErrorText(e) }));
  });
}

/** Shows the video's subtitles in another of its YouTube languages. */
export async function switchYoutubeTrack(ep: Episode, language: string, auto: boolean) {
  stopTranslation(ep.id);
  const t = await api.useYoutubeTrack(ep.id, language, auto);
  useJobs.setState((s) => { const translations = { ...s.translations }; delete translations[ep.id]; return { translations, transcripts: { ...s.transcripts, [ep.id]: t } }; });
  autoTranslate(ep);
}

export function stopTranslation(id: string) {
  controllers.get(id)?.abort();
}
