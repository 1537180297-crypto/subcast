import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";
import { api, type TtsRequest } from "./api";
import { TTS_SERVICES, type Settings, type TtsService } from "./settings";
import { useStore } from "../store";
import { t } from "./i18n";

/** Reads text aloud with the active TTS engine, a sentence-aligned chunk at a time, prefetching the next. */
let session = 0;
let audio: HTMLAudioElement | null = null;

export const useTtsPreview = create<{ active: string | null }>(() => ({ active: null }));

export function currentTtsService(s: Settings): TtsService {
  return s.ttsServices[s.ttsEngine] ?? s.ttsServices.edge ?? TTS_SERVICES[0];
}

export function isKeyError(m: string): boolean {
  return m.includes("Key") || m.includes("API Key");
}

function maxChunkChars(protocol: TtsService["protocol"]): number {
  switch (protocol) {
    case "qwen": return 480;
    case "doubao": return 900;
    case "edge": return 800;
    default: return 800;
  }
}

export function chunks(text: string, max = 800): string[] {
  const parts = text.replace(/\s+\n/g, "\n").split(/(?<=[。！？!?；;\n])/);
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = ""; }
    cur += p.length > max ? p.slice(0, max) : p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

export function buildTtsRequest(
  s: Settings,
  text: string,
  opts?: { engine?: string; voice?: string; rate?: number },
): TtsRequest {
  const svc = (opts?.engine ? s.ttsServices[opts.engine] : undefined) ?? currentTtsService(s);
  const voice = opts?.voice ?? svc.voice;
  const rate = opts?.rate ?? s.ttsRate ?? 1;
  return {
    engine: svc.id,
    protocol: svc.protocol,
    baseUrl: svc.baseUrl || undefined,
    model: svc.model || undefined,
    voice,
    resource: svc.resource || undefined,
    text,
    rate,
    needsKey: svc.needsKey,
  };
}

export async function synthesizeText(
  text: string,
  opts?: { engine?: string; voice?: string; rate?: number },
): Promise<{ url: string; path: string; seconds: number }> {
  const req = buildTtsRequest(useStore.getState().settings, text, opts);
  const res = await api.ttsSynthesize(req);
  return { url: convertFileSrc(res.path), path: res.path, seconds: res.seconds };
}

export function stopSpeaking() {
  session++;
  audio?.pause();
  audio = null;
  useStore.getState().set({ speaking: false });
  useTtsPreview.setState({ active: null });
}

function playUrl(url: string, playbackRate = 1): Promise<void> {
  const el = new Audio(url);
  el.playbackRate = Math.min(2, Math.max(0.5, playbackRate));
  audio = el;
  return new Promise<void>((resolve, reject) => {
    el.onended = () => resolve();
    el.onerror = () => reject(new Error(t("音频播放失败")));
    void el.play().catch(reject);
  });
}

export async function speak(text: string, onError?: (m: string) => void) {
  stopSpeaking();
  const id = ++session;
  const { settings, player, playing } = useStore.getState();
  if (playing) player?.toggle();
  useStore.getState().set({ speaking: true });
  const svc = currentTtsService(settings);
  const parts = chunks(text, maxChunkChars(svc.protocol));
  const fetchPart = (i: number) => (i < parts.length ? synthesizeText(parts[i]) : Promise.resolve(null));
  let next = fetchPart(0);
  try {
    for (let i = 0; i < parts.length; i++) {
      const res = await next;
      if (id !== session || !res) return;
      next = fetchPart(i + 1);
      await playUrl(res.url);
      if (id !== session) return;
    }
  } catch (e) {
    if (id === session) onError?.(String((e as any)?.message ?? e));
  } finally {
    if (id === session) useStore.getState().set({ speaking: false });
  }
}

function sampleLine(voiceId: string): string {
  const v = voiceId.toLowerCase();
  if (v.startsWith("en") || v.includes("default_en") || v === "tim" || v === "dacey") {
    return "Hello, this is a voice sample from SubCast.";
  }
  return t("你好，这是 SubCast 朗读音色试听。");
}

/** Synthesises and plays one short sample sentence for the given engine + voice. */
export async function previewVoice(engineId: string, voiceId: string, onError?: (m: string) => void) {
  const key = `${engineId}:${voiceId}`;
  if (useTtsPreview.getState().active === key) {
    stopSpeaking();
    return;
  }
  stopSpeaking();
  const id = ++session;
  useTtsPreview.setState({ active: key });
  try {
    const res = await synthesizeText(sampleLine(voiceId), { engine: engineId, voice: voiceId });
    if (id !== session) return;
    await playUrl(res.url);
  } catch (e) {
    if (id === session) onError?.(String((e as any)?.message ?? e));
  } finally {
    if (id === session) useTtsPreview.setState({ active: null });
  }
}

/** Scores Web Speech voices so macOS Premium / Neural / Enhanced voices win over robotic compact ones. */
function voiceScore(v: SpeechSynthesisVoice, langPrefix: "en" | "zh"): number {
  const lang = v.lang.toLowerCase();
  if (!lang.startsWith(langPrefix)) return -1;
  const id = `${v.voiceURI} ${v.name}`.toLowerCase();
  let s = 0;
  if (langPrefix === "en" ? lang.startsWith("en-us") : lang.startsWith("zh-cn")) s += 20;
  if (/premium|gryphon-neural|siri\.natural/.test(id)) s += 100;
  else if (/enhanced/.test(id)) s += 80;
  if (/super-compact/.test(id)) s -= 20;
  if (langPrefix === "en" && /samantha|ava|zoe|allison|alex|daniel|karen|nora/.test(id)) s += 30;
  if (langPrefix === "zh" && /tingting|meijia|sinji/.test(id)) s += 30;
  if (v.localService) s += 5;
  return s;
}

/** Speaks with the best installed system voice (preferring macOS Premium / Enhanced voices). */
export function speakSystemEnhanced(text: string, lang: "en-US" | "zh-CN" = "en-US", rate = 0.9): void {
  const synth = window.speechSynthesis;
  if (!synth) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = rate;
  const prefix = lang.startsWith("zh") ? "zh" : "en";
  const voices = synth.getVoices();
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = -1;
  for (const v of voices) {
    const sc = voiceScore(v, prefix);
    if (sc > bestScore) { bestScore = sc; best = v; }
  }
  if (best) u.voice = best;
  synth.speak(u);
}

function englishVoiceFor(svc: TtsService): string {
  switch (svc.id) {
    case "edge": return svc.voice.toLowerCase().startsWith("en-") ? svc.voice : "en-US-AndrewMultilingualNeural";
    case "doubao": return svc.voice.toLowerCase().startsWith("en_") ? svc.voice : "en_male_tim_uranus_bigtts";
    case "mimo": return "default_en";
    default: return svc.voice;
  }
}

let wordSession = 0;
let wordAudio: HTMLAudioElement | null = null;

/** Pronounces an English word/phrase using the configured default TTS (cached on disk), falling back to macOS Enhanced system voice. */
export async function speakWord(text: string, rate = 0.9): Promise<void> {
  const id = ++wordSession;
  wordAudio?.pause();
  wordAudio = null;
  window.speechSynthesis?.cancel();

  const svc = currentTtsService(useStore.getState().settings);
  if (svc.id === "system") {
    speakSystemEnhanced(text, "en-US", rate);
    return;
  }
  try {
    const res = await synthesizeText(text, { voice: englishVoiceFor(svc), rate });
    if (id !== wordSession) return;
    const el = new Audio(res.url);
    wordAudio = el;
    await new Promise<void>((resolve, reject) => {
      el.onended = () => resolve();
      el.onerror = () => reject(new Error("play failed"));
      void el.play().catch(reject);
    });
  } catch {
    if (id === wordSession) speakSystemEnhanced(text, "en-US", rate);
  }
}
