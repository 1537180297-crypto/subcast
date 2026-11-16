import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Compass, History, Inbox, Link2, Loader2, PanelLeftClose, PanelLeftOpen, Pause, Play, Plus, Search, Settings as Cog, X } from "lucide-react";
import { api, errorText, type SearchResult } from "../lib/api";
import { useStore, type View } from "../store";
import { PICKS, deepPickFor, isSubscribed, showName } from "../lib/picks";
import { useShowName } from "../lib/zh";
import { useJobs } from "../lib/jobs";
import { BiTitle, ZhText } from "./Bi";
import { useLayout } from "../lib/layout";
import logoUrl from "../assets/logo.png";
import { showIcon } from "./Lists";

export function Sidebar() {
  const { shows, view, go, set } = useStore();
  const is = (v: View) => view.kind === v.kind && (v.kind !== "show" || (view.kind === "show" && view.id === v.id)) && (v.kind !== "channel" || (view.kind === "channel" && view.input === v.input));
  // A 精读 channel is listed once: hidden here when its show is already followed (either version).
  const curated = PICKS.filter((p) => p.deep && !isSubscribed(p, shows) && !shows.some((s) => deepPickFor(s.title)?.id === p.id));
  const { sideOpen, put: putLayout } = useLayout();
  const rail = !sideOpen;
  const Nav = ({ v, icon, label }: { v: View; icon: React.ReactNode; label: string }) => (
    <button className={`nav ${is(v) ? "on" : ""}`} onClick={() => go(v)} title={rail ? label : undefined} aria-label={label}>{icon}<span className="label">{label}</span></button>
  );
  return (
    <aside className={`sidebar ${rail ? "rail" : ""}`}>
      <div className="traffic-space" data-tauri-drag-region />
      <div className="brand" data-tauri-drag-region>
        <img className="logo-img" src={logoUrl} alt="" />
        <p className="brand-name">SubCast</p>
      </div>
      <nav>
        <Nav v={{ kind: "latest" }} icon={<Inbox size={16} />} label="首页" />
        <Nav v={{ kind: "recent" }} icon={<History size={16} />} label="继续收听" />
        <Nav v={{ kind: "discover" }} icon={<Compass size={16} />} label="发现" />
      </nav>
      <div className="side-sep" />
      <div className="side-head"><span className="label">订阅</span><button className="icon-btn sm" title="添加节目" onClick={() => set({ addOpen: true })}><Plus size={14} /></button></div>
      <div className="show-list">
        {shows.map((s) => (
          <button key={s.id} className={`show-item ${is({ kind: "show", id: s.id }) ? "on" : ""}`} onClick={() => go({ kind: "show", id: s.id })} title={rail ? showName(s.title) : s.title}>
            <span className="show-cover">{showIcon(s)}{rail && s.unplayed > 0 && <span className="rail-dot" />}</span>
            <SideName title={s.title} />
            {s.unplayed > 0 && <span className="unplayed">{s.unplayed > 99 ? "99+" : s.unplayed}</span>}
          </button>
        ))}
        {!shows.length && <p className="muted small side-empty">还没有订阅</p>}
        {curated.length > 0 && <>
          <div className="side-head second"><span className="label">乔木精读</span></div>
          {curated.map((p) => (
            <button key={p.id} className={`show-item curated ${is({ kind: "channel", input: p.input }) ? "on" : ""}`} onClick={() => go({ kind: "channel", input: p.input })} title={`${p.zh} · 点击查看，决定是否订阅`}>
              <span className="show-cover"><img src={p.cover} alt="" loading="lazy" /></span>
              <span className="show-names"><span className="show-title">{p.zh}</span>{p.zh !== p.title && <span className="show-orig">{p.title}</span>}</span>
            </button>
          ))}
        </>}
      </div>
      <TaskChip />
      <div className="side-foot">
        <button className="nav settings-btn" onClick={() => useStore.getState().openSettings()} title={rail ? "设置" : undefined} aria-label="设置"><Cog size={16} /><span className="label">设置</span></button>
        <button className="icon-btn side-toggle" onClick={() => putLayout({ sideOpen: rail })} title={rail ? "展开侧栏（⌘B）" : "收起为图标（⌘B）"} aria-label={rail ? "展开侧栏" : "收起侧栏"}>{rail ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
      </div>
    </aside>
  );
}

const PLACEHOLDERS = ["粘贴 YouTube / 小宇宙 / 播客链接，或搜索节目名", "试试搜 Lex Fridman", "粘贴一个 YouTube 视频链接，直接看双语字幕"];
const placeholder = PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)];
const looksLikeLink = (t: string) => /^(https?:\/\/|@)|youtube\.com|youtu\.be|xiaoyuzhoufm\.com|feed\.xyzfm\.space|podcasts\.apple\.com|\.(xml|rss)\b/i.test(t.trim());

/** The bar above every page: back, one search box that subscribes to pasted links or searches by name, settings. */
export function TopBar() {
  const { history, back, reloadShows, go, openEpisode, notify, shows } = useStore();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const link = looksLikeLink(q);
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!q.trim() || link) { setResults(null); return; }
    timer.current = window.setTimeout(async () => {
      setBusy(true);
      try { setResults((await api.searchPodcasts(q.trim(), /[\u4e00-\u9fff]/.test(q) ? "CN" : "US")).slice(0, 8)); } catch { setResults([]); } finally { setBusy(false); }
    }, 300);
  }, [q]);
  const subscribe = async (input: string) => {
    setAdding(input);
    try {
      const r = await api.addSubscription(input);
      setQ(""); setOpen(false); setResults(null);
      if (r.show) { await reloadShows(); notify(`已订阅「${r.show.title}」`); go({ kind: "show", id: r.show.id }); }
      else if (r.episode) openEpisode(r.episode);
    } catch (e) { notify(errorText(e)); } finally { setAdding(null); }
  };
  const submit = () => { if (link) void subscribe(q.trim()); else if (results?.[0]) void subscribe(results[0].feedUrl); };
  return (
    <div className="topbar" data-tauri-drag-region>
      <button className="round-btn" onClick={back} disabled={!history.length} aria-label="返回"><ChevronLeft size={18} /></button>
      <div className="search-wrap">
        <div className={`top-search ${open ? "focus" : ""}`}>
          {link ? <Link2 size={16} /> : <Search size={16} />}
          <input value={q} placeholder={placeholder} spellCheck={false} autoCapitalize="off" autoCorrect="off"
            onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") { setQ(""); (e.target as HTMLInputElement).blur(); } }} />
          {busy || adding ? <Loader2 size={14} className="spin" /> : link && <span className="kbd-hint">回车订阅</span>}
        </div>
        {open && results && (
          <div className="search-drop">
            {results.length === 0 ? <p className="muted small center">没有找到，换个关键词试试</p> : results.map((r) => {
              const done = shows.some((s) => s.feedUrl === r.feedUrl);
              return (
                <div key={r.feedUrl} className="drop-row" onMouseDown={(e) => e.preventDefault()}>
                  {r.cover ? <img src={r.cover} alt="" /> : <div className="cover-fallback">{r.title.slice(0, 1)}</div>}
                  <div className="drop-meta"><BiTitle text={r.title} className="ep-name" subClassName="clamp1" /><p className="meta-line clamp1">{r.author}</p></div>
                  {done ? <span className="sub-done">已订阅</span> : <button className="btn sm" onClick={() => subscribe(r.feedUrl)} disabled={adding != null}>{adding === r.feedUrl ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} 订阅</button>}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="spacer" data-tauri-drag-region />
    </div>
  );
}

function SideName({ title }: { title: string }) {
  const { zh, orig } = useShowName(title);
  return (
    <span className="show-names">
      <span className="show-title">{zh ?? orig}</span>
      {zh && <span className="show-orig">{orig}</span>}
    </span>
  );
}

/** A running transcription anywhere in the app, with a way back to its episode. */
function TaskChip() {
  const asr = useJobs((s) => s.asr);
  const go = useStore((s) => s.go);
  const running = Object.entries(asr).find(([, j]) => j.stage === "download" || j.stage === "transcribe");
  if (!running) return null;
  const [id, job] = running;
  return (
    <button className="task-chip" onClick={() => go({ kind: "episode", id })}>
      <Loader2 size={13} className="spin" /> {job.stage === "download" ? (job.message ?? "正在准备") : "正在生成字幕"} · {Math.round(job.progress * 100)}%
    </button>
  );
}

export function MiniPlayer() {
  const { current, view, playing, player, time, length, openEpisode } = useStore();
  if (!current || current.videoId || (view.kind === "episode" && view.id === current.id)) return null;
  return (
    <div className="mini">
      <button className="play-btn sm" onClick={() => player?.toggle()} disabled={!player}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
      {current.cover && <img className="mini-cover" src={current.cover} alt="" />}
      <div className="mini-meta" role="button" tabIndex={0} onClick={() => openEpisode(current)}>
        <p className="ep-name"><ZhText text={current.title} /></p>
        {current.showTitle && current.showId !== "single" && <p className="meta-line">{showName(current.showTitle)}</p>}
        <div className="bar"><div style={{ width: `${length ? (time / length) * 100 : 0}%` }} /></div>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h3>{title}</h3><button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function AddDialog() {
  const { set, reloadShows, go, openEpisode, notify } = useStore();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => set({ addOpen: false });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    setBusy(true); setError(null);
    try {
      const r = await api.addSubscription(input);
      close();
      if (r.show) { await reloadShows(); notify(`已订阅「${r.show.title}」`); go({ kind: "show", id: r.show.id }); }
      else if (r.episode) openEpisode(r.episode);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  return (
    <Modal title="添加节目" onClose={close}>
      <form onSubmit={submit} className="add-form">
        <input autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} placeholder="粘贴 YouTube / Apple Podcasts / 小宇宙 / RSS 链接" />
        {error && <p className="error-text">{error}</p>}
        <ul className="hints muted small">
          <li><b>YouTube</b> 频道（@名字 / 频道链接 / 播放列表），或单个视频链接</li>
          <li><b>Apple Podcasts</b> 节目链接</li>
          <li><b>小宇宙</b> 节目或单集链接</li>
          <li>任意播客 <b>RSS</b> 地址</li>
        </ul>
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={() => { close(); useStore.getState().go({ kind: "discover" }); }}>按名称搜索节目</button>
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={close}>取消</button>
          <button type="submit" className="btn primary" disabled={busy || !input.trim()}>{busy ? <><Loader2 size={14} className="spin" /> 正在读取…</> : "添加"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function Toast() {
  const toast = useStore((s) => s.toast);
  return toast ? <div className="toast" role="status">{toast}</div> : null;
}
