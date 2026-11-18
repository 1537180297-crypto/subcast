// The word book: words saved from subtitles, each with the sentence it came from, scheduled for review with FSRS
// (ts-fsrs, MIT). Kept as one JSON blob in the local database, so it needs no backend of its own.
import { create } from "zustand";
import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from "ts-fsrs";
import { api } from "./api";

export interface SavedCard { due: number; stability: number; difficulty: number; scheduled_days: number; learning_steps: number; reps: number; lapses: number; state: State; last_review?: number }

export interface Word {
  /** The headword, lowercase. */
  id: string;
  /** As it appeared in the sentence. */
  word: string;
  ipa: string;
  meaning: string;
  /** What it means in this sentence (from the model), when asked. */
  ctx?: string;
  /** The easiest exam list it is on (tagLabel). */
  tag: string;
  sentence: string;
  sentenceZh?: string;
  episodeId: string;
  episodeTitle: string;
  showTitle?: string;
  start: number;
  end: number;
  added: number;
  card: SavedCard;
}

/** One day's reviews: how many answers, how many of them 忘了, and which words. */
export interface DayLog { r: number; a: number; ids: string[] }
interface Book { v: 1; words: Record<string, Word>; day: string; newToday: number; log?: Record<string, DayLog> }

const BLOB = ["learn", "words"] as const;
const scheduler = fsrs({ enable_fuzz: true });
/** Reviewed at an interval this long or longer: counted as mastered. */
const MASTERED_DAYS = 21;

const toSaved = (c: Card): SavedCard => ({ due: +c.due, stability: c.stability, difficulty: c.difficulty, scheduled_days: c.scheduled_days, learning_steps: c.learning_steps, reps: c.reps, lapses: c.lapses, state: c.state, last_review: c.last_review ? +c.last_review : undefined });
const toCard = (s: SavedCard): Card => ({ ...s, due: new Date(s.due), last_review: s.last_review ? new Date(s.last_review) : undefined });
const today = () => new Date().toLocaleDateString("sv");
export const dayOf = (ms: number) => new Date(ms).toLocaleDateString("sv");

interface WordsState extends Book {
  log: Record<string, DayLog>;
  loaded: boolean;
  load(): Promise<void>;
  add(w: Omit<Word, "added" | "card">): void;
  update(id: string, patch: Partial<Word>): void;
  remove(id: string): void;
  rate(id: string, grade: Grade): void;
}

let saveTimer: number | undefined;
function persist() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void api.setBlob(BLOB[0], BLOB[1], snapshot()).catch(() => {});
  }, 300);
}
const snapshot = () => { const { v, words, day, newToday, log } = useWords.getState(); return JSON.stringify({ v, words, day, newToday, log }); };
window.addEventListener("beforeunload", () => { if (saveTimer) { window.clearTimeout(saveTimer); void api.setBlob(BLOB[0], BLOB[1], snapshot()); } });

/** Books from before the review log: each word's last review is the best record there is of the days studied. */
function backfill(words: Record<string, Word>): Record<string, DayLog> {
  const log: Record<string, DayLog> = {};
  for (const w of Object.values(words)) {
    if (!w.card.last_review) continue;
    const d = (log[dayOf(w.card.last_review)] ??= { r: 0, a: 0, ids: [] });
    d.r++; d.ids.push(w.id);
  }
  return log;
}

export const useWords = create<WordsState>((set, get) => ({
  v: 1, words: {}, day: today(), newToday: 0, log: {}, loaded: false,
  async load() {
    if (get().loaded) return;
    try {
      const raw = await api.getBlob(BLOB[0], BLOB[1]);
      const b = raw ? (JSON.parse(raw) as Book) : null;
      const words = b?.words ?? {};
      set({ loaded: true, words, day: b?.day ?? today(), newToday: b?.newToday ?? 0, log: b?.log ?? backfill(words) });
    } catch { set({ loaded: true }); }
  },
  add(w) {
    if (get().words[w.id]) return;
    set((s) => ({ words: { ...s.words, [w.id]: { ...w, added: Date.now(), card: toSaved(createEmptyCard(new Date())) } } }));
    persist();
  },
  update(id, patch) {
    const w = get().words[id];
    if (!w) return;
    set((s) => ({ words: { ...s.words, [id]: { ...w, ...patch } } }));
    persist();
  },
  remove(id) {
    const { [id]: _, ...rest } = get().words;
    set({ words: rest });
    persist();
  },
  rate(id, grade) {
    const w = get().words[id];
    if (!w) return;
    const wasNew = w.card.state === State.New;
    let next: Card;
    // A card the scheduler rejects (damaged data) starts over rather than breaking the review.
    try { next = scheduler.next(toCard(w.card), new Date(), grade).card; }
    catch { next = scheduler.next(createEmptyCard(new Date()), new Date(), grade).card; }
    const d = today();
    set((s) => {
      const was = s.log[d] ?? { r: 0, a: 0, ids: [] };
      const entry = { r: was.r + 1, a: was.a + (grade === Rating.Again ? 1 : 0), ids: was.ids.includes(id) ? was.ids : [...was.ids, id] };
      return {
        words: { ...s.words, [id]: { ...w, card: toSaved(next) } },
        day: d,
        newToday: (s.day === d ? s.newToday : 0) + (wasNew ? 1 : 0),
        log: { ...s.log, [d]: entry },
      };
    });
    persist();
  },
}));

export const isMastered = (w: Word) => w.card.state === State.Review && w.card.scheduled_days >= MASTERED_DAYS;
export const isDue = (w: Word, now = Date.now()) => w.card.state !== State.New && w.card.due <= now;

/** Today's review: words due now, then new ones up to the daily limit (oldest saved first). */
export function reviewQueue(book: Pick<Book, "words" | "day" | "newToday">, dailyNew: number, now = Date.now()): Word[] {
  const all = Object.values(book.words);
  const due = all.filter((w) => isDue(w, now)).sort((a, b) => a.card.due - b.card.due);
  const left = Math.max(0, dailyNew - (book.day === today() ? book.newToday : 0));
  const fresh = all.filter((w) => w.card.state === State.New).sort((a, b) => a.added - b.added).slice(0, left);
  return [...due, ...fresh];
}

/** How long until each answer would bring the card back, for the rating buttons. */
export function intervals(w: Word): Record<Grade, number> {
  let p;
  try { p = scheduler.repeat(toCard(w.card), new Date()); } catch { p = scheduler.repeat(createEmptyCard(new Date()), new Date()); }
  const now = Date.now();
  return { [Rating.Again]: +p[Rating.Again].card.due - now, [Rating.Hard]: +p[Rating.Hard].card.due - now, [Rating.Good]: +p[Rating.Good].card.due - now, [Rating.Easy]: +p[Rating.Easy].card.due - now } as Record<Grade, number>;
}

export { Rating, type Grade };

const at = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export function toCsv(words: Word[], header: string[]): string {
  const rows = words.map((w) => [w.word, w.ipa, w.meaning.replace(/\n/g, " "), w.ctx ?? "", w.sentence, w.sentenceZh ?? "", w.showTitle ?? "", w.episodeTitle, at(w.start), new Date(w.added).toLocaleDateString("sv")]);
  return "﻿" + [header, ...rows].map((r) => r.map((c) => csvCell(String(c))).join(",")).join("\n") + "\n";
}
