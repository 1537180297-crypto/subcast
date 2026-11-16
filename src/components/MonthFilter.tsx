import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import type { Episode } from "../lib/api";

const key = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

/** Month filter state for an episode list. */
export function useMonthFilter(eps: Episode[] | null) {
  const [month, setMonth] = useState<string | null>(null);
  const filtered = useMemo(() => (month && eps ? eps.filter((e) => e.published && key(e.published) === month) : eps), [eps, month]);
  return { month, setMonth, filtered };
}

/** A year of months, each showing how many episodes came out — a compact calendar that doubles as a heat map.
 *  Months with nothing are dimmed and can't be picked; clicking the picked month again clears it. */
export function MonthFilter({ episodes, month, onChange }: { episodes: Episode[] | null; month: string | null; onChange: (m: string | null) => void }) {
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of episodes ?? []) if (e.published) m.set(key(e.published), (m.get(key(e.published)) ?? 0) + 1);
    return m;
  }, [episodes]);
  const years = useMemo(() => [...new Set([...counts.keys()].map((k) => Number(k.slice(0, 4))))].sort((a, b) => b - a), [counts]);
  const [year, setYear] = useState<number | null>(null);
  const y = year ?? (month ? Number(month.slice(0, 4)) : years[0]) ?? new Date().getFullYear();
  if (!episodes?.length || counts.size < 2) return null;
  const max = Math.max(...counts.values());
  const yearTotal = [...counts.entries()].filter(([k]) => k.startsWith(`${y}-`)).reduce((n, [, c]) => n + c, 0);
  const idx = years.indexOf(y);
  return (
    <div className="month-filter" role="group" aria-label="按月份筛选">
      <div className="mf-head">
        <CalendarDays size={14} />
        <button className="icon-btn sm" disabled={idx >= years.length - 1} onClick={() => setYear(years[idx + 1])} aria-label="上一年"><ChevronLeft size={14} /></button>
        <span className="mf-year">{y}</span>
        <button className="icon-btn sm" disabled={idx <= 0} onClick={() => setYear(years[idx - 1])} aria-label="下一年"><ChevronRight size={14} /></button>
        <span className="muted small">{yearTotal} 期</span>
        <span className="spacer" />
        {month && <button className="chip sm on" onClick={() => onChange(null)}>{Number(month.slice(5))} 月 <X size={11} /></button>}
      </div>
      <div className="mf-grid">
        {Array.from({ length: 12 }, (_, i) => {
          const k = `${y}-${String(i + 1).padStart(2, "0")}`;
          const n = counts.get(k) ?? 0;
          return (
            <button key={k} className={`mf-cell ${month === k ? "on" : ""} ${n / max > 0.6 ? "hot" : ""}`} disabled={!n} onClick={() => onChange(month === k ? null : k)}
              style={{ "--heat": n ? 0.18 + 0.6 * (n / max) : 0 } as React.CSSProperties} title={n ? `${y} 年 ${i + 1} 月 · ${n} 期` : `${i + 1} 月没有节目`}>
              <span className="mf-m">{i + 1}月</span>
              <span className="mf-n">{n || "·"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
