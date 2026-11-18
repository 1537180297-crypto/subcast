// Plays one sentence of an episode in the speaker's own voice: through the main player when that episode is
// loaded, otherwise through a separate audio element, so the episode you are listening to is left alone.
import { api, type Episode } from "./api";
import { useStore } from "../store";

let el: HTMLAudioElement | null = null;
let stopTimer: number | undefined;
let unwatch: (() => void) | null = null;
/** Stream addresses for episodes that are not in the main player, by episode id. */
const sources = new Map<string, string>();

export function stopClip() {
  window.clearTimeout(stopTimer);
  unwatch?.(); unwatch = null;
  if (el) { el.pause(); }
}

async function sourceFor(ep: Pick<Episode, "id" | "audioUrl" | "videoId">): Promise<string | null> {
  if (ep.audioUrl) return ep.audioUrl;
  const known = sources.get(ep.id);
  if (known) return known;
  if (!ep.videoId) return null;
  try { const s = await api.youtubeStream(ep.videoId, "mp4"); sources.set(ep.id, s.url); return s.url; } catch { return null; }
}

/** Plays [start, end] of an episode. Resolves false when there is no way to play it (the caller can read the text aloud). */
export async function playClip(ep: Pick<Episode, "id" | "audioUrl" | "videoId">, start: number, end: number): Promise<boolean> {
  stopClip();
  const s = useStore.getState();
  const pad = 0.15;
  if (s.current?.id === ep.id && s.player) {
    const player = s.player;
    player.seek(Math.max(0, start - pad));
    player.play();
    const startedAt = Date.now();
    // Pause once playback passes the end of the sentence (time updates a few times a second).
    unwatch = useStore.subscribe((st) => {
      if (st.time >= end + pad || Date.now() - startedAt > (end - start + 8) * 1000) {
        unwatch?.(); unwatch = null;
        if (st.playing) st.player?.toggle();
      }
    });
    return true;
  }
  const src = await sourceFor(ep);
  if (!src) return false;
  if (!el) { el = new Audio(); el.preload = "auto"; }
  if (el.src !== src) el.src = src;
  const a = el;
  const go = () => {
    a.currentTime = Math.max(0, start - pad);
    void a.play().catch(() => {});
    stopTimer = window.setTimeout(() => a.pause(), (end - start + pad * 2) * 1000);
  };
  if (a.readyState >= 1) go(); else a.addEventListener("loadedmetadata", go, { once: true });
  return true;
}

/** Reads English text aloud with the system voice (a word, or a sentence when there is no audio). */
export function speak(text: string, rate = 0.9) {
  const synth = window.speechSynthesis;
  if (!synth) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = rate;
  const voice = synth.getVoices().find((v) => v.lang === "en-US" && /Samantha|Alex|Ava|Allison/.test(v.name)) ?? synth.getVoices().find((v) => v.lang.startsWith("en"));
  if (voice) u.voice = voice;
  synth.speak(u);
}
