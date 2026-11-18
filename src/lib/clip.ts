// Plays one sentence of an episode in the speaker's own voice: through the main player when that episode is
// loaded, otherwise from a small local clip (learn_clip in the app cuts just that sentence out of the episode,
// once), so replaying a saved word is instant and the episode you are listening to is left alone.
import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";
import { api } from "./api";
import { useStore } from "../store";

/** The sentence being played (its key) and whether its clip is still being cut, for the button that asked:
 *  a spinner while loading, pause while playing. */
export const useClipState = create<{ key: string | null; loading: boolean }>(() => ({ key: null, loading: false }));
export const clipKey = (episodeId: string, start: number, end: number) => `${episodeId}|${start.toFixed(2)}|${end.toFixed(2)}`;

let el: HTMLAudioElement | null = null;
let unwatch: (() => void) | null = null;
/** Bumped by every play and stop, so a clip that arrives late doesn't start over something newer. */
let turn = 0;

const made = new Map<string, Promise<string | null>>();
/** The local clip for a sentence, made once (null when it can't be made; asked again next time). */
export function prepareClip(episodeId: string, start: number, end: number): Promise<string | null> {
  const key = clipKey(episodeId, start, end);
  let p = made.get(key);
  if (!p) {
    p = api.learnClip(episodeId, start, end).catch(() => { made.delete(key); return null; });
    made.set(key, p);
  }
  return p;
}

// Clips for words just saved and cards coming up in review are made in the background, two at a time.
const waiting: [string, number, number][] = [];
let running = 0;
export function prefetchClip(episodeId: string, start: number, end: number) {
  if (made.has(clipKey(episodeId, start, end))) return;
  waiting.push([episodeId, start, end]);
  pump();
}
function pump() {
  while (running < 2 && waiting.length) {
    const [id, s, e] = waiting.shift()!;
    running++;
    void prepareClip(id, s, e).finally(() => { running--; pump(); });
  }
}

export function stopClip() {
  turn++;
  // A sentence playing in the main player is paused there too.
  if (unwatch) { unwatch(); unwatch = null; const s = useStore.getState(); if (s.playing) s.player?.toggle(); }
  if (el) el.pause();
  useClipState.setState({ key: null, loading: false });
}

/** Plays the sentence, or stops it when it is the one playing. */
export async function toggleClip(ep: { id: string }, start: number, end: number): Promise<boolean> {
  if (useClipState.getState().key === clipKey(ep.id, start, end)) { stopClip(); return true; }
  return playClip(ep, start, end);
}

/** Plays [start, end] of an episode. Resolves false when there is no way to play it (the caller can read the text aloud). */
export async function playClip(ep: { id: string }, start: number, end: number): Promise<boolean> {
  stopClip();
  const mine = turn;
  const s = useStore.getState();
  const pad = 0.15;
  const key = clipKey(ep.id, start, end);
  const done = () => { if (mine === turn) useClipState.setState({ key: null, loading: false }); };
  if (s.current?.id === ep.id && s.player) {
    const player = s.player;
    player.seek(Math.max(0, start - pad));
    player.play();
    useClipState.setState({ key, loading: false });
    const startedAt = Date.now();
    // Pause once playback passes the end of the sentence (time updates a few times a second); stop watching when
    // the listener pauses it themselves (not the brief stall while seeking).
    unwatch = useStore.subscribe((st, prev) => {
      const over = st.time >= end + pad || Date.now() - startedAt > (end - start + 8) * 1000;
      if (over || (prev.playing && !st.playing && Date.now() - startedAt > 1500) || st.current?.id !== ep.id) {
        unwatch?.(); unwatch = null;
        if (over && st.playing) st.player?.toggle();
        done();
      }
    });
    return true;
  }
  useClipState.setState({ key, loading: true });
  const path = await prepareClip(ep.id, start, end);
  if (mine !== turn) return true;
  if (!path) { done(); return false; }
  if (!el) el = new Audio();
  const a = el;
  // (A pause event from stopping the previous sentence can arrive after this one has started: not paused then.)
  a.onended = a.onpause = () => { if (a.paused) done(); };
  el.src = convertFileSrc(path);
  el.currentTime = 0;
  useClipState.setState({ key, loading: false });
  try { await el.play(); } catch { done(); return false; }
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
