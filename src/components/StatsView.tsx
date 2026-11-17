// 我的收听: what the listener has heard, from the time actually spent playing (seeks don't count). Everything is
// computed on this computer from the listens table; nothing is sent anywhere.
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, type ListenRow } from "../lib/api";
import { useStore } from "../store";
import { isChineseUi, t, tk, useLang } from "../lib/i18n";
import { showName } from "../lib/picks";
import { EmptyState, HeadphonesArt } from "./Illustrations";

const DAY = 86_400_000;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** "12 小时 30 分" / "45 分钟" / "38 秒". */
function span(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (seconds < 60) return t("{n} 秒", { n: Math.round(seconds) });
  if (m < 60) return t("{n} 分钟", { n: m });
  const h = Math.floor(m / 60), r = m % 60;
  return r ? t("{h} 小时 {m} 分", { h, m: r }) : t("{h} 小时", { h });
}

type Range = "week" | "month" | "year" | "all";
const RANGES: [Range, string, number][] = [["week", tk("近 7 天"), 7], ["month", tk("近 30 天"), 30], ["year", tk("近一年"), 365], ["all", tk("全部"), 3650]];

export function StatsView() {
  const { go, shows: subscribed } = useStore(useShallow((s) => ({ go: s.go, shows: s.shows })));
  useLang((s) => s.lang);
  const [rows, setRows] = useState<ListenRow[] | null>(null);
  const [range, setRange] = useState<Range>("month");
  useEffect(() => { void api.listeningStats(ymd(new Date(Date.now() - 371 * DAY))).then(setRows).catch(() => setRows([])); }, []);

  const s = useMemo(() => {
    if (!rows) return null;
    const days = RANGES.find((r) => r[0] === range)![2];
    const since = ymd(new Date(Date.now() - (days - 1) * DAY));
    const inRange = rows.filter((r) => r.day >= since);
    const total = inRange.reduce((n, r) => n + r.seconds, 0);
    const translated = inRange.filter((r) => r.translated).reduce((n, r) => n + r.seconds, 0);
    const episodes = new Set(inRange.filter((r) => r.seconds > 60).map((r) => r.episodeId)).size;
    // Streak: consecutive days up to today (or yesterday) with at least 5 minutes.
    const byDay = new Map<string, number>();
    for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.seconds);
    let streak = 0;
    for (let d = new Date(), first = true; ; d = new Date(d.getTime() - DAY), first = false) {
      if ((byDay.get(ymd(d)) ?? 0) >= 300) streak++;
      else if (!first) break;
      if (streak > 3650) break;
    }
    const shows = new Map<string, { title: string; cover: string; kind: string; seconds: number; episodes: Set<string> }>();
    for (const r of inRange) {
      const x = shows.get(r.showId) ?? { title: r.showTitle, cover: r.cover, kind: r.kind, seconds: 0, episodes: new Set() };
      x.seconds += r.seconds; x.episodes.add(r.episodeId); shows.set(r.showId, x);
    }
    const top = [...shows.entries()].map(([id, x]) => ({ id, ...x, cover: x.cover || subscribed.find((s) => s.id === id)?.cover || "" })).sort((a, b) => b.seconds - a.seconds).slice(0, 8);
    const kinds = new Map<string, number>();
    // Where it was played from. 精读 is a collection, not a source: its episodes count as video or podcast.
    for (const r of inRange) { const k = r.video ? "video" : r.kind === "xiaoyuzhou" ? "xiaoyuzhou" : "podcast"; kinds.set(k, (kinds.get(k) ?? 0) + r.seconds); }
    const hours = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    for (const r of inRange) { const wd = (new Date(`${r.day}T00:00:00`).getDay() + 6) % 7; hours[wd][r.hour] += r.seconds; }
    return { total, translated, episodes, streak, top, kinds, hours, byDay };
  }, [rows, range, subscribed]);

  if (!rows || !s) return <div className="page stats" />;
  if (!rows.length) {
    return (
      <div className="page stats">
        <h1 className="page-title">{t("收听统计")}</h1>
        <EmptyState art={<HeadphonesArt />} title={t("还没有收听记录")} note={t("从这一版开始，听过的每一分钟都会记在这里，只存在你的电脑上。")}>
          <button className="btn primary" onClick={() => go({ kind: "latest" })}>{t("去听一集")}</button>
        </EmptyState>
      </div>
    );
  }
  const maxShow = Math.max(1, ...s.top.map((x) => x.seconds));
  const KIND_NAME: Record<string, string> = { video: t("YouTube 视频"), podcast: t("播客"), xiaoyuzhou: t("小宇宙") };
  const kindTotal = [...s.kinds.values()].reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="page stats">
      <div className="stats-head">
        <h1 className="page-title">{t("收听统计")}</h1>
        <div className="seg-control" role="radiogroup">
          {RANGES.map(([k, label]) => <button key={k} role="radio" aria-checked={range === k} className={range === k ? "on" : ""} onClick={() => setRange(k)}>{t(label)}</button>)}
        </div>
      </div>
      <div className="stat-tiles">
        <Tile label={t("收听时长")} value={span(s.total)} />
        <Tile label={t("听过的单集")} value={t("{n} 集", { n: s.episodes })} />
        <Tile label={t("连续收听")} value={t("{n} 天", { n: s.streak })} hint={t("每天至少 5 分钟")} />
        <Tile label={t("借助字幕听懂")} value={span(s.translated)} hint={t("开着双语或中文字幕的时间")} />
      </div>
      <section className="stats-card">
        <div className="stats-card-h"><h2>{t("每天听了多久")}</h2><span className="muted small">{t("近一年")}</span></div>
        <Heatmap byDay={s.byDay} />
      </section>
      <div className="stats-grid">
        <section className="stats-card">
          <div className="stats-card-h"><h2>{t("常听的节目")}</h2></div>
          {s.top.length ? (
            <ol className="top-shows">
              {s.top.map((x, i) => (
                <li key={x.id} role="button" tabIndex={0} onClick={() => x.id && x.id !== "single" && go({ kind: "show", id: x.id })}>
                  <span className="top-rank num">{i + 1}</span>
                  {x.cover ? <img src={x.cover} alt="" loading="lazy" /> : <span className="top-ph" />}
                  <span className="top-name"><span className="clamp1">{x.title ? (isChineseUi() ? showName(x.title) : x.title) : t("单独打开的单集")}</span><span className="top-bar"><span style={{ width: `${(x.seconds / maxShow) * 100}%` }} /></span></span>
                  <span className="top-time muted small num">{span(x.seconds)}</span>
                </li>
              ))}
            </ol>
          ) : <p className="muted small">{t("这段时间没有收听")}</p>}
        </section>
        <section className="stats-card">
          <div className="stats-card-h"><h2>{t("来源")}</h2></div>
          <div className="kind-bar" role="img" aria-label={t("来源")}>
            {[...s.kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => <span key={k} className={`kind-seg k-${k}`} style={{ flexGrow: v }} title={`${KIND_NAME[k]} ${Math.round((v / kindTotal) * 100)}%`} />)}
          </div>
          <ul className="kind-legend">
            {[...s.kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => <li key={k}><span className={`kind-dot k-${k}`} />{KIND_NAME[k]}<span className="muted small num">{Math.round((v / kindTotal) * 100)}% · {span(v)}</span></li>)}
          </ul>
          <div className="stats-card-h sub"><h2>{t("什么时候听")}</h2></div>
          <HourGrid hours={s.hours} />
        </section>
      </div>
      <p className="muted small stats-foot">{t("只统计真正在播放的时间，拖动进度条不算。数据只保存在这台电脑上。")}</p>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="stat-tile" title={hint}><span className="muted small">{label}</span><b className="num">{value}</b></div>;
}

/** A year of days, columns are weeks (Monday first), darker = longer; like a contributions calendar. */
function Heatmap({ byDay }: { byDay: Map<string, number> }) {
  const today = new Date();
  const start = new Date(today.getTime() - 364 * DAY);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const cells: { day: string; secs: number; future: boolean }[] = [];
  for (let d = new Date(start); d <= today || (d.getDay() + 6) % 7 !== 0; d = new Date(d.getTime() + DAY)) {
    cells.push({ day: ymd(d), secs: byDay.get(ymd(d)) ?? 0, future: d > today });
    if (cells.length > 380) break;
  }
  const level = (s: number) => (s <= 0 ? 0 : s < 900 ? 1 : s < 1800 ? 2 : s < 3600 ? 3 : 4);
  const months: { col: number; label: string }[] = [];
  cells.forEach((c, i) => { if (i % 7 === 0) { const d = new Date(`${c.day}T00:00:00`); if (d.getDate() <= 7) months.push({ col: i / 7, label: isChineseUi() ? `${d.getMonth() + 1}月` : d.toLocaleString(undefined, { month: "short" }) }); } }); // i18n-ignore
  return (
    <div className="heatmap-wrap">
      <div className="heatmap-months" style={{ gridTemplateColumns: `repeat(${Math.ceil(cells.length / 7)}, 1fr)` }}>
        {months.map((m) => <span key={m.col} style={{ gridColumn: `${m.col + 1} / span 4` }}>{m.label}</span>)}
      </div>
      <div className="heatmap" style={{ gridTemplateColumns: `repeat(${Math.ceil(cells.length / 7)}, 1fr)` }}>
        {cells.map((c) => <span key={c.day} className={`hm l${level(c.secs)} ${c.future ? "future" : ""}`} title={c.future ? "" : `${c.day} · ${c.secs ? span(c.secs) : t("没有收听")}`} />)}
      </div>
      <div className="heatmap-legend muted small">{t("少")}{[0, 1, 2, 3, 4].map((l) => <span key={l} className={`hm l${l}`} />)}{t("多")}</div>
    </div>
  );
}

/** Weekday × hour: when listening happens. */
function HourGrid({ hours }: { hours: number[][] }) {
  const max = Math.max(1, ...hours.flat());
  const wd = isChineseUi() ? ["一", "二", "三", "四", "五", "六", "日"] : ["M", "T", "W", "T", "F", "S", "S"]; // i18n-ignore
  return (
    <div className="hourgrid">
      {hours.map((row, d) => (
        <div key={d} className="hourgrid-row"><span className="muted small">{wd[d]}</span>
          {row.map((v, h) => <span key={h} className="hg" style={{ opacity: v ? 0.18 + 0.82 * (v / max) : 1 }} data-on={v > 0} title={`${h}:00 · ${v ? span(v) : t("没有收听")}`} />)}
        </div>
      ))}
      <div className="hourgrid-row axis"><span />{[0, 6, 12, 18].map((h) => <span key={h} className="muted small" style={{ gridColumn: `${h + 2} / span 6` }}>{h}:00</span>)}</div>
    </div>
  );
}
