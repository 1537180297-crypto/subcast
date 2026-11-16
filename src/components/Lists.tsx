import { useEffect, useMemo, useState } from "react";
import { BookOpen, Check, ChevronDown, ChevronRight, Link2, Loader2, MoreHorizontal, Play, Plus, RefreshCw, Youtube } from "lucide-react";
import { api, errorText, type Episode, type Show } from "../lib/api";
import { date, duration } from "../lib/format";
import { PICKS, TOPICS, deepPickFor, isSubscribed, sameFeed, type Pick, type Topic } from "../lib/picks";
import { useShowName, useZh } from "../lib/zh";
import { useStore } from "../store";
import { SkeletonFeed } from "./Skeleton";
import { MonthFilter, useMonthFilter } from "./MonthFilter";

// ---- episode rows -------------------------------------------------------------------------------

function ShowName({ title }: { title?: string }) {
  if (!title) return null;
  const { zh, orig } = useShowName(title);
  return <span className="show-name">{zh ?? orig}</span>;
}

/** One episode, built for scanning: who and when on a small first line, the title in full (up to two lines),
 *  the original title muted underneath, and status only when it means something. */
function EpisodeRow({ ep, showShow }: { ep: Episode; showShow: boolean }) {
  const openEpisode = useStore((s) => s.openEpisode);
  const current = useStore((s) => s.current);
  const zh = useZh(ep.title);
  const pct = ep.duration && ep.progress > 5 ? Math.min(100, (ep.progress / ep.duration) * 100) : 0;
  const deep = !!ep.deep;
  return (
    <div className={`ep-item ${current?.id === ep.id ? "playing" : ""} ${pct >= 97 ? "played" : ""}`} role="button" tabIndex={0} onClick={() => openEpisode(ep)} onKeyDown={(e) => e.key === "Enter" && openEpisode(ep)}>
      <div className={`ep-thumb ${ep.videoId ? "video" : "square"}`}>
        {ep.cover && !ep.videoId && <img className="thumb-bg" src={ep.cover} alt="" aria-hidden loading="lazy" />}
        {ep.cover ? <img className="thumb-img" src={ep.cover} alt="" loading="lazy" onError={(e) => {
          const i = e.currentTarget;
          if (ep.videoId && !i.dataset.f) { i.dataset.f = "1"; i.src = `https://i.ytimg.com/vi/${ep.videoId}/mqdefault.jpg`; } else i.style.visibility = "hidden";
        }} /> : <div className="cover-fallback" />}
        {ep.videoId && ep.duration ? <span className="thumb-dur">{clockShort(ep.duration)}</span> : null}
        {pct > 0 && <span className="thumb-bar"><span style={{ width: `${pct}%` }} /></span>}
      </div>
      <div className="ep-body-col">
        <p className="ep-kicker">
          {showShow && ep.showId !== "single" && <ShowName title={ep.showTitle} />}
          <span>{date(ep.published)}</span>
          {ep.duration ? <span>{duration(ep.duration)}</span> : null}
        </p>
        <p className="ep-title2">{zh ?? ep.title}</p>
        {zh && zh !== ep.title && <p className="ep-orig">{ep.title}</p>}
        {(deep || ep.hasTranscript || ep.videoId || pct > 0) && (
          <p className="ep-tags">
            {deep && <span className="tag deep">精读</span>}
            {ep.hasTranscript && <span className="tag">字幕</span>}
            {ep.videoId && <span className="tag">视频</span>}
            {pct > 0 && pct < 97 && <span className="tag progress"><span className="mini-bar"><span style={{ width: `${pct}%` }} /></span>剩 {Math.max(1, Math.round(((ep.duration ?? 0) - ep.progress) / 60))} 分钟</span>}
            {pct >= 97 && <span className="tag">已听完</span>}
          </p>
        )}
      </div>
    </div>
  );
}

function groupLabel(ms?: number | null): string {
  if (!ms) return "更早";
  const d = new Date(ms), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return "本周";
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return "本月";
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1} 月` : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

const clockShort = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60); return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };

function EpisodeList({ episodes, showShow, grouped = true }: { episodes: Episode[] | null; showShow: boolean; grouped?: boolean }) {
  if (episodes == null) return <SkeletonFeed />;
  if (!episodes.length) return <div className="panel-empty"><p className="muted">这里还没有内容</p></div>;
  if (!grouped) return <div className="ep-feed">{episodes.map((e) => <EpisodeRow key={e.id} ep={e} showShow={showShow} />)}</div>;
  const groups: { label: string; items: Episode[] }[] = [];
  for (const e of episodes) {
    const label = groupLabel(e.published);
    if (groups[groups.length - 1]?.label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(e);
  }
  return (
    <div className="ep-feed">
      {groups.map((g) => (
        <section key={g.label} className="ep-group">
          <h3 className="ep-group-h">{g.label}</h3>
          {g.items.map((e) => <EpisodeRow key={e.id} ep={e} showShow={showShow} />)}
        </section>
      ))}
    </div>
  );
}

// ---- home ---------------------------------------------------------------------------------------

function ContinueHero({ ep }: { ep: Episode }) {
  const openEpisode = useStore((s) => s.openEpisode);
  const zh = useZh(ep.title);
  const pct = ep.duration ? Math.min(100, (ep.progress / ep.duration) * 100) : 0;
  const left = ep.duration ? Math.max(1, Math.round((ep.duration - ep.progress) / 60)) : 0;
  return (
    <div className="hero" role="button" tabIndex={0} onClick={() => openEpisode(ep)} onKeyDown={(e) => e.key === "Enter" && openEpisode(ep)}>
      {ep.cover ? <img className={ep.videoId ? "wide" : ""} src={ep.cover} alt="" /> : <div className="cover-fallback" />}
      <div className="hero-meta">
        <p className="meta-line">继续收听{ep.showTitle && ep.showId !== "single" ? <> · <ShowName title={ep.showTitle} /></> : null}</p>
        <p className="hero-title">{zh ?? ep.title}</p>
        {zh && zh !== ep.title && <p className="orig-line clamp1">{ep.title}</p>}
        <div className="hero-foot">
          <div className="hero-bar"><div style={{ width: `${pct}%` }} /></div>
          {left > 0 && <span className="muted small">还剩 {left} 分钟</span>}
          <button className="btn primary sm" onClick={(e) => { e.stopPropagation(); openEpisode(ep); setTimeout(() => useStore.getState().player?.play(), 600); }}><Play size={13} /> 继续播放</button>
        </div>
      </div>
    </div>
  );
}

function ShowTile({ show }: { show: Show }) {
  const go = useStore((s) => s.go);
  const { zh, orig } = useShowName(show.title);
  return (
    <div className="show-tile" role="button" tabIndex={0} onClick={() => go({ kind: "show", id: show.id })} onKeyDown={(e) => e.key === "Enter" && go({ kind: "show", id: show.id })}>
      <div className="tile-cover">{show.cover ? <img src={show.cover} alt="" loading="lazy" /> : <div className="cover-fallback">{orig.slice(0, 1)}</div>}</div>
      <p className="tile-name clamp1">{zh ?? orig}</p>
      {zh && <p className="tile-sub clamp1">{orig}</p>}
    </div>
  );
}

export function LatestView() {
  const { shows, settings, set, go } = useStore();
  const [eps, setEps] = useState<Episode[] | null>(null);
  const [recent, setRecent] = useState<Episode | null>(null);
  const [limit, setLimit] = useState(40);
  useEffect(() => {
    api.listEpisodes(undefined, 200).then(setEps);
    api.recentEpisodes().then((r) => setRecent(r.find((e) => e.progress > 5 && (!e.duration || e.progress < e.duration * 0.97)) ?? null));
  }, [shows]);
  if (!shows.length && !settings.onboarded) return <Onboarding />;
  return (
    <div className="page">
      {recent && <ContinueHero ep={recent} />}
      <section>
        <h2 className="module-title" role="button" tabIndex={0} onClick={() => go({ kind: "discover" })}>订阅节目 <ChevronRight size={16} /></h2>
        <div className="tile-strip">
          {shows.slice(0, 12).map((s) => <ShowTile key={s.id} show={s} />)}
          <div className="show-tile add" role="button" tabIndex={0} onClick={() => set({ addOpen: true })}><div className="tile-cover dashed"><Plus size={22} /></div><p className="tile-name">添加</p></div>
        </div>
      </section>
      <section>
        <h2 className="module-title">最新单集</h2>
        {!shows.length ? <div className="panel-empty"><p className="muted">还没有订阅节目</p><button className="btn primary" onClick={() => go({ kind: "discover" })}>去发现节目</button></div>
          : <EpisodeList episodes={eps?.slice(0, limit) ?? null} showShow />}
        {eps && eps.length > limit && <div className="center"><button className="btn" onClick={() => setLimit(limit + 40)}>加载更多</button></div>}
      </section>
    </div>
  );
}

export function RecentView() {
  const [eps, setEps] = useState<Episode[] | null>(null);
  useEffect(() => { api.recentEpisodes().then(setEps); }, []);
  return (
    <div className="page">
      <div className="page-head"><h1 className="page-title">继续收听</h1></div>
      <EpisodeList episodes={eps} showShow grouped={false} />
    </div>
  );
}

// ---- show page ----------------------------------------------------------------------------------

type Filter = "all" | "unplayed" | "subs";

export function ShowView({ id }: { id: string }) {
  const { shows, reloadShows, notify, go } = useStore();
  const show = shows.find((s) => s.id === id);
  const [eps, setEps] = useState<Episode[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState(false);
  const [showOrig, setShowOrig] = useState(false);
  const [menu, setMenu] = useState(false);
  const names = useShowName(show?.title ?? "");
  const desc = (show?.description ?? "").replace(/<[^>]+>/g, "").trim().slice(0, 1500);
  const descZh = useZh(desc);
  useEffect(() => { setEps(null); api.listEpisodes(id).then(setEps); }, [id]);
  const byFilter = useMemo(() => eps?.filter((e) => filter === "all" || (filter === "unplayed" ? e.progress < 5 : e.hasTranscript || e.transcriptUrl)) ?? null, [eps, filter]);
  const { month, setMonth, filtered: shown } = useMonthFilter(byFilter);
  if (!show) return <div className="page" />;
  const refresh = async () => {
    setBusy(true);
    try { await api.refreshShow(id); setEps(await api.listEpisodes(id)); await reloadShows(); } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    setMenu(false);
    if (!window.confirm(`取消订阅「${show.title}」？已生成的字幕会保留。`)) return;
    await api.removeShow(id); await reloadShows(); go({ kind: "latest" });
  };
  const descText = showOrig || !descZh ? desc : descZh;
  return (
    <div className="page">
      <div className="show-head">
        {show.cover ? <img src={show.cover} alt="" /> : <div className="cover-fallback" />}
        <div className="show-info">
          <p className="meta-line">{show.kind === "youtube" ? "YouTube 频道" : show.kind === "xiaoyuzhou" ? "小宇宙" : "播客"}{show.author && show.author !== show.title ? ` · ${show.author}` : ""}</p>
          <h1 className="show-title-h">{names.zh ?? names.orig}</h1>
          {(names.zh || names.orig !== show.title) && <span className="orig-line clamp1">{show.title}</span>}
          {desc && (
            <>
              <p className={`show-desc ${expanded ? "" : "clamp3"}`}>{descText}</p>
              <div className="row-actions tight">
                <button className="link-btn" onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "展开"}<ChevronDown size={12} className={expanded ? "flip" : ""} /></button>
                {descZh && <button className="link-btn" onClick={() => setShowOrig(!showOrig)}>{showOrig ? "看中文" : "查看原文"}</button>}
              </div>
            </>
          )}
          <div className="row-actions">
            <button className="btn sm" onClick={refresh} disabled={busy}>{busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} 检查更新</button>
            <div className="menu-wrap">
              <button className="btn ghost sm" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}><MoreHorizontal size={14} /> 更多</button>
              {menu && <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}><button role="menuitem" onClick={remove}>取消订阅</button></div>}
            </div>
          </div>
        </div>
      </div>
      {show.kind !== "qiaomu" && deepPickFor(show.title) && (
        <div className="deep-hint" role="button" tabIndex={0} onClick={() => go({ kind: "channel", input: deepPickFor(show.title)!.input })}>
          <BookOpen size={16} />
          <div><p className="deep-hint-t">这档节目有乔木精读版</p><p className="muted small">中文标题、每期精读长文和原文文稿，点击查看</p></div>
          <ChevronRight size={16} className="muted" />
        </div>
      )}
      <div className="list-head">
        <h2 className="section-title flush">全部单集</h2>
        <div className="seg-control">
          {([["all", "全部"], ["unplayed", "未听"], ["subs", "有字幕"]] as [Filter, string][]).map(([k, label]) => (
            <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
      </div>
      <MonthFilter episodes={byFilter} month={month} onChange={setMonth} />
      <EpisodeList episodes={shown} showShow={false} />
    </div>
  );
}

// ---- picks: onboarding and discover --------------------------------------------------------------

function PickCard({ p, selected, subscribed, onClick, onOpen, action }: { p: Pick; selected?: boolean; subscribed: boolean; onClick?: () => void; onOpen?: () => void; action?: React.ReactNode }) {
  const press = onClick ?? onOpen;
  return (
    <div className={`pick-tile ${selected ? "selected" : ""} ${subscribed ? "done" : ""}`} role={press ? "button" : undefined} tabIndex={press ? 0 : undefined} aria-pressed={onClick ? selected : undefined}
      onClick={press} onKeyDown={(e) => press && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), press())}>
      <div className="tile-cover">
        <img src={p.cover} alt="" loading="lazy" />
        {p.deep ? <span className="tile-badge deep">精读</span> : p.video && <span className="tile-badge"><Youtube size={11} /> 视频</span>}
        {onClick ? <span className={`pick-check ${selected ? "on" : ""}`}>{selected && <Check size={13} strokeWidth={3} />}</span> : <div className="tile-action">{action}</div>}
      </div>
      <p className="tile-name clamp1">{p.zh}</p>
      <p className="tile-sub clamp1">{p.zh !== p.title ? p.title : p.by}</p>
      <p className="pick-intro">{p.intro}</p>
    </div>
  );
}

function TopicChips({ topics, setTopics }: { topics: Topic[]; setTopics: (t: Topic[]) => void }) {
  const toggle = (t: Topic) => setTopics(topics.includes(t) ? topics.filter((x) => x !== t) : [...topics, t]);
  return (
    <div className="chips left">
      <button className={`chip ${topics.length === 0 ? "on" : ""}`} onClick={() => setTopics([])}>全部</button>
      {TOPICS.map((t) => <button key={t} className={`chip ${topics.includes(t) ? "on" : ""}`} onClick={() => toggle(t)}>{t}</button>)}
    </div>
  );
}

const visible = (topics: Topic[]) => PICKS.filter((p) => !topics.length || p.topics.some((t) => topics.includes(t)));

function Onboarding() {
  const { reloadShows, saveSettings, set, notify } = useStore();
  const [topics, setTopics] = useState<Topic[]>(["AI 前沿", "创业投资"]);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(["no-priors", "lex", "zhang", "latetalk"]));
  const [progress, setProgress] = useState<string | null>(null);
  const toggle = (id: string) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const start = async () => {
    const picks = PICKS.filter((p) => chosen.has(p.id));
    let ok = 0;
    for (const p of picks) {
      setProgress(`正在订阅 ${p.zh}…（${ok + 1}/${picks.length}）`);
      try { await api.addSubscription(p.input); ok++; } catch { /* keep going with the rest */ }
    }
    await reloadShows();
    await saveSettings({ onboarded: true });
    setProgress(null);
    notify(ok === picks.length ? "点任意一集，中文字幕会自动准备好" : `订阅了 ${ok} 个，${picks.length - ok} 个暂时连不上，可稍后在「发现」里重试`);
  };
  return (
    <div className="page onboarding">
      <h1 className="hero-title">先挑几个想听的节目</h1>
      <p className="hero-sub">订阅后自动拉取最新几集，字幕和中文翻译开箱即用。</p>
      <TopicChips topics={topics} setTopics={setTopics} />
      <div className="tile-grid">
        {visible(topics).map((p) => <PickCard key={p.id} p={p} selected={chosen.has(p.id)} subscribed={false} onClick={() => toggle(p.id)} />)}
      </div>
      <div className="onboard-bar">
        <span className="muted">{progress ?? `已选 ${chosen.size} 个`}</span>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => set({ addOpen: true })} disabled={!!progress}><Link2 size={14} /> 我有自己的链接</button>
        <button className="btn primary" onClick={start} disabled={!chosen.size || !!progress}>{progress ? <Loader2 size={14} className="spin" /> : null} 开始收听</button>
      </div>
    </div>
  );
}

export function DiscoverView() {
  const { shows, reloadShows, notify, go } = useStore();
  const [adding, setAdding] = useState<string | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const subscribed = (p: Pick) => isSubscribed(p, shows);
  const add = async (input: string, title: string) => {
    setAdding(input);
    try {
      const r = await api.addSubscription(input);
      await reloadShows();
      if (r.show) { notify(`已订阅「${title}」`); go({ kind: "show", id: r.show.id }); }
    } catch (err) { notify(errorText(err)); } finally { setAdding(null); }
  };
  const SubBtn = ({ input, title, done }: { input: string; title: string; done: boolean }) => done
    ? <span className="tile-done" title="已订阅"><Check size={16} /></span>
    : <button className="tile-add" title="订阅" onClick={(e) => { e.stopPropagation(); void add(input, title); }} disabled={adding != null}>{adding === input ? <Loader2 size={16} className="spin" /> : <Plus size={18} />}</button>;
  return (
    <div className="page">
      <h1 className="page-title">发现</h1>
      <p className="muted page-sub">精选海外与中文好节目，订阅后字幕和中文翻译开箱即用。想找别的节目，用上方搜索框。</p>
      <TopicChips topics={topics} setTopics={setTopics} />
      <div className="tile-grid">
        {visible(topics).map((p) => <PickCard key={p.id} p={p} subscribed={subscribed(p)} onOpen={() => go({ kind: "channel", input: p.input })} action={<SubBtn input={p.input} title={p.zh} done={subscribed(p)} />} />)}
      </div>
    </div>
  );
}

/** A channel before subscribing: what it is, its latest episodes (playable), and one clear subscribe button. */
export function ChannelView({ input }: { input: string }) {
  const { shows, reloadShows, notify, go } = useStore();
  const pick = PICKS.find((p) => sameFeed(p.input, input));
  const sub = shows.find((s) => sameFeed(s.feedUrl, input) || (pick?.deep && sameFeed(s.feedUrl, pick.input)));
  const [data, setData] = useState<{ show: Show; episodes: Episode[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const names = useShowName(data?.show.title ?? pick?.title ?? "");
  const { month, setMonth, filtered: shownCh } = useMonthFilter(data?.episodes ?? null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let live = true;
    setData(null); setError(null);
    // Stale-while-revalidate: show the saved copy at once, refresh from the network if it is older than 30 minutes.
    api.cachedShow(input).then((cached) => {
      if (!live) return;
      if (cached) setData(cached);
      if (cached && Date.now() - cached.fetchedAt < 30 * 60_000) return;
      setRefreshing(true);
      api.previewShow(input).then((d) => live && setData(d)).catch((e) => live && !cached && setError(errorText(e))).finally(() => live && setRefreshing(false));
    });
    return () => { live = false; };
  }, [input]);
  const subscribe = async () => {
    setBusy(true);
    try {
      const r = await api.addSubscription(input);
      await reloadShows();
      if (r.show) { notify(`已订阅「${pick?.zh ?? r.show.title}」`); go({ kind: "show", id: r.show.id }); }
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  };
  const cover = pick?.cover ?? data?.show.cover;
  const desc = pick?.intro ?? (data?.show.description ?? "").replace(/<[^>]+>/g, "").trim().slice(0, 300);
  return (
    <div className="page">
      <div className="show-head">
        {cover ? <img src={cover} alt="" /> : <div className="cover-fallback" />}
        <div className="show-info">
          <p className="meta-line">{pick?.deep ? "乔木精读 · 中文标题、精读长文与原文文稿" : pick?.by ?? data?.show.author ?? "频道"}</p>
          <h1 className="show-title-h">{pick?.zh ?? names.zh ?? names.orig}</h1>
          {(pick ? pick.zh !== pick.title : names.zh) && <span className="orig-line clamp1">{pick?.title ?? data?.show.title}</span>}
          {desc && <p className="show-desc clamp3">{desc}</p>}
          <div className="row-actions">
            {sub
              ? <button className="btn sm" onClick={() => go({ kind: "show", id: sub.id })}><Check size={13} /> 已订阅 · 查看</button>
              : <button className="btn primary" onClick={subscribe} disabled={busy}>{busy ? <Loader2 size={14} className="spin" /> : <Plus size={15} />} 订阅</button>}
            {data && <span className="muted small">{data.episodes.length} 期节目 · 不订阅也可以直接收听{refreshing ? " · 正在更新…" : ""}</span>}
          </div>
        </div>
      </div>
      {error ? <div className="panel-empty"><p className="error-text">{error}</p></div> : <>
        <MonthFilter episodes={data?.episodes ?? null} month={month} onChange={setMonth} />
        <EpisodeList episodes={shownCh} showShow={false} />
      </>}
    </div>
  );
}

export function showIcon(show: Show) {
  return show.cover ? <img src={show.cover} alt="" loading="lazy" /> : <div className="cover-fallback">{show.title.slice(0, 1)}</div>;
}
