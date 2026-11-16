import { useEffect, useState } from "react";
import { Captions, Check, Loader2, Plus, RefreshCw, Search, Trash2, Youtube } from "lucide-react";
import { api, errorText, type Episode, type SearchResult, type Show } from "../lib/api";
import { date, duration } from "../lib/format";
import { useStore } from "../store";

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
        <p className="ep-name">{ep.title}</p>
        <p className="muted small">
          {showShow && ep.showTitle && ep.showId !== "single" ? <span className="show-name">{ep.showTitle}</span> : null}
          {date(ep.published)}{ep.duration ? ` · ${duration(ep.duration)}` : ""}
          {ep.videoId && <span className="badge"><Youtube size={11} /> 视频</span>}
          {(ep.hasTranscript || ep.transcriptUrl) && <span className="badge ok"><Captions size={11} /> 有字幕</span>}
        </p>
      </div>
    </div>
  );
}

export function EpisodeList({ title, episodes, showShow, header }: { title?: string; episodes: Episode[] | null; showShow: boolean; header?: React.ReactNode }) {
  return (
    <div className="page">
      {header ?? <h2 className="page-title">{title}</h2>}
      {episodes == null ? <div className="panel-empty"><Loader2 className="spin" /></div> : episodes.length === 0 ? (
        <div className="panel-empty"><p className="muted">这里还没有内容</p></div>
      ) : (
        <div className="ep-list">{episodes.map((e) => <EpisodeRow key={e.id} ep={e} showShow={showShow} />)}</div>
      )}
    </div>
  );
}

export function LatestView() {
  const shows = useStore((s) => s.shows);
  const set = useStore((s) => s.set);
  const [eps, setEps] = useState<Episode[] | null>(null);
  useEffect(() => { api.listEpisodes(undefined, 120).then(setEps); }, [shows]);
  if (!shows.length) {
    return (
      <div className="page welcome">
        <h1>声渡 <span className="muted">SubCast</span></h1>
        <p className="lead">听懂海外播客和 YouTube：官方字幕优先，没有就本机识别；AI 译成中文，对照着听，还能直接问节目。</p>
        <div className="welcome-actions">
          <button className="btn primary" onClick={() => set({ addOpen: true })}><Plus size={15} /> 添加订阅或粘贴链接</button>
          <button className="btn" onClick={() => useStore.getState().go({ kind: "discover" })}><Search size={15} /> 发现节目</button>
        </div>
        <p className="muted small">提示：问答和翻译需要先在「设置」里填写一个模型服务的 API Key（推荐 DeepSeek，国内可直连）。</p>
      </div>
    );
  }
  return <EpisodeList title="最新" episodes={eps} showShow />;
}

export function RecentView() {
  const [eps, setEps] = useState<Episode[] | null>(null);
  useEffect(() => { api.recentEpisodes().then(setEps); }, []);
  return <EpisodeList title="继续收听" episodes={eps} showShow />;
}

export function ShowView({ id }: { id: string }) {
  const { shows, reloadShows, notify, go } = useStore();
  const show = shows.find((s) => s.id === id);
  const [eps, setEps] = useState<Episode[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setEps(null); api.listEpisodes(id).then(setEps); }, [id]);
  if (!show) return <div className="page" />;
  const refresh = async () => {
    setBusy(true);
    try { await api.refreshShow(id); setEps(await api.listEpisodes(id)); await reloadShows(); } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm(`取消订阅「${show.title}」？已生成的字幕会保留。`)) return;
    await api.removeShow(id); await reloadShows(); go({ kind: "latest" });
  };
  const header = (
    <div className="show-head">
      {show.cover ? <img src={show.cover} alt="" /> : <div className="cover-fallback" />}
      <div className="show-info">
        <p className="muted small">{show.kind === "youtube" ? "YouTube 频道" : show.kind === "xiaoyuzhou" ? "小宇宙" : "播客"}{show.author && show.author !== show.title ? ` · ${show.author}` : ""}</p>
        <h2>{show.title}</h2>
        {show.description && <p className="muted clamp">{show.description.replace(/<[^>]+>/g, "")}</p>}
        <div className="row-actions">
          <button className="btn sm" onClick={refresh} disabled={busy}>{busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} 检查更新</button>
          <button className="btn ghost sm" onClick={remove}><Trash2 size={13} /> 取消订阅</button>
        </div>
      </div>
    </div>
  );
  return <EpisodeList episodes={eps} showShow={false} header={header} />;
}

const PICKS: { title: string; by: string; input: string; tag: string }[] = [
  { title: "Dwarkesh Podcast", by: "Dwarkesh Patel", input: "https://www.youtube.com/@DwarkeshPatel", tag: "AI · YouTube" },
  { title: "Lex Fridman Podcast", by: "Lex Fridman", input: "https://www.youtube.com/@lexfridman", tag: "访谈 · YouTube" },
  { title: "Latent Space", by: "swyx & Alessio", input: "https://api.substack.com/feed/podcast/1084089.rss", tag: "AI 工程" },
  { title: "No Priors", by: "Sarah Guo & Elad Gil", input: "https://feeds.megaphone.fm/nopriors", tag: "AI 创业" },
  { title: "Training Data", by: "Sequoia Capital", input: "https://feeds.megaphone.fm/trainingdata", tag: "AI 投资" },
  { title: "The Cognitive Revolution", by: "Nathan Labenz", input: "https://feeds.megaphone.fm/RINTP3108857801", tag: "AI" },
  { title: "Y Combinator", by: "YC", input: "https://www.youtube.com/@ycombinator", tag: "创业 · YouTube" },
  { title: "张小珺｜商业访谈录", by: "张小珺", input: "https://feed.xyzfm.space/dk4yh3pkpjp3", tag: "中文" },
  { title: "硅谷101", by: "泓君", input: "https://www.xiaoyuzhoufm.com/podcast/5e5c52c9418a84a04625e6cc", tag: "中文 · 小宇宙" },
];

export function DiscoverView() {
  const { shows, reloadShows, notify, go } = useStore();
  const [term, setTerm] = useState("");
  const [country, setCountry] = useState("US");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const subscribed = new Set(shows.map((s) => s.feedUrl));
  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!term.trim()) return;
    setLoading(true);
    try { setResults(await api.searchPodcasts(term.trim(), country)); } catch (err) { notify(errorText(err)); } finally { setLoading(false); }
  };
  const add = async (input: string) => {
    setAdding(input);
    try {
      const r = await api.addSubscription(input);
      await reloadShows();
      if (r.show) { notify(`已订阅「${r.show.title}」`); go({ kind: "show", id: r.show.id }); }
    } catch (err) { notify(errorText(err)); } finally { setAdding(null); }
  };
  const Item = ({ title, by, cover, input, tag }: { title: string; by: string; cover?: string; input: string; tag?: string }) => (
    <div className="pick">
      {cover ? <img src={cover} alt="" loading="lazy" /> : <div className="cover-fallback">{title.slice(0, 1)}</div>}
      <div className="pick-meta"><p className="ep-name">{title}</p><p className="muted small">{by}{tag ? ` · ${tag}` : ""}</p></div>
      {subscribed.has(input) ? <span className="muted small"><Check size={14} /> 已订阅</span> : (
        <button className="btn sm" onClick={() => add(input)} disabled={adding != null}>{adding === input ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} 订阅</button>
      )}
    </div>
  );
  return (
    <div className="page">
      <h2 className="page-title">发现</h2>
      <form className="search-box" onSubmit={search}>
        <Search size={16} />
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="搜索播客（Apple Podcasts 目录）" />
        <select value={country} onChange={(e) => setCountry(e.target.value)} aria-label="地区">
          <option value="US">美国</option><option value="GB">英国</option><option value="CN">中国</option><option value="JP">日本</option>
        </select>
        <button className="btn primary sm" type="submit" disabled={loading}>{loading ? <Loader2 size={13} className="spin" /> : "搜索"}</button>
      </form>
      {results && (
        <section>
          <h3 className="section-title">搜索结果</h3>
          {results.length === 0 ? <p className="muted">没有找到，换个关键词或地区试试</p> : <div className="pick-grid">{results.map((r) => <Item key={r.feedUrl} title={r.title} by={r.author} cover={r.cover} input={r.feedUrl} tag={r.genre} />)}</div>}
        </section>
      )}
      <section>
        <h3 className="section-title">推荐</h3>
        <div className="pick-grid">{PICKS.map((p) => <Item key={p.input} title={p.title} by={p.by} input={p.input} tag={p.tag} />)}</div>
      </section>
    </div>
  );
}

export function showIcon(show: Show) {
  return show.cover ? <img src={show.cover} alt="" loading="lazy" /> : <div className="cover-fallback">{show.title.slice(0, 1)}</div>;
}
