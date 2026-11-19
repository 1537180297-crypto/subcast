// Subtitle lines for exported clips: short, one idea per line, the way short-video subtitles read.
// A deterministic splitter always works; DeepSeek (or the chat model) can add the punctuation that YouTube's
// automatic captions lack, which gives much better breaks. Its answer is only used where it kept every character.
import { llmChat, type Segment } from "./api";
import { llmReady } from "./jobs";
import { pieces } from "./pieces";
import { providerFor, useStore } from "../store";

const CJK = /[㐀-鿿豈-﫿]/;
export const isCjk = (s: string) => CJK.test(s);
/** Line punctuation a subtitle doesn't show at its end (it reads as a pause on its own). */
const TRAILING = /[，。、；：,.;:\s]+$/u;
const BREAK_AFTER = /[，。、；：！？,.;:!?…]/u;

/** Splits text into subtitle lines of at most `max` characters (CJK) or `max * 2.3` characters (Latin). */
export function shortLines(text: string, max: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const cjk = isCjk(clean);
  const limit = cjk ? max : Math.round(max * 2.3);
  const out: string[] = [];
  for (const p of pieces(clean, cjk)) {
    if (p.length <= limit) { out.push(p); continue; }
    out.push(...(cjk ? splitCjk(p, limit) : splitWords(p, limit)));
  }
  return out.map((l) => l.replace(TRAILING, "").trim()).filter(Boolean);
}

/** Near-equal parts, each cut moved to a punctuation mark when one is within three characters. */
function splitCjk(text: string, limit: number): string[] {
  const chars = [...text];
  const parts = Math.ceil(chars.length / limit);
  const size = chars.length / parts;
  const out: string[] = [];
  let from = 0;
  for (let k = 1; k < parts; k++) {
    let cut = Math.round(size * k);
    for (let d = 0; d <= 3; d++) {
      if (cut - d > from && BREAK_AFTER.test(chars[cut - d - 1])) { cut -= d; break; }
      if (cut + d < chars.length && cut + d - from <= limit && BREAK_AFTER.test(chars[cut + d - 1])) { cut += d; break; }
    }
    cut = Math.min(Math.max(cut, from + 1), from + limit);
    out.push(chars.slice(from, cut).join(""));
    from = cut;
  }
  out.push(chars.slice(from).join(""));
  return out;
}

function splitWords(text: string, limit: number): string[] {
  const words = text.split(" ");
  const parts = Math.ceil(text.length / limit);
  const target = text.length / parts;
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && (line.length + 1 + w.length > limit || (line.length >= target && out.length < parts - 1))) { out.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

/** Splits `text` into `n` parts of similar length, preferring punctuation (for the second language of a cue). */
export function splitInto(text: string, n: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (n <= 1 || !clean) return [clean];
  const cjk = isCjk(clean);
  const units = cjk ? [...clean] : clean.split(" ");
  if (units.length <= n) return units.concat(Array(n - units.length).fill(""));
  const out: string[] = [];
  let from = 0;
  for (let k = 1; k < n; k++) {
    let cut = Math.round((units.length / n) * k);
    for (let d = 0; d <= 2 && cjk; d++) {
      if (cut - d > from && BREAK_AFTER.test(units[cut - d - 1])) { cut -= d; break; }
    }
    cut = Math.max(cut, from + 1);
    out.push(units.slice(from, cut).join(cjk ? "" : " "));
    from = cut;
  }
  out.push(units.slice(from).join(cjk ? "" : " "));
  return out.map((l) => l.replace(TRAILING, "").trim());
}

const bare = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "");
/** The same characters, ignoring punctuation and spaces (model lines still match the current text). */
export const sameChars = (lines: string[], text: string) => bare(lines.join("")) === bare(text);

/** Model-made line breaks per segment index, kept only where the lines hold exactly the original characters. */
export async function aiLineBreaks(texts: { i: number; text: string }[], max: number, signal?: AbortSignal): Promise<Record<number, string[]>> {
  const items = texts.filter((x) => isCjk(x.text) && x.text.trim());
  if (!items.length) return {};
  if (!(await llmReady("chat"))) return {};
  const provider = providerFor(useStore.getState().settings, "chat");
  if (!provider?.model) return {};
  // i18n-ignore-start (prompt sent to the model)
  const system = `你是短视频字幕编辑。把每条口语字幕加上标点，再切成适合竖屏阅读的短句。
规则：
1. 每个短句不超过 ${max} 个字，按意群断开（主谓、动宾、量词短语不要拆开），不要在助词「的、了、着、吗、呢」前断开。
2. 只能添加标点，绝对不能增加、删除、改写、调换任何一个字。
3. 输入是 JSON 数组 [{"i":行号,"text":"字幕"}]。只返回 JSON：{"lines":[{"i":行号,"parts":["短句1","短句2"]}]}，每条输入都要有对应输出。`;
  // i18n-ignore-end
  const raw = await llmChat({
    provider,
    system,
    messages: [{ role: "user", content: JSON.stringify(items) }],
    maxTokens: 4000,
    jsonMode: provider.protocol === "openai",
    quick: true,
    signal,
  });
  const clean = raw.replace(/^```(?:json)?\s*|\s*```$/gm, "").trim();
  const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
  if (a < 0 || b < a) return {};
  let parsed: { lines?: { i?: unknown; parts?: unknown }[] };
  try { parsed = JSON.parse(clean.slice(a, b + 1)); } catch { return {}; }
  const byIdx = new Map(items.map((x) => [x.i, x.text]));
  const out: Record<number, string[]> = {};
  for (const l of parsed.lines ?? []) {
    const i = Number(l.i);
    const src = byIdx.get(i);
    if (src == null || !Array.isArray(l.parts)) continue;
    const parts = l.parts.map((p) => String(p));
    if (bare(parts.join("")) !== bare(src)) continue;
    // Still too long somewhere: the deterministic splitter finishes the job on that line.
    out[i] = parts.flatMap((p) => shortLines(p, max));
  }
  return out;
}

/** The texts (by segment index) whose lines the model should break: the CJK text that drives each cue. */
export function textsToBreak(segments: Segment[], zh: (string | null | undefined)[], startIdx: number, endIdx: number, content: "bilingual" | "original" | "translation"): { i: number; text: string }[] {
  const out: { i: number; text: string }[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const orig = segments[i]?.text ?? "";
    const tr = zh[i]?.trim() ?? "";
    const text = content === "original" ? orig : isCjk(orig) ? orig : tr;
    if (text && isCjk(text)) out.push({ i, text });
  }
  return out;
}
