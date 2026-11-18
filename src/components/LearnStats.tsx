// The word book's study record: a few numbers (streak, this week, how much you remember, mastered) and a
// calendar heatmap of the days studied. Click a day for the words reviewed and saved that day.
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Flame } from "lucide-react";
import { dayOf, isMastered, useWords, type DayLog, type Word } from "../lib/words";
import { t, useLang } from "../lib/i18n";

const DAY = 86_400_000;
const CELL = 11;
const GAP = 3;
const LABEL_W = 22;

interface Day { r: number; a: number; reviewed: string[]; added: string[] }

/** Every day with study in it: reviews from the log, words saved from each word's date. */
function byDay(words: Record<string, Word>, log: Record<string, DayLog>): Map<string, Day> {
  const out = new Map<string, Day>();
  const get = (d: string) => { let x = out.get(d); if (!x) out.set(d, (x = { r: 0, a: 0, reviewed: [], added: [] })); return x; };
  for (const [d, l] of Object.entries(log)) { const x = get(d); x.r += l.r; x.a += l.a; x.reviewed.push(...l.ids); }
  for (const w of Object.values(words)) get(dayOf(w.added)).added.push(w.id);
  return out;
}

const level = (n: number) => (n === 0 ? 0 : n < 3 ? 1 : n < 10 ? 2 : n < 20 ? 3 : 4);
const midnight = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return +d; };

/** Days in a row with study, up to today (or up to yesterday, while today is still open). */
function streak(days: Map<string, Day>, now: number): number {
  let n = 0;
  let at = midnight(now);
  if (!days.has(dayOf(at))) at -= DAY;
  while (days.has(dayOf(at))) { n++; at = midnight(at - DAY / 2); }
  return n;
}

export function LearnStats({ onOpen }: { onOpen: (id: string) => void }) {
  const lang = useLang((s) => s.lang);
  const { words, log } = useWords(useShallow((s) => ({ words: s.words, log: s.log })));
  const box = useRef<HTMLDivElement>(null);
  const [weeks, setWeeks] = useState(26);
  const [picked, setPicked] = useState<string | null>(null);

  // As many weeks as fit, up to a year.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setWeeks(Math.max(8, Math.min(53, Math.floor((el.clientWidth - 8 - LABEL_W + GAP) / (CELL + GAP)))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const now = Date.now();
  const today = dayOf(now);
  const days = useMemo(() => byDay(words, log), [words, log]);
  const stats = useMemo(() => {
    let week = 0, r30 = 0, a30 = 0;
    for (let i = 0; i < 30; i++) {
      const d = days.get(dayOf(now - i * DAY));
      if (!d) continue;
      if (i < 7) week += d.r;
      r30 += d.r; a30 += d.a;
    }
    return { streak: streak(days, now), week, kept: r30 >= 10 ? Math.round((1 - a30 / r30) * 100) : null, mastered: Object.values(words).filter(isMastered).length, total: Object.keys(words).length };
  }, [days, words, today]);

  // Columns are weeks (Monday first), the last one this week.
  const grid = useMemo(() => {
    const t0 = new Date(midnight(now));
    const monday = +t0 - ((t0.getDay() + 6) % 7) * DAY;
    const first = midnight(monday - (weeks - 1) * 7 * DAY + DAY / 2);
    const month = new Intl.DateTimeFormat(lang, { month: "short" });
    const cols: { days: { key: string; n: number; future: boolean }[]; month?: string }[] = [];
    for (let c = 0; c < weeks; c++) {
      const col: (typeof cols)[number] = { days: [] };
      for (let r = 0; r < 7; r++) {
        const ms = midnight(first + (c * 7 + r) * DAY + DAY / 2);
        const key = dayOf(ms);
        const d = days.get(key);
        col.days.push({ key, n: d ? d.r + d.added.length : 0, future: ms > now });
        if (new Date(ms).getDate() === 1 && c > 0) col.month = month.format(ms);
      }
      cols.push(col);
    }
    return cols;
  }, [days, weeks, lang, today]);

  const weekday = new Intl.DateTimeFormat(lang, { weekday: "narrow" });
  const dayLabel = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString(lang, { month: "long", day: "numeric", weekday: "short" });
  const tip = (key: string) => {
    const d = days.get(key);
    if (!d) return t("{day}：没有学习", { day: dayLabel(key) });
    const day = dayLabel(key), r = d.r, n = d.added.length;
    return r && n ? t("{day}：复习 {r} 次，新加 {n} 个词", { day, r, n }) : r ? t("{day}：复习 {r} 次", { day, r }) : t("{day}：新加 {n} 个词", { day, n });
  };
  const sel = picked ? days.get(picked) : null;
  const chips = sel ? [...new Set([...sel.added, ...sel.reviewed])].filter((id) => words[id]) : [];

  return (
    <section className="ls">
      <div className="ls-nums">
        <div className="ls-num"><span className="ls-v">{stats.streak > 0 && <Flame size={16} className="ls-fire" />}{stats.streak}</span><span className="ls-k">{t("连续学习（天）")}</span></div>
        <div className="ls-num"><span className="ls-v">{stats.week}</span><span className="ls-k">{t("近 7 天复习")}</span></div>
        <div className="ls-num"><span className="ls-v">{stats.kept == null ? "—" : `${stats.kept}%`}</span><span className="ls-k" title={t("近 30 天复习时没有选「忘了」的比例（至少复习 10 次后显示）")}>{t("记住率")}</span></div>
        <div className="ls-num"><span className="ls-v">{stats.mastered}<span className="ls-of"> / {stats.total}</span></span><span className="ls-k">{t("已掌握")}</span></div>
      </div>
      <div className="ls-map" ref={box}>
        <div className="ls-months" style={{ paddingLeft: LABEL_W }}>
          {grid.map((c, i) => <span key={i} style={{ width: CELL + GAP }}>{c.month ?? ""}</span>)}
        </div>
        <div className="ls-body">
          <div className="ls-wd" style={{ width: LABEL_W }}>
            {[0, 1, 2, 3, 4, 5, 6].map((r) => <span key={r}>{r % 2 === 0 && r < 6 ? weekday.format(new Date(2024, 0, 1 + r)) : ""}</span>)}
          </div>
          {grid.map((c, i) => (
            <div key={i} className="ls-col">
              {c.days.map((d) => d.future ? <span key={d.key} className="ls-cell future" /> : (
                <button key={d.key} className={`ls-cell l${level(d.n)} ${d.key === today ? "today" : ""} ${d.key === picked ? "on" : ""}`}
                  title={tip(d.key)} aria-label={tip(d.key)} onClick={() => setPicked(picked === d.key ? null : d.key)} />
              ))}
            </div>
          ))}
        </div>
        <div className="ls-legend"><span>{t("少")}</span>{[0, 1, 2, 3, 4].map((l) => <span key={l} className={`ls-cell l${l}`} />)}<span>{t("多")}</span></div>
      </div>
      {picked && (
        <div className="ls-day">
          <span className="ls-day-h">{tip(picked)}</span>
          {chips.length > 0 && <div className="ls-chips">{chips.map((id) => <button key={id} className="ls-chip" onClick={() => onOpen(id)}>{id}</button>)}</div>}
        </div>
      )}
    </section>
  );
}
