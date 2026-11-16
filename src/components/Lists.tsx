import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Link2, Loader2, MoreHorizontal, Plus, RefreshCw, Search, Youtube } from "lucide-react";
import { api, errorText, type Episode, type SearchResult, type Show } from "../lib/api";
import { date, duration } from "../lib/format";
import { PICKS, TOPICS, shortName, showName, type Pick, type Topic } from "../lib/picks";
import { useZh } from "../lib/zh";
import { useStore } from "../store";
import { BiTitle } from "./Bi";

// ---- episode rows -------------------------------------------------------------------------------

function Status({ ep }: { ep: Episode }) {
  const pct = ep.duration && ep.progress > 5 ? Math.round((ep.progress / ep.duration) * 100) : 0;
  return (
    <>
      {ep.hasTranscript ? <span className="dot-status ok">● 有字幕</span> : ep.transcriptUrl ? <span className="dot-status">○ 有字幕</span> : null}
      {pct > 0 && pct < 97 && <span className="dot-status">▶ 听到 {pct}%</span>}
      {ep.videoId && <span className="dot-status"><Youtube size={11} /> 视频</span>}
    </>
  );
}

function ShowName({ title }: { title?: string }) {
  if (!title) return null;
  return <span className="show-name">{showName(title)}</span>;
}

function EpisodeRow({ ep, showShow }: { ep: Episode; showShow: boolean }) {
  const openEpisode = useStore((s) => s.openEpisode);
  const current = useStore((s) => s.current);
  const pct = ep.duration && ep.progress ? Math.min(100, (ep.progress / ep.duration) * 100) : 0;
  return (
    <div className={`ep-row ${current?.id === ep.id ? "playing" : ""}`} role="button" tabIndex={0} onClick={() => openEpisode(ep)} onKeyDown={(e) => e.key === "Enter" && openEpisode(ep)}>
      <div className={`thumb ${ep.videoId ? "wide" : ""}`}>
        {ep.cover ? <img src={ep.cover} alt="" loading="lazy" /> : <div className="cover-fallback" />}
        {pct > 0 && <div className="thumb-progress"><div style={{ width: `${pct}%` }} /></div>}
      </div>
      <div className="ep-meta">
        <BiTitle text={ep.title} className="ep-name" subClassName="clamp1" />
        <p className="meta-line">
          {showShow && ep.showId !== "single" && <ShowName title={ep.showTitle} />}
          <span>{[date(ep.published), duration(ep.duration)].filter(Boolean).join(" · ")}</span>
          <Status ep={ep} />
        </p>
      </div>
    </div>
  );
}

function EpisodeList({ episodes, showShow }: { episodes: Episode[] | null; showShow: boolean }) {
  if (episodes == null) return <div className="panel-empty"><Loader2 className="spin" /></div>;
  if (!episodes.length) return <div className="panel-empty"><p className="muted">这里还没有内容</p></div>;
  return <div className="ep-list">{episodes.map((e) => <EpisodeRow key={e.id} ep={e} showShow={showShow} />)}</div>;
}

// ---- home ---------------------------------------------------------------------------------------

function ContinueCard({ ep }: { ep: Episode }) {
  const openEpisode = useStore((s) => s.openEpisode);
  const zh = useZh(ep.title);
  const pct = ep.duration ? Math.min(100, (ep.progress / ep.duration) * 100) : 0;
  return (
    <div className="continue-card" role="button" tabIndex={0} onClick={() => openEpisode(ep)} onKeyDown={(e) => e.key === "Enter" && openEpisode(ep)}>
      {ep.cover ? <img src={ep.cover} alt="" /> : <div className="cover-fallback" />}
      <p className="ep-name">{zh ?? ep.title}</p>
      <div className="continue-bar"><div style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function LatestView() {
  const { shows, reloadShows, notify, settings } = useStore();
  const [eps, setEps] = useState<Episode[] | null>(null);
  const [recent, setRecent] = useState<Episode[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.listEpisodes(undefined, 120).then(setEps);
    api.recentEpisodes().then((r) => setRecent(r.filter((e) => e.progress > 5 && (!e.duration || e.progress < e.duration * 0.97)).slice(0, 6)));
  }, [shows]);
  if (!shows.length && !settings.onboarded) return <Onboarding />;
  const refresh = async () => {
    setBusy(true);
    try { await api.refreshAll(); await reloadShows(); setEps(await api.listEpisodes(undefined, 120)); } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">首页</h1>
        <button className="btn ghost sm" onClick={refresh} disabled={busy}>{busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} 检查更新</button>
      </div>
      {recent.length > 0 && (
        <section>
          <h2 className="section-title">继续收听</h2>
          <div className="continue-strip">{recent.map((e) => <ContinueCard key={e.id} ep={e} />)}</div>
        </section>
      )}
      <h2 className="section-title">最新单集</h2>
      {!shows.length ? (
        <div className="panel-empty"><p className="muted">还没有订阅节目</p><button className="btn primary" onClick={() => useStore.getState().go({ kind: "discover" })}>去发现节目</button></div>
      ) : <EpisodeList episodes={eps} showShow />}
    </div>
  );
}

export function RecentView() {
  const [eps, setEps] = useState<Episode[] | null>(null);
  useEffect(() => { api.recentEpisodes().then(setEps); }, []);
  return (
    <div className="page">
      <div className="page-head"><h1 className="page-title">继续收听</h1></div>
      <EpisodeList episodes={eps} showShow />
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
  const desc = (show?.description ?? "").replace(/<[^>]+>/g, "").trim().slice(0, 1500);
  const descZh = useZh(desc);
  useEffect(() => { setEps(null); api.listEpisodes(id).then(setEps); }, [id]);
  const shown = useMemo(() => eps?.filter((e) => filter === "all" || (filter === "unplayed" ? e.progress < 5 : e.hasTranscript || e.transcriptUrl)) ?? null, [eps, filter]);
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
          <h1 className="show-title-h">{showName(show.title)}</h1>
          {shortName(show.title) !== show.title || !/[\u4e00-\u9fff]/.test(show.title) ? <span className="orig-line clamp1">{show.title}</span> : null}
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
      <div className="list-head">
        <h2 className="section-title flush">全部单集</h2>
        <div className="seg-control">
          {([["all", "全部"], ["unplayed", "未听"], ["subs", "有字幕"]] as [Filter, string][]).map(([k, label]) => (
            <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
      </div>
      <EpisodeList episodes={shown} showShow={false} />
    </div>
  );
}

// ---- picks: onboarding and discover --------------------------------------------------------------

function PickCard({ p, selected, subscribed, onClick, action }: { p: Pick; selected?: boolean; subscribed: boolean; onClick?: () => void; action?: React.ReactNode }) {
  return (
    <div className={`pick ${selected ? "selected" : ""} ${subscribed ? "done" : ""}`} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} aria-pressed={onClick ? selected : undefined}
      onClick={onClick} onKeyDown={(e) => onClick && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onClick())}>
      <img src={p.cover} alt="" loading="lazy" />
      <div className="pick-meta">
        <p className="ep-name">{p.zh}{p.video && <span className="dot-status"><Youtube size={11} /> 视频</span>}</p>
        <p className="meta-line clamp1">{p.zh !== p.title ? `${p.title} · ` : ""}{p.by}</p>
        <p className="pick-intro">{p.intro}</p>
      </div>
      {action ?? (onClick && <span className={`pick-check ${selected ? "on" : ""}`}>{selected && <Check size={13} strokeWidth={3} />}</span>)}
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
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(["dwarkesh", "no-priors", "zhang"]));
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
      <div className="pick-grid">
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
  const [term, setTerm] = useState("");
  const [country, setCountry] = useState("US");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const subscribed = (p: Pick) => shows.some((s) => s.feedUrl === p.input || s.title === p.title || shortName(s.title) === shortName(p.title));
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!term.trim()) { setResults(null); return; }
    timer.current = window.setTimeout(async () => {
      setLoading(true);
      try { setResults(await api.searchPodcasts(term.trim(), country)); } catch (err) { notify(errorText(err)); } finally { setLoading(false); }
    }, 350);
  }, [term, country]);
  const add = async (input: string, title: string) => {
    setAdding(input);
    try {
      const r = await api.addSubscription(input);
      await reloadShows();
      if (r.show) { notify(`已订阅「${title}」`); go({ kind: "show", id: r.show.id }); }
    } catch (err) { notify(errorText(err)); } finally { setAdding(null); }
  };
  const SubBtn = ({ input, title, done }: { input: string; title: string; done: boolean }) => done
    ? <span className="sub-done"><Check size={14} /> 已订阅</span>
    : <button className="btn sm" onClick={(e) => { e.stopPropagation(); void add(input, title); }} disabled={adding != null}>{adding === input ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} 订阅</button>;
  return (
    <div className="page">
      <div className="page-head"><h1 className="page-title">发现</h1></div>
      <div className="search-box">
        <Search size={16} />
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="搜索播客名称，例如 Lex Fridman、硅谷101" spellCheck={false} />
        {loading && <Loader2 size={14} className="spin" />}
        <select value={country} onChange={(e) => setCountry(e.target.value)} aria-label="地区">
          <option value="US">美国</option><option value="GB">英国</option><option value="CN">中国</option><option value="JP">日本</option>
        </select>
      </div>
      {results ? (
        <section>
          <h2 className="section-title">搜索结果</h2>
          {results.length === 0 ? <p className="muted">没有找到，换个关键词或地区试试</p> : (
            <div className="pick-grid">
              {results.map((r) => (
                <div className="pick" key={r.feedUrl}>
                  {r.cover ? <img src={r.cover} alt="" loading="lazy" /> : <div className="cover-fallback">{r.title.slice(0, 1)}</div>}
                  <div className="pick-meta"><BiTitle text={r.title} className="ep-name" subClassName="clamp1" /><p className="meta-line clamp1">{r.author}{r.genre ? ` · ${r.genre}` : ""}</p></div>
                  <SubBtn input={r.feedUrl} title={r.title} done={shows.some((s) => s.feedUrl === r.feedUrl)} />
                </div>
              ))}
            </div>
          )}
        </section>
      ) : (
        <section>
          <TopicChips topics={topics} setTopics={setTopics} />
          <div className="pick-grid">
            {visible(topics).map((p) => <PickCard key={p.id} p={p} subscribed={subscribed(p)} action={<SubBtn input={p.input} title={p.zh} done={subscribed(p)} />} />)}
          </div>
        </section>
      )}
    </div>
  );
}

export function showIcon(show: Show) {
  return show.cover ? <img src={show.cover} alt="" loading="lazy" /> : <div className="cover-fallback">{show.title.slice(0, 1)}</div>;
}
