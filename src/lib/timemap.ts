// Subtitle time ↔ the playing file's time, for episodes whose audio was re-cut or got other ads than the file the
// subtitles were made from (src-tauri/src/align.rs builds the map). Everything outside the player works in subtitle
// time; only the audio element's clock is in the playing file's time.
import { api, errorText } from "./api";
import { t } from "./i18n";
import { useStore } from "../store";

export interface Piece { refStart: number; refEnd: number; playStart: number }
export interface TimeMap { playBytes: number; method: "same" | "fingerprint" | "probe" | "manual"; pieces: Piece[] }
export type AlignStatus = "same" | "aligned" | "unknown" | "failed";
export interface Aligned { status: AlignStatus; map: TimeMap | null; path: string | null; localBytes: number }

/** Shortest stretch only the playing file has that counts as an ad break (shorter ones are matching slack). */
const MIN_GAP = 3;

const playEnd = (p: Piece) => p.playStart + (p.refEnd - p.refStart);

/** Where subtitle time `at` plays (mirrors TimeMap::to_play in align.rs). */
export function toPlay(m: TimeMap | null | undefined, at: number): number {
  const ps = m?.pieces;
  if (!ps?.length) return at;
  if (at < ps[0].refStart) return Math.max(0, at + ps[0].playStart - ps[0].refStart);
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (at < p.refEnd) return p.playStart + Math.max(0, at - p.refStart);
    // Only the subtitles' file has this (an old ad): carry on where the next shared stretch starts.
    if (i + 1 < ps.length && at < ps[i + 1].refStart) return ps[i + 1].playStart;
  }
  const last = ps[ps.length - 1];
  return at + last.playStart - last.refStart;
}

/** Subtitle time at playing time `at`. Inside something only the playing file has (an ad), the subtitles hold at
 *  the last line before it and `gapEnd` says where the shared speech resumes. */
export function toContent(m: TimeMap | null | undefined, at: number): { at: number; gapEnd?: number } {
  const ps = m?.pieces;
  if (!ps?.length) return { at };
  const first = ps[0];
  if (at < first.playStart) {
    const c = at - (first.playStart - first.refStart);
    return c >= 0 ? { at: c } : first.playStart - at >= MIN_GAP ? { at: 0, gapEnd: first.playStart - first.refStart } : { at: 0 };
  }
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (at < playEnd(p)) return { at: p.refStart + (at - p.playStart) };
    const next = ps[i + 1];
    if (next && at < next.playStart) return next.playStart - playEnd(p) >= MIN_GAP ? { at: p.refEnd, gapEnd: next.playStart } : { at: p.refEnd };
  }
  const last = ps[ps.length - 1];
  return { at: at - (last.playStart - last.refStart) };
}

/** The stretches only the playing file has (ads, most likely), in its own time. */
export function gaps(m: TimeMap | null | undefined): { start: number; end: number }[] {
  const ps = m?.pieces ?? [];
  const out: { start: number; end: number }[] = [];
  if (ps.length && ps[0].playStart - ps[0].refStart >= MIN_GAP) out.push({ start: 0, end: ps[0].playStart - ps[0].refStart });
  for (let i = 0; i + 1 < ps.length; i++) {
    const end = playEnd(ps[i]);
    if (ps[i + 1].playStart - end >= MIN_GAP) out.push({ start: end, end: ps[i + 1].playStart });
  }
  return out;
}

/** "This line is what I hear now": from subtitle time `ref` on, the subtitles follow playing time `play`. Later
 *  pieces move with it, so ad breaks found further on stay where they were relative to the speech. */
export function anchorAt(m: TimeMap | null | undefined, ref: number, play: number, playBytes: number): TimeMap {
  const ps: Piece[] = m?.pieces.length ? m.pieces.map((p) => ({ ...p })) : [{ refStart: 0, refEnd: 1e7, playStart: 0 }];
  const delta = play - toPlay({ playBytes, method: "manual", pieces: ps }, ref);
  const out: Piece[] = [];
  for (const p of ps) {
    if (p.refEnd <= ref) { out.push(p); continue; }
    if (p.refStart < ref) {
      out.push({ ...p, refEnd: ref });
      out.push({ refStart: ref, refEnd: p.refEnd, playStart: p.playStart + (ref - p.refStart) + delta });
    } else {
      out.push({ ...p, playStart: p.playStart + delta });
    }
  }
  // Moving later lines earlier can make the stretch before them overlap them in the playing file: cut it short.
  for (let i = 0; i + 1 < out.length; i++) {
    const over = playEnd(out[i]) - out[i + 1].playStart;
    if (over > 0) out[i].refEnd = Math.max(out[i].refStart, out[i].refEnd - over);
  }
  return { playBytes, method: "manual", pieces: out.filter((p) => p.refEnd > p.refStart) };
}

/** Lines the current episode up with the audio that will play. `force` also asks for a slower check. */
export async function alignCurrent(force = false) {
  const s = useStore.getState();
  const ep = s.current;
  if (!ep || ep.videoId || !ep.audioUrl) return;
  // Already on it: a second call would only report "busy" over the first one's progress.
  if (s.align?.id === ep.id && s.align.status === "working") return;
  const was = s.align?.id === ep.id ? s.align : null;
  s.set({ align: { id: ep.id, status: "working", map: was?.map ?? null, path: was?.path ?? null, localBytes: was?.localBytes ?? 0 } });
  try {
    // Subtitles that never said which file they fit are compared by listening, with the local speech model.
    const r = await api.alignAudio(ep.id, force, force ? s.settings.asrModel : undefined);
    if (useStore.getState().current?.id !== ep.id) return;
    useStore.getState().set({ align: { id: ep.id, ...r } });
    if (force && r.status === "aligned") useStore.getState().notify(t("字幕已按你听到的音频重新对齐"));
    else if (force && r.status === "same") useStore.getState().notify(t("字幕和你听到的音频是同一个版本，不用对齐"));
    else if (force && r.status !== "aligned") useStore.getState().notify(t("没能自动对齐，可以手动点一下正在听到的那句"));
  } catch (e) {
    if (useStore.getState().current?.id === ep.id) useStore.getState().set({ align: { id: ep.id, status: "failed", map: was?.map ?? null, path: was?.path ?? null, localBytes: was?.localBytes ?? 0 } });
    if (force) useStore.getState().notify(t("没能自动对齐：{error}", { error: errorText(e) }));
  }
}

/** Saves a map adjusted by hand and uses it right away. */
export async function setManualMap(map: TimeMap) {
  const s = useStore.getState();
  if (!s.current) return;
  const was = s.align?.id === s.current.id ? s.align : null;
  s.set({ align: { id: s.current.id, status: "aligned", map, path: was?.path ?? null, localBytes: was?.localBytes ?? 0 } });
  await api.saveTimeMap(s.current.id, map).catch(() => {});
}
