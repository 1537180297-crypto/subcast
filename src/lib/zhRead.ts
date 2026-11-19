// 朗读中文: reads the subtitles' Chinese translation aloud, line after line from where you are, with the active TTS
// engine. It doesn't follow the picture: the episode pauses while it reads, and pressing play stops the reading.
// The next two lines are fetched while one is read, so there's no gap between them.
import { useStore } from "../store";
import { stopSpeaking, synthesizeText } from "./tts";
import { create } from "zustand";
import { t } from "./i18n";

interface ZhRead { epId: string | null; index: number | null }
export const useZhRead = create<ZhRead>(() => ({ epId: null, index: null }));

let session = 0;
let audio: HTMLAudioElement | null = null;
let unsub: (() => void) | null = null;
const AHEAD = 2;

export function stopZhRead() {
  session++;
  audio?.pause();
  audio = null;
  unsub?.(); unsub = null;
  useZhRead.setState({ epId: null, index: null });
}

/** Reads `items` (the translation, one per subtitle line) from line `from` on. Errors (no key, …) go to `onError`. */
export async function startZhRead(epId: string, items: (string | null | undefined)[], from: number, onError: (m: string) => void) {
  stopZhRead();
  stopSpeaking();
  const id = ++session;
  const { player, playing } = useStore.getState();
  if (playing) player?.toggle();
  // Pressing play (space, the button) means listening to the episode again.
  unsub = useStore.subscribe((s, prev) => { if (s.playing && !prev.playing && id === session) stopZhRead(); });
  const lines: number[] = [];
  for (let i = Math.max(0, from); i < items.length; i++) if (items[i]?.trim()) lines.push(i);
  if (!lines.length) { stopZhRead(); onError(t("这里往后还没有中文翻译")); return; }
  const fetched = new Map<number, Promise<{ url: string; path: string; seconds: number }>>();
  const fetchLine = (k: number) => {
    if (k >= lines.length) return;
    if (!fetched.has(k)) {
      const p = synthesizeText(items[lines[k]]!.trim());
      p.catch(() => {}); // awaited (and reported) when its turn comes
      fetched.set(k, p);
    }
  };
  useZhRead.setState({ epId, index: lines[0] });
  try {
    for (let k = 0; k < lines.length; k++) {
      for (let a = 0; a <= AHEAD; a++) fetchLine(k + a);
      const res = await fetched.get(k)!;
      fetched.delete(k);
      if (id !== session) return;
      useZhRead.setState({ index: lines[k] });
      const el = new Audio(res.url);
      el.playbackRate = Math.min(2, Math.max(0.5, useStore.getState().settings.playbackRate || 1));
      audio = el;
      await new Promise<void>((resolve, reject) => { el.onended = () => resolve(); el.onerror = () => reject(new Error(t("音频播放失败"))); void el.play().catch(reject); });
      if (id !== session) return;
    }
  } catch (e) {
    if (id === session) onError(String((e as any)?.message ?? e));
  } finally {
    if (id === session) stopZhRead();
  }
}
