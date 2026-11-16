import { useEffect, useState } from "react";
import { Compass, History, Inbox, Loader2, Pause, Play, Plus, Settings as Cog, X } from "lucide-react";
import { api, errorText } from "../lib/api";
import { useStore, type View } from "../store";
import { showIcon } from "./Lists";

export function Sidebar() {
  const { shows, view, go, set } = useStore();
  const is = (v: View) => view.kind === v.kind && (v.kind !== "show" || (view.kind === "show" && view.id === v.id));
  const Nav = ({ v, icon, label }: { v: View; icon: React.ReactNode; label: string }) => (
    <button className={`nav ${is(v) ? "on" : ""}`} onClick={() => go(v)}>{icon}<span>{label}</span></button>
  );
  return (
    <aside className="sidebar">
      <div className="brand" data-tauri-drag-region>
        <div className="logo">渡</div>
        <div><p className="brand-name">声渡</p><p className="brand-sub">SubCast</p></div>
      </div>
      <button className="btn primary add-btn" onClick={() => set({ addOpen: true })}><Plus size={15} /> 添加订阅</button>
      <nav>
        <Nav v={{ kind: "latest" }} icon={<Inbox size={16} />} label="最新" />
        <Nav v={{ kind: "recent" }} icon={<History size={16} />} label="继续收听" />
        <Nav v={{ kind: "discover" }} icon={<Compass size={16} />} label="发现" />
      </nav>
      <p className="side-label">我的订阅</p>
      <div className="show-list">
        {shows.map((s) => (
          <button key={s.id} className={`show-item ${is({ kind: "show", id: s.id }) ? "on" : ""}`} onClick={() => go({ kind: "show", id: s.id })} title={s.title}>
            <span className="show-cover">{showIcon(s)}</span>
            <span className="show-title">{s.title}</span>
          </button>
        ))}
        {!shows.length && <p className="muted small side-empty">还没有订阅</p>}
      </div>
      <button className="nav settings-btn" onClick={() => useStore.getState().openSettings()}><Cog size={16} /><span>设置</span></button>
    </aside>
  );
}

export function MiniPlayer() {
  const { current, view, playing, player, time, length, openEpisode } = useStore();
  if (!current || current.videoId || (view.kind === "episode" && view.id === current.id)) return null;
  return (
    <div className="mini">
      <button className="play-btn sm" onClick={() => player?.toggle()} disabled={!player}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
      <div className="mini-meta" role="button" tabIndex={0} onClick={() => openEpisode(current)}>
        <p className="ep-name">{current.title}</p>
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
    <Modal title="添加订阅或打开链接" onClose={close}>
      <form onSubmit={submit} className="add-form">
        <input autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} placeholder="粘贴链接，例如 https://www.youtube.com/@lexfridman" />
        {error && <p className="error-text">{error}</p>}
        <ul className="hints muted small">
          <li><b>YouTube</b> 频道（@名字 / 频道链接 / 播放列表），或单个视频链接</li>
          <li><b>Apple Podcasts</b> 节目链接</li>
          <li><b>小宇宙</b> 节目或单集链接</li>
          <li>任意播客 <b>RSS</b> 地址</li>
        </ul>
        <div className="modal-foot">
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
