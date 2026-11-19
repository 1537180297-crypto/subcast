// The offline English–Chinese dictionary behind the learning mode: ECDICT (MIT, by Linwei), trimmed by
// scripts/build-dict.py into public/dict/en.json (~4.6 MB, fetched once, only when the learning mode is on).
import { create } from "zustand";
import { tk } from "./i18n";
import type { LearnLevel } from "./settings";

/** [phonetic, meaning, tag bits, frequency rank (0 = unknown)] */
type Raw = [string, string, number, number];
interface Data { v: number; tags: string[]; words: Record<string, Raw>; forms: Record<string, string> }

export interface Entry { lemma: string; ipa: string; meaning: string; tags: number; rank: number }

const TAGS = ["zk", "gk", "cet4", "cet6", "ky", "toefl", "ielts", "gre"] as const;
const bit = (t: (typeof TAGS)[number]) => 1 << TAGS.indexOf(t);

/** What each level is assumed to know: its own list and every list below it. */
const KNOWN: Record<LearnLevel, number> = {
  cet4: bit("zk") | bit("gk") | bit("cet4"),
  cet6: bit("zk") | bit("gk") | bit("cet4") | bit("cet6"),
  ky: bit("zk") | bit("gk") | bit("cet4") | bit("cet6") | bit("ky"),
  ielts: bit("zk") | bit("gk") | bit("cet4") | bit("cet6") | bit("ky") | bit("toefl") | bit("ielts"),
};
/** Words this common are taken as known at each level, whatever lists they are on. */
const KNOWN_RANK: Record<LearnLevel, number> = { cet4: 3000, cet6: 5000, ky: 6000, ielts: 8000 };
/** Untagged words count as new past this frequency rank, up to UNTAGGED_TO (ranks beyond it are unreliable). */
const UNTAGGED_FROM: Record<LearnLevel, number> = { cet4: 6000, cet6: 9000, ky: 10000, ielts: 14000 };
const UNTAGGED_TO = 20000;

export const LEVELS: [LearnLevel, string][] = [["cet4", tk("四级")], ["cet6", tk("六级")], ["ky", tk("考研")], ["ielts", tk("雅思")]];

const LABELS: [number, string][] = [
  [bit("zk"), tk("中考")], [bit("gk"), tk("高考")], [bit("cet4"), tk("四级")], [bit("cet6"), tk("六级")],
  [bit("ky"), tk("考研")], [bit("toefl"), tk("托福")], [bit("ielts"), tk("雅思")], [bit("gre"), "GRE"],
];
/** The easiest list a word is on (中考 … GRE), or "" when it is on none. Untranslated: pass through t(). */
export function tagLabel(tags: number): string {
  for (const [b, label] of LABELS) if (tags & b) return label;
  return "";
}

interface DictState { data: Data | null; loading: boolean; failed: boolean }
export const useDict = create<DictState>(() => ({ data: null, loading: false, failed: false }));

let pending: Promise<Data | null> | null = null;
/** Fetches the dictionary once; later calls share the same promise. */
export function loadDict(): Promise<Data | null> {
  const s = useDict.getState();
  if (s.data) return Promise.resolve(s.data);
  if (pending) return pending;
  useDict.setState({ loading: true, failed: false });
  pending = fetch("/dict/en.json")
    .then((r) => (r.ok ? (r.json() as Promise<Data>) : Promise.reject(new Error(String(r.status)))))
    .then((data) => { useDict.setState({ data, loading: false }); return data; })
    .catch(() => { pending = null; useDict.setState({ loading: false, failed: true }); return null; });
  return pending;
}

/** The headword for a token as written: lowercase, curly quotes and possessives dropped, inflections folded. */
export function lemmaOf(data: Data, token: string): string | null {
  let w = token.toLowerCase().replace(/[’‘]/g, "'").replace(/^'+|'+$/g, "");
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if (data.words[w]) return w;
  const f = data.forms[w];
  if (f && data.words[f]) return f;
  return null;
}

export function lookup(data: Data, token: string): Entry | null {
  const lemma = lemmaOf(data, token);
  if (!lemma) return null;
  const [ipa, meaning, tags, rank] = data.words[lemma];
  return { lemma, ipa, meaning, tags, rank };
}

/** Whether a word is above the listener's level, so worth marking. */
export function isNew(e: Entry, level: LearnLevel): boolean {
  if (e.rank > 0 && e.rank <= KNOWN_RANK[level]) return false;
  if (e.tags) return (e.tags & KNOWN[level]) === 0;
  return e.rank > UNTAGGED_FROM[level] && e.rank <= UNTAGGED_TO;
}

/** Word tokens in a line of English, with their offsets, for marking and clicking. */
export const WORD_RE = /[A-Za-z][A-Za-z'’-]*[A-Za-z]|[A-Za-z]/g;

/** Whether a transcript is English: by its language code, or by its text when the code says nothing (missing,
 *  or "auto", which cloud and RSS transcripts store when no language was chosen). */
export function looksEnglish(language: string | undefined, sample: string): boolean {
  if (language && !/^(auto|und|mul)$/i.test(language)) return /^en\b|^en-|^en$/i.test(language);
  const letters = sample.replace(/[^A-Za-z一-鿿]/g, "");
  return letters.length > 0 && (letters.match(/[A-Za-z]/g)?.length ?? 0) / letters.length > 0.8;
}
