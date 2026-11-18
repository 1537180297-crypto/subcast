// English learning mode: marked words and the word card in English subtitles, the word book with spaced review,
// this episode's words, shadowing and dictation. Everything here is off until 设置 › 学英语 turns it on.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { BookMarked, Check, Download, GraduationCap, Loader2, Play, Plus, Trash2, Volume2, X } from "lucide-react";
import { api, errorText, llmChat, type AnkiNote, type Episode, type Segment } from "../lib/api";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { WORD_RE, isNew, loadDict, lookup, tagLabel, useDict, type Entry } from "../lib/dict";
import { clipKey, playClip, prefetchClip, prepareClip, speak, stopClip, useClipLoading } from "../lib/clip";
import { Rating, intervals, isMastered, reviewQueue, toCsv, useWords, type Grade, type Word } from "../lib/words";
import { llmReady } from "../lib/jobs";
import { providerFor, useStore } from "../store";
import { clock } from "../lib/format";
import { t, tk, useLang } from "../lib/i18n";
import { Modal } from "./Chrome";
import { EmptyState } from "./Illustrations";
import type { LearnLevel } from "../lib/settings";

// ---- shared ----------------------------------------------------------------------------------------------

/** The learning mode is on, and the dictionary and word book are loading or loaded. */
export function useLearnOn(): boolean {
  const on = useStore((s) => s.settings.learnOn);
  useEffect(() => { if (on) { void loadDict(); void useWords.getState().load(); } }, [on]);
  return on;
}

const fmtWait = (ms: number) => {
  const m = ms / 60_000;
  if (m < 60) return t("{n} 分钟", { n: Math.max(1, Math.round(m)) });
  const h = m / 60;
  if (h < 24) return t("{n} 小时", { n: Math.round(h) });
  const d = h / 24;
  if (d < 31) return t("{n} 天", { n: Math.round(d) });
  return t("{n} 个月", { n: Math.round(d / 30) });
};

const dueLabel = (w: Word, now: number) => {
  if (w.card.state === 0) return { text: t("新词"), now: false };
  if (w.card.due <= now) return { text: t("今天"), now: true };
  return { text: t("{wait}后", { wait: fmtWait(w.card.due - now) }), now: false };
};

// ---- subtitles: marked words -----------------------------------------------------------------------------

export interface LearnMarks { data: NonNullable<ReturnType<typeof useDict.getState>["data"]>; level: LearnLevel; mark: boolean; saved: Record<string, Word> }

/** The marks for English subtitle lines, or null when the learning mode does not apply. Stable between renders. */
export function useLearnMarks(english: boolean): LearnMarks | null {
  const on = useLearnOn();
  const { level, mark, card } = useStore(useShallow((s) => ({ level: s.settings.learnLevel, mark: s.settings.learnMark, card: s.settings.learnCard })));
  const data = useDict((s) => s.data);
  const saved = useWords((s) => s.words);
  return useMemo(() => (on && english && data && (mark || card) ? { data, level, mark, saved } : null), [on, english, data, level, mark, card, saved]);
}

/** One English line with its words wrapped, so they can be marked and clicked. */
export const LearnText = memo(function LearnText({ text, marks }: { text: string; marks: LearnMarks }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(WORD_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const e = lookup(marks.data, m[0]);
    // Capitalised mid-sentence, or at the start but on no exam list: most likely a name (Chang, Jensen).
    const proper = /^[A-Z]/.test(m[0]) && ((i > 0 && !/[.?!]["”]?\s*$/.test(text.slice(0, i))) || !e?.tags);
    const cls = e && marks.saved[e.lemma] ? " saved" : e && marks.mark && !proper && isNew(e, marks.level) ? " new" : "";
    out.push(<span key={i} className={`lw${cls}`}>{m[0]}</span>);
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
});

export interface CardTarget { el: HTMLElement; token: string; seg: Segment; zh?: string | null }

/** The word card for a clicked word: meaning, what it means in this sentence, the speaker's voice, save. */
export function WordCard({ target, ep, onClose }: { target: CardTarget; ep: Episode; onClose: () => void }) {
  useLang((s) => s.lang);
  const data = useDict((s) => s.data);
  const entry = useMemo(() => (data ? lookup(data, target.token) : null), [data, target.token]);
  const id = entry?.lemma ?? target.token.toLowerCase();
  const saved = useWords((s) => s.words[id]);
  const aiOn = useStore((s) => s.settings.learnAi);
  const [ctx, setCtx] = useState<string | null>(saved?.ctx ?? null);
  const [ctxState, setCtxState] = useState<"idle" | "loading" | "none" | "error">("idle");
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: "hidden" });

  useEffect(() => {
    target.el.classList.add("open");
    return () => target.el.classList.remove("open");
  }, [target.el]);

  // Below the word, or above it when there is no room; kept inside the window.
  useEffect(() => {
    const place = () => {
      const r = target.el.getBoundingClientRect();
      const h = box.current?.offsetHeight ?? 240;
      const w = 320;
      const left = Math.min(Math.max(12, r.left - 20), window.innerWidth - w - 12);
      const below = r.bottom + 8 + h < window.innerHeight - 12;
      setPos(below ? { left, top: r.bottom + 8 } : { left, top: Math.max(12, r.top - 8 - h) });
    };
    place();
    const ro = new ResizeObserver(place);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, [target.el, ctxState, ctx]);

  useEffect(() => {
    const down = (e: PointerEvent) => { const n = e.target as Node; if (!box.current?.contains(n) && !target.el.contains(n)) onClose(); };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const scroll = (e: Event) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("pointerdown", down, true); window.removeEventListener("keydown", key); window.removeEventListener("scroll", scroll, true); };
  }, [onClose, target.el]);

  // What the word means here, from the default model (cached on the saved word).
  useEffect(() => {
    if (!aiOn || saved?.ctx) return;
    let live = true;
    void (async () => {
      if (!(await llmReady("chat"))) { if (live) setCtxState("none"); return; }
      const p = providerFor(useStore.getState().settings, "chat");
      if (!p) { if (live) setCtxState("none"); return; }
      setCtxState("loading");
      try {
        const r = await llmChat({ provider: p, maxTokens: 400, system: CTX_PROMPT, messages: [{ role: "user", content: `单词：${target.token}\n句子：${target.seg.text}` }] }); // i18n-ignore (prompt)
        if (!live) return;
        const text = r.trim().replace(/^["“]|["”]$/g, "").slice(0, 120);
        setCtx(text); setCtxState("idle");
        if (useWords.getState().words[id]) useWords.getState().update(id, { ctx: text });
      } catch { if (live) setCtxState("error"); }
    })();
    return () => { live = false; };
  }, [aiOn, target.token, target.seg.text]);

  const add = () => {
    useWords.getState().add({
      id, word: target.token, ipa: entry?.ipa ?? "", meaning: entry?.meaning ?? ctx ?? "", ctx: ctx ?? undefined,
      tag: entry ? tagLabel(entry.tags) : "", sentence: target.seg.text, sentenceZh: target.zh ?? undefined,
      episodeId: ep.id, episodeTitle: ep.title, showTitle: ep.showTitle, start: target.seg.start, end: target.seg.end,
    });
    useStore.getState().notify(t("已加入生词本：{word}", { word: entry?.lemma ?? target.token }));
    // The sentence's own audio, cut now, so review plays it at once.
    prefetchClip(ep.id, target.seg.start, target.seg.end);
  };
  const listen = async () => { if (!(await playClip(ep, target.seg.start, target.seg.end))) speak(target.seg.text); };
  const label = entry ? tagLabel(entry.tags) : "";

  return createPortal(
    <div ref={box} className="word-card" style={pos} role="dialog" aria-label={entry?.lemma ?? target.token}>
      <div className="wc-head">
        <span className="wc-word">{entry?.lemma ?? target.token}</span>
        {label && <span className="pill">{t(label)}</span>}
        <button className="icon-btn sm wc-say" title={t("读单词")} aria-label={t("读单词")} onClick={() => speak(entry?.lemma ?? target.token, 0.85)}><Volume2 size={15} /></button>
      </div>
      {entry?.ipa && <p className="wc-ipa">/{entry.ipa}/</p>}
      {entry ? <Meaning text={entry.meaning} /> : <p className="wc-none muted small">{t("词典里没有这个词")}</p>}
      {aiOn && ctxState !== "none" && (
        <div className="wc-ctx">
          <span className="wc-ctx-h">{t("在这句里")}</span>
          {ctx ? ctx : ctxState === "loading" ? <span className="skeleton wc-skel" /> : ctxState === "error" ? <span className="muted">{t("暂时没能解释，稍后再试")}</span> : null}
        </div>
      )}
      <div className="wc-foot">
        <button className="btn sm play" onClick={() => void listen()}><ClipIcon k={clipKey(ep.id, target.seg.start, target.seg.end)} />{t("原声")}</button>
        {saved
          ? <button className="btn sm ghost wc-saved" onClick={() => useStore.getState().go({ kind: "words" })}><Check size={13} />{t("已在生词本")}</button>
          : <button className="btn sm primary" onClick={add}><Plus size={13} />{t("加入生词本")}</button>}
      </div>
    </div>,
    document.body,
  );
}

const CTX_PROMPT = "你是耐心的英语老师。用户给出一个英文单词和它所在的句子。用一句简短的中文（不超过 40 个字）说明这个词在这句话里的具体意思，可以点出它和句中其他部分的关系。只输出这句解释，不要重复单词，不要加引号。"; // i18n-ignore (prompt)

/** Dictionary senses, one per line, with the part of speech set apart. */
function Meaning({ text }: { text: string }) {
  return (
    <div className="wc-def">
      {text.split("\n").map((l, i) => {
        const m = l.match(/^([a-z]+\.(?:\s*&\s*[a-z]+\.)?|\[[^\]]+\])\s*(.*)$/);
        return <p key={i}>{m ? <><span className="wc-pos">{m[1]}</span>{m[2]}</> : l}</p>;
      })}
    </div>
  );
}

/** Shown once, at the top of the first English transcript: offers the learning mode. */
export function LearnTip() {
  const { asked, on, save } = useStore(useShallow((s) => ({ asked: s.settings.learnAsked, on: s.settings.learnOn, save: s.saveSettings })));
  if (asked || on) return null;
  return (
    <div className="learn-tip">
      <span className="learn-tip-ic"><GraduationCap size={16} /></span>
      <div className="learn-tip-text"><p className="learn-tip-t">{t("想顺便学英语吗？")}</p><p className="learn-tip-s">{t("点字幕里的单词就能查，生词进生词本。")}</p></div>
      <div className="learn-tip-acts">
        <button className="btn sm ghost" onClick={() => void save({ learnAsked: true })}>{t("不用了")}</button>
        <button className="btn sm primary" onClick={() => { void save({ learnAsked: true, learnOn: true }); useStore.getState().notify(t("已打开英语学习模式，可以在 设置 › 学英语 里调整")); }}>{t("打开")}</button>
      </div>
    </div>
  );
}

// ---- this episode's words --------------------------------------------------------------------------------

interface Found { entry: Entry; token: string; seg: Segment; idx: number; count: number }

/** Every word above the listener's level in this episode, rarest first. */
function episodeWords(segments: Segment[], data: LearnMarks["data"], level: LearnLevel): Found[] {
  const found = new Map<string, Found>();
  segments.forEach((seg, idx) => {
    for (const m of seg.text.matchAll(WORD_RE)) {
      const e = lookup(data, m[0]);
      if (!e || !isNew(e, level)) continue;
      const i = m.index ?? 0;
      if (/^[A-Z]/.test(m[0]) && (i > 0 || !e.tags)) continue;
      const f = found.get(e.lemma);
      if (f) f.count++; else found.set(e.lemma, { entry: e, token: m[0], seg, idx, count: 1 });
    }
  });
  const weight = (f: Found) => (f.entry.rank || 60000) / Math.sqrt(f.count);
  return [...found.values()].sort((a, b) => weight(a) - weight(b));
}

export function EpisodeWords({ ep, segments, zh, onClose }: { ep: Episode; segments: Segment[]; zh: (number | string | null | undefined)[] | undefined; onClose: () => void }) {
  useLang((s) => s.lang);
  const data = useDict((s) => s.data);
  const level = useStore((s) => s.settings.learnLevel);
  const words = useWords((s) => s.words);
  const list = useMemo(() => (data ? episodeWords(segments, data, level) : []), [data, segments, level]);
  const fresh = list.filter((f) => !words[f.entry.lemma]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  useEffect(() => { setPicked(new Set(fresh.slice(0, 15).map((f) => f.entry.lemma))); }, [list.length]);
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const addPicked = () => {
    const add = useWords.getState().add;
    let n = 0;
    for (const f of fresh) if (picked.has(f.entry.lemma)) {
      prefetchClip(ep.id, f.seg.start, f.seg.end);
      add({ id: f.entry.lemma, word: f.token, ipa: f.entry.ipa, meaning: f.entry.meaning, tag: tagLabel(f.entry.tags), sentence: f.seg.text, sentenceZh: typeof zh?.[f.idx] === "string" ? (zh[f.idx] as string) : undefined, episodeId: ep.id, episodeTitle: ep.title, showTitle: ep.showTitle, start: f.seg.start, end: f.seg.end });
      n++;
    }
    useStore.getState().notify(t("已加入 {n} 个词到生词本", { n }));
    onClose();
  };
  return (
    <Modal title={t("本期生词")} onClose={onClose}>
      {!data ? <div className="panel-empty"><Loader2 className="spin" size={18} /></div> : !list.length ? <EmptyState title={t("这一期没有超出你水平的词")} note={t("可以在 设置 › 学英语 里调高水平")} /> : <>
        <p className="muted small ew-note">{t("按难度从高到低排列，默认勾选前 15 个还没收藏的词。")}</p>
        <div className="ew-list">
          {list.map((f) => {
            const have = !!words[f.entry.lemma];
            return (
              <label key={f.entry.lemma} className={`ew-item${have ? " have" : ""}`}>
                <input type="checkbox" checked={have || picked.has(f.entry.lemma)} disabled={have} onChange={() => toggle(f.entry.lemma)} />
                <span className="ew-w">{f.entry.lemma}</span>
                {tagLabel(f.entry.tags) && <span className="pill">{t(tagLabel(f.entry.tags))}</span>}
                <span className="ew-d">{f.entry.meaning.split("\n")[0]}</span>
                {f.count > 1 && <span className="muted small ew-n">×{f.count}</span>}
              </label>
            );
          })}
        </div>
        <div className="modal-foot"><button className="btn" onClick={onClose}>{t("取消")}</button><button className="btn primary" disabled={!picked.size} onClick={addPicked}>{t("加入 {n} 个词", { n: [...picked].filter((id) => !words[id]).length })}</button></div>
      </>}
    </Modal>
  );
}

// ---- shadowing --------------------------------------------------------------------------------------------

/** 跟读: after each sentence the player pauses about as long as the sentence took, so you can say it back. */
export function useShadowing(on: boolean, epId: string, segments: Segment[]) {
  useEffect(() => {
    if (!on) return;
    let resume: number | undefined;
    let lastEnd = -1;
    const unsub = useStore.subscribe((s, prev) => {
      if (s.current?.id !== epId || !s.playing || s.time === prev.time) return;
      // The sentence that just finished: playback crossed its end since the last update.
      const seg = segments.find((x) => prev.time < x.end && s.time >= x.end && s.time - x.end < 1.5);
      if (!seg || seg.end === lastEnd) return;
      lastEnd = seg.end;
      s.player?.toggle();
      const gap = Math.min(12, Math.max(1.5, (seg.end - seg.start) * 1.1 + 0.6));
      resume = window.setTimeout(() => { const st = useStore.getState(); if (!st.playing && st.current?.id === epId) st.player?.play(); }, gap * 1000);
    });
    return () => { unsub(); window.clearTimeout(resume); };
  }, [on, epId, segments]);
}

// ---- dictation --------------------------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9']+/g) ?? [];

/** Marks each word of the original as heard (typed) or missed, by longest common subsequence. */
function compare(original: string, typed: string): { word: string; ok: boolean }[] {
  const a = original.match(/\S+/g) ?? [];
  const an = a.map((w) => norm(w).join(""));
  const b = norm(typed);
  const dp = Array.from({ length: an.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = an.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = an[i] && an[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { word: string; ok: boolean }[] = [];
  let i = 0, j = 0;
  while (i < an.length) {
    if (!an[i]) { out.push({ word: a[i], ok: true }); i++; continue; }
    if (j < b.length && an[i] === b[j]) { out.push({ word: a[i], ok: true }); i++; j++; }
    else if (j < b.length && dp[i][j + 1] >= dp[i + 1][j]) j++;
    else { out.push({ word: a[i], ok: false }); i++; }
  }
  return out;
}

export function Dictation({ ep, segments, from, onClose }: { ep: Episode; segments: Segment[]; from: number; onClose: () => void }) {
  useLang((s) => s.lang);
  const usable = useMemo(() => segments.map((_, i) => i).filter((i) => (segments[i].text.match(/\S+/g)?.length ?? 0) >= 3), [segments]);
  const startAt = Math.max(0, usable.findIndex((i) => i >= from));
  const [k, setK] = useState(startAt);
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<{ word: string; ok: boolean }[] | null>(null);
  const [score, setScore] = useState({ right: 0, total: 0 });
  const input = useRef<HTMLTextAreaElement>(null);
  const seg = segments[usable[k]];
  const play = useCallback(() => { if (seg) void playClip(ep, seg.start, seg.end).then((ok) => { if (!ok) speak(seg.text); }); }, [ep, seg]);
  useEffect(() => { setTyped(""); setResult(null); play(); input.current?.focus(); }, [k]);
  useEffect(() => () => stopClip(), []);
  if (!seg) return <Modal title={t("听写练习")} onClose={onClose}><EmptyState title={t("这一期没有适合听写的句子")} /></Modal>;
  const check = () => {
    const r = compare(seg.text, typed);
    setResult(r);
    setScore((s) => ({ right: s.right + r.filter((x) => x.ok).length, total: s.total + r.length }));
  };
  const next = () => setK((x) => Math.min(usable.length - 1, x + 1));
  return (
    <Modal title={t("听写练习")} onClose={onClose}>
      <div className="dict">
        <div className="dict-top">
          <span className="muted small">{t("第 {n} 句", { n: k + 1 })} · {clock(seg.start)}</span>
          {score.total > 0 && <span className="muted small">{t("正确率 {p}%", { p: Math.round((score.right / score.total) * 100) })}</span>}
        </div>
        <button className="btn play dict-play" onClick={play}><Play size={13} className="fill-ico" />{t("再听一遍")}</button>
        <textarea ref={input} className="dict-input" rows={3} spellCheck={false} value={typed} placeholder={t("听到什么就写什么，按 Enter 检查")} disabled={!!result}
          onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!result) check(); } }} />
        {result && (
          <div className="dict-result">
            <p className="dict-ans">{result.map((w, i) => <span key={i} className={w.ok ? "" : "miss"}>{w.word} </span>)}</p>
            <p className="muted small">{t("听出 {a}/{b} 个词", { a: result.filter((x) => x.ok).length, b: result.length })}</p>
          </div>
        )}
        <div className="modal-foot">
          <button className="btn ghost" onClick={() => { setResult(compare(seg.text, "")); }} disabled={!!result}>{t("看答案")}</button>
          <span className="spacer" />
          {result ? <button className="btn primary" onClick={next} disabled={k >= usable.length - 1} autoFocus>{t("下一句")}</button> : <button className="btn primary" onClick={check} disabled={!typed.trim()}>{t("检查")}</button>}
        </div>
      </div>
    </Modal>
  );
}

// ---- word book and review ---------------------------------------------------------------------------------

type Filter = "due" | "all" | "mastered";

async function playWord(w: Word) {
  if (!(await playClip({ id: w.episodeId }, w.start, w.end))) speak(w.sentence);
}

/** Play, or a spinner while the sentence's clip is being cut. */
function ClipIcon({ k, size = 12 }: { k: string; size?: number }) {
  const loading = useClipLoading((s) => s.key === k);
  return loading ? <Loader2 size={size} className="spin" /> : <Play size={size} className="fill-ico" />;
}

export function WordsView() {
  useLang((s) => s.lang);
  useLearnOn();
  const { words, loaded, day, newToday } = useWords(useShallow((s) => ({ words: s.words, loaded: s.loaded, day: s.day, newToday: s.newToday })));
  const dailyNew = useStore((s) => s.settings.learnDaily);
  const on = useStore((s) => s.settings.learnOn);
  const [filter, setFilter] = useState<Filter>("due");
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => { void useWords.getState().load(); return () => stopClip(); }, []);
  const now = Date.now();
  const all = useMemo(() => Object.values(words).sort((a, b) => b.added - a.added), [words]);
  const queue = useMemo(() => reviewQueue({ words, day, newToday }, dailyNew), [words, day, newToday, dailyNew, reviewing]);
  const mastered = all.filter(isMastered);
  // The first cards of today's review get their audio ready while you look at the list.
  useEffect(() => { for (const w of queue.slice(0, 4)) prefetchClip(w.episodeId, w.start, w.end); }, [queue]);
  const shown = filter === "due" ? queue : filter === "mastered" ? mastered : all;

  if (reviewing) return <Review queue={queue} onDone={() => setReviewing(false)} />;
  return (
    <div className="page words-page">
      <div className="wb-head">
        <h1 className="page-title">{t("生词本")}</h1>
        {all.length > 0 && <span className="muted wb-count">{t("{n} 个词", { n: all.length })}</span>}
        <div className="wb-acts">
          {all.length > 0 && <ExportButtons words={all} />}
          <button className="btn sm primary" disabled={!queue.length} onClick={() => setReviewing(true)}>{queue.length ? t("复习 {n} 个", { n: queue.length }) : t("今天复习完了")}</button>
        </div>
      </div>
      {!on && <p className="wb-off muted small">{t("英语学习模式已关闭，生词本仍然保留。")} <button className="link-btn small" onClick={() => useStore.getState().openSettings("learn")}>{t("去打开")}</button></p>}
      {!loaded ? null : !all.length ? (
        <EmptyState art={<span className="wb-empty-ic"><BookMarked size={28} /></span>} title={t("生词本还是空的")} note={t("在英文节目的字幕里点一个单词，再点「加入生词本」。")} />
      ) : <>
        <div className="chips left">
          {([["due", t("待复习"), queue.length], ["all", t("全部"), all.length], ["mastered", t("已掌握"), mastered.length]] as const).map(([k, label, n]) => (
            <button key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>{label}<span className="n">{n}</span></button>
          ))}
        </div>
        {!shown.length ? <p className="muted small wb-none">{filter === "due" ? t("今天没有要复习的词了。") : t("还没有掌握的词。连续答对，间隔超过 3 周就算掌握。")}</p> : (
          <div className="wb-list">
            {shown.map((w) => {
              const due = dueLabel(w, now);
              return (
                <div key={w.id} className="wb-item">
                  <div className="wb-main">
                    <div className="wb-l1"><span className="wb-w">{w.id}</span>{w.ipa && <span className="wb-ipa">/{w.ipa}/</span>}{w.tag && <span className="pill">{t(w.tag)}</span>}</div>
                    <p className="wb-d">{(w.ctx || w.meaning.split("\n")[0])}</p>
                    <p className="wb-src"><span className="clamp1">{w.showTitle || w.episodeTitle}</span><button className="ts-link" onClick={() => void playWord(w)} title={t("播放原句")}><ClipIcon k={clipKey(w.episodeId, w.start, w.end)} size={10} />{clock(w.start)}</button></p>
                  </div>
                  <span className={`due ${due.now ? "now" : ""}`}>{due.text}</span>
                  <button className="icon-btn sm wb-del" title={t("从生词本删除")} aria-label={t("从生词本删除")} onClick={() => useWords.getState().remove(w.id)}><Trash2 size={14} /></button>
                </div>
              );
            })}
          </div>
        )}
      </>}
    </div>
  );
}

function ExportButtons({ words }: { words: Word[] }) {
  return <>
    <button className="btn sm" onClick={() => void exportWords("anki", words)}><Download size={13} />{t("导出 Anki")}</button>
    <button className="btn sm ghost" onClick={() => void exportWords("csv", words)}>CSV</button>
  </>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const wordRe = (w: string, flags = "i") => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, flags);

let exporting = false;
/** Asks where to save, then writes the word book: an Anki package with each sentence's audio, or a CSV. */
export async function exportWords(kind: "anki" | "csv", words: Word[]) {
  if (exporting || !words.length) return;
  const notify = useStore.getState().notify;
  const name = `SubCast ${t("生词本")}`;
  const path = await saveDialog({ defaultPath: `${name}.${kind === "anki" ? "apkg" : "csv"}`, filters: [kind === "anki" ? { name: "Anki", extensions: ["apkg"] } : { name: "CSV", extensions: ["csv"] }] }).catch(() => null);
  if (!path) return;
  exporting = true;
  try {
    if (kind === "csv") {
      await api.saveText(path, toCsv(words, [t("单词"), t("音标"), t("释义"), t("在这句里"), t("原句"), t("译文"), t("节目"), t("单集"), t("时间"), t("加入日期")]));
    } else {
      // Every card carries its sentence in the speaker's voice: clips not cut yet are made now, a few at a time.
      const clips = new Map<string, string | null>();
      let done = 0;
      const todo = [...words];
      notify(t("正在准备 {n} 个词的原声…", { n: words.length }));
      await Promise.all([0, 1, 2].map(async () => {
        for (let w = todo.shift(); w; w = todo.shift()) {
          clips.set(w.id, await prepareClip(w.episodeId, w.start, w.end));
          if (++done % 10 === 0 && done < words.length) notify(t("正在准备原声 {done}/{n}…", { done, n: words.length }));
        }
      }));
      const notes: AnkiNote[] = words.map((w) => ({
        id: w.id, word: esc(w.id), ipa: esc(w.ipa), meaning: esc(w.meaning).replace(/\n/g, "<br>"), context: esc(w.ctx ?? ""),
        sentence: esc(w.sentence).replace(wordRe(esc(w.word)), (m) => `<b>${m}</b>`), translation: esc(w.sentenceZh ?? ""),
        source: esc([w.showTitle, w.episodeTitle, clock(w.start)].filter(Boolean).join(" · ")),
        tags: ["subcast", w.tag].filter(Boolean).map((x) => x.replace(/\s+/g, "_")).join(" "), clip: clips.get(w.id) ?? null,
      }));
      const withAudio = await api.exportAnki(path, name, `SubCast ${t("单词")}`, notes);
      notify(withAudio < words.length
        ? t("已导出 {n} 个词（{m} 个带原声）：{file}", { n: words.length, m: withAudio, file: path.split(/[\\/]/).pop() ?? "" })
        : t("已导出 {n} 个词：{file}", { n: words.length, file: path.split(/[\\/]/).pop() ?? "" }));
      void revealItemInDir(path).catch(() => {});
      return;
    }
    notify(t("已导出 {n} 个词：{file}", { n: words.length, file: path.split(/[\\/]/).pop() ?? "" }));
    void revealItemInDir(path).catch(() => {});
  } catch (e) { notify(t("导出失败：{why}", { why: errorText(e) })); }
  finally { exporting = false; }
}

const GRADES: [Grade, string, string][] = [[Rating.Again, "again", tk("忘了")], [Rating.Hard, "", tk("困难")], [Rating.Good, "good", tk("记得")], [Rating.Easy, "", tk("简单")]];

/** Spaced review: the front plays the sentence with the word blanked out; the back shows it, then you rate it. */
function Review({ queue, onDone }: { queue: Word[]; onDone: () => void }) {
  useLang((s) => s.lang);
  const [list] = useState(queue);
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const w = list[i];
  const gaps = useMemo(() => (w ? intervals(useWords.getState().words[w.id] ?? w) : null), [w, flipped]);
  useEffect(() => {
    if (w) void playWord(w);
    for (const n of list.slice(i + 1, i + 4)) prefetchClip(n.episodeId, n.start, n.end);
    return () => stopClip();
  }, [i]);
  // The answer side says the word itself (system voice, instant).
  useEffect(() => { if (flipped && w) speak(w.id, 0.85); }, [flipped]);
  const rate = useCallback((g: Grade) => {
    if (!w) return;
    useWords.getState().rate(w.id, g);
    // A word you forgot comes back at the end of this session.
    if (g === Rating.Again) list.push(w);
    setFlipped(false);
    setI((x) => x + 1);
  }, [w, list]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!flipped) setFlipped(true); else rate(Rating.Good); }
      else if (flipped && ["1", "2", "3", "4"].includes(e.key)) { e.preventDefault(); rate(Number(e.key) as Grade); }
      else if (e.key.toLowerCase() === "r") { e.preventDefault(); if (w) void playWord(w); }
      else if (flipped && e.key.toLowerCase() === "w") { e.preventDefault(); if (w) speak(w.id, 0.85); }
      else if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [flipped, rate, w, onDone]);

  if (!w) return (
    <div className="page review-page">
      <EmptyState art={<span className="wb-empty-ic done"><Check size={28} /></span>} title={t("今天的复习完成了")} note={t("复习了 {n} 个词，明天再来。", { n: new Set(list.map((x) => x.id)).size })}>
        <button className="btn primary" onClick={onDone}>{t("回到生词本")}</button>
      </EmptyState>
    </div>
  );
  const blank = w.sentence.replace(new RegExp(`\\b${w.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), " _____ ");
  const marked = w.sentence.split(new RegExp(`(\\b${w.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b)`, "i"));
  return (
    <div className="page review-page">
      <div className="rv-top">
        <button className="icon-btn sm" onClick={onDone} title={t("结束复习（Esc）")} aria-label={t("结束复习")}><X size={16} /></button>
        <span className="rv-meter"><i style={{ width: `${(i / list.length) * 100}%` }} /></span>
        <span className="rv-num">{i + 1} / {list.length}</span>
      </div>
      <div className="rv-card">
        <span className="rv-src clamp1">{w.showTitle ? `${w.showTitle} · ` : ""}{clock(w.start)}</span>
        {flipped ? <>
          <p className="rv-word">{w.id}<button className="icon-btn sm rv-say" title={t("读单词（W）")} aria-label={t("读单词")} onClick={() => speak(w.id, 0.85)}><Volume2 size={16} /></button></p>
          {w.ipa && <p className="rv-ipa">/{w.ipa}/</p>}
          <div className="rv-def"><Meaning text={w.meaning} /></div>
          {w.ctx && <p className="rv-ctx"><span className="wc-ctx-h">{t("在这句里")}</span>{w.ctx}</p>}
          <p className="rv-sent">{marked.map((p, k) => (k % 2 ? <mark key={k}>{p}</mark> : p))}{w.sentenceZh && <span className="rv-zh">{w.sentenceZh}</span>}</p>
        </> : <>
          <p className="rv-q">{t("这句话里空着的是哪个词？")}</p>
          <p className="rv-sent front">{blank}</p>
        </>}
        <button className="btn sm play rv-listen" onClick={() => void playWord(w)}><ClipIcon k={clipKey(w.episodeId, w.start, w.end)} />{t("再听原句")}<span className="kbd">R</span></button>
        {flipped ? (
          <div className="rv-rate">
            {GRADES.map(([g, cls, label], k) => (
              <button key={g} className={`btn ${cls}`} onClick={() => rate(g)}>
                <span className="t">{t(label)}</span>
                <span className="s"><span className="kbd">{k + 1}</span>{gaps ? fmtWait(gaps[g]) : ""}</span>
              </button>
            ))}
          </div>
        ) : (
          <button className="btn primary rv-show" onClick={() => setFlipped(true)}>{t("显示答案")}<span className="kbd">␣</span></button>
        )}
      </div>
    </div>
  );
}

/** Words due today, for the sidebar badge. */
export function useDueCount(): number {
  const on = useStore((s) => s.settings.learnOn);
  const dailyNew = useStore((s) => s.settings.learnDaily);
  const { words, day, newToday } = useWords(useShallow((s) => ({ words: s.words, day: s.day, newToday: s.newToday })));
  useEffect(() => { if (on) void useWords.getState().load(); }, [on]);
  return useMemo(() => (on ? reviewQueue({ words, day, newToday }, dailyNew).length : 0), [on, words, day, newToday, dailyNew]);
}

/** Once a day after launch: a reminder when words are waiting, if asked for. */
export async function remindReview() {
  const s = useStore.getState().settings;
  if (!s.learnOn || !s.learnRemind) return;
  const key = "subcast-learn-reminded";
  const d = new Date().toLocaleDateString("sv");
  try { if (localStorage.getItem(key) === d) return; } catch { /* private mode: remind anyway */ }
  await useWords.getState().load();
  const w = useWords.getState();
  const n = reviewQueue(w, s.learnDaily).length;
  if (!n) return;
  try { localStorage.setItem(key, d); } catch { /* ignore */ }
  useStore.getState().notify(t("生词本里有 {n} 个词等你复习", { n }));
}

