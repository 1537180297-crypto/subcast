// Subtitles saved as files with their timestamps: SRT, WebVTT, ASS (two styles for the two languages), LRC,
// plain text and Markdown. Long blocks are cut into sentence-sized cues the way the video overlay shows them.
import type { Episode, Segment } from "./api";
import { pieces } from "./pieces";
import { toPlay, type TimeMap } from "./timemap";

export type SubFormat = "srt" | "vtt" | "ass" | "lrc" | "txt" | "md";
export type SubContent = "bilingual" | "original" | "translation";

export const FORMATS: { id: SubFormat; name: string; ext: string }[] = [
  { id: "srt", name: "SRT", ext: "srt" },
  { id: "vtt", name: "WebVTT", ext: "vtt" },
  { id: "ass", name: "ASS", ext: "ass" },
  { id: "lrc", name: "LRC", ext: "lrc" },
  { id: "txt", name: "TXT", ext: "txt" },
  { id: "md", name: "Markdown", ext: "md" },
];

export interface Cue { start: number; end: number; orig: string; zh?: string }

const hasCjk = (s: string) => /[一-鿿]/.test(s);
/** Shorter pieces join the next one: a cue that flashes by can't be read. */
const MIN_CUE = 1;

/** Pieces of a block with times spread over it by length (as the overlay assumes speech is spread evenly). */
function spread(text: string, cjk: boolean, start: number, end: number): { start: number; end: number; text: string }[] {
  const ps = pieces(text, cjk);
  const total = ps.reduce((n, p) => n + p.length, 0) || 1;
  const out: { start: number; end: number; text: string }[] = [];
  let acc = 0;
  for (const p of ps) {
    const s = start + (end - start) * (acc / total);
    acc += p.length;
    const e = start + (end - start) * (acc / total);
    const last = out[out.length - 1];
    if (last && last.end - last.start < MIN_CUE) { last.end = e; last.text += (cjk ? "" : " ") + p; }
    else out.push({ start: s, end: e, text: p });
  }
  const last = out[out.length - 1];
  if (out.length > 1 && last.end - last.start < MIN_CUE) { const prev = out[out.length - 2]; prev.end = last.end; prev.text += (cjk ? "" : " ") + last.text; out.pop(); }
  return out;
}

/** Sentence-sized cues. Bilingual cues follow the original's sentences, each with the translation pieces that
 *  fall in it (or, when none starts there, the one being shown at that moment). */
export function buildCues(segments: Segment[], zh: (string | null | undefined)[] | undefined, content: SubContent): Cue[] {
  const out: Cue[] = [];
  segments.forEach((seg, i) => {
    const tr = zh?.[i]?.trim() || undefined;
    if (content === "translation" && tr) {
      for (const p of spread(tr, true, seg.start, seg.end)) out.push({ start: p.start, end: p.end, orig: "", zh: p.text });
      return;
    }
    const os = spread(seg.text, hasCjk(seg.text), seg.start, seg.end);
    const zs = content === "bilingual" && tr ? spread(tr, true, seg.start, seg.end) : [];
    for (const o of os) {
      const inside = zs.filter((z) => { const m = (z.start + z.end) / 2; return m >= o.start && m < o.end; });
      const mid = (o.start + o.end) / 2;
      const shown = inside.length ? inside : zs.filter((z) => z.start <= mid && mid < z.end).slice(0, 1);
      out.push({ start: o.start, end: o.end, orig: o.text, zh: shown.length ? shown.map((z) => z.text).join("") : undefined });
    }
  });
  return out;
}

/** Moves cues onto the playing file's clock (ads in it become gaps), keeping them in order and apart. */
export function onClock(cues: Cue[], map: TimeMap | null | undefined): Cue[] {
  const out = cues.map((c) => {
    const start = toPlay(map, c.start), end = toPlay(map, c.end);
    // A line an ad break cuts through stays up for its own length, not through the ad.
    return { ...c, start, end: Math.max(start + 0.2, end - start > c.end - c.start + 1 ? start + (c.end - c.start) : end) };
  });
  for (let i = 0; i + 1 < out.length; i++) if (out[i].end > out[i + 1].start) out[i].end = Math.max(out[i].start + 0.1, out[i + 1].start);
  return out;
}

function stamp(t: number, sep: "," | ".", hours = true): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, f = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${hours ? `${p(h)}:` : ""}${p(m)}:${p(s)}${sep}${p(f, 3)}`;
}
/** 1:02:03 or 02:03, for reading. */
function clockOf(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`;
}

/** The lines of a cue, translation first (as on screen). */
const linesOf = (c: Cue) => [c.zh, c.orig].filter((x): x is string => !!x);

function assText(s: string) { return s.replace(/[{}]/g, "").replace(/\r?\n/g, "\\N"); }

function assTime(t: number) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60, f = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(2, "0")}`;
}

export interface ExportMeta { title: string; show?: string; url?: string }

/** Sentence cues as subtitle files; TXT and Markdown keep whole blocks (paragraphs read better than fragments). */
export function render(format: SubFormat, cues: Cue[], blocks: Cue[], meta: ExportMeta): string {
  switch (format) {
    case "srt":
      return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${linesOf(c).join("\n")}\n`).join("\n");
    case "vtt":
      return `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${linesOf(c).map((l) => l.replace(/-->/g, "→")).join("\n")}\n`).join("\n")}`;
    case "ass": {
      const head = [
        "[Script Info]", `Title: ${assText(meta.title)}`, "ScriptType: v4.00+", "PlayResX: 1920", "PlayResY: 1080", "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Default,PingFang SC,60,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,2,80,80,60,1",
        "Style: Original,Arial,42,&H00E6E6E6,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2.5,1,2,80,80,60,1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      ];
      const ev = cues.map((c) => {
        const text = c.zh && c.orig ? `${assText(c.zh)}\\N{\\rOriginal}${assText(c.orig)}` : assText(c.zh ?? c.orig);
        return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},${c.zh ? "Default" : "Original"},,0,0,0,,${text}`;
      });
      return `${[...head, ...ev].join("\n")}\n`;
    }
    case "lrc": {
      const head = [`[ti:${meta.title}]`, ...(meta.show ? [`[ar:${meta.show}]`] : []), "[by:SubCast]"];
      const t = (x: number) => { const cs = Math.max(0, Math.round(x * 100)); return `[${String(Math.floor(cs / 6000)).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}]`; };
      // Players that know bilingual LRC show lines sharing a time stamp together.
      return `${[...head, ...cues.flatMap((c) => linesOf(c).map((l) => `${t(c.start)}${l}`))].join("\n")}\n`;
    }
    case "txt":
      return `${blocks.map((b) => `[${clockOf(b.start)}] ${[b.orig, b.zh].filter(Boolean).join("\n")}`).join("\n\n")}\n`;
    case "md": {
      const head = [`# ${meta.title}`, "", ...(meta.show || meta.url ? [[meta.show, meta.url].filter(Boolean).join(" · "), ""] : [])];
      const body = blocks.map((b) => `**${clockOf(b.start)}** ${[b.orig, b.zh].filter(Boolean).join("  \n")}`);
      return `${[...head, ...body.flatMap((x) => [x, ""])].join("\n")}`;
    }
  }
}

/** Whole blocks (one per subtitle line in SubCast) for TXT and Markdown. */
export function buildBlocks(segments: Segment[], zh: (string | null | undefined)[] | undefined, content: SubContent): Cue[] {
  return segments.map((s, i) => {
    const tr = zh?.[i]?.trim() || undefined;
    if (content === "original" || !tr) return { start: s.start, end: s.end, orig: s.text };
    if (content === "translation") return { start: s.start, end: s.end, orig: "", zh: tr };
    return { start: s.start, end: s.end, orig: s.text, zh: tr };
  });
}

/** A file name from the episode title, safe on every system. */
export function fileName(ep: Pick<Episode, "title">, ext: string): string {
  const base = ep.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "subtitles";
  return `${base}.${ext}`;
}
