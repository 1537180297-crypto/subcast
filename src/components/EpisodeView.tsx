import { ask } from "../lib/confirm";
import { useShallow } from "zustand/react/shallow";
import { TopBar } from "./Chrome";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { isChineseUi, lang, t, tk } from "../lib/i18n";

class PanelBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) { return { error: e.message }; }
  render() {
    return this.state.error ? (
      <div className="panel-empty"><p className="lead">{t("这里出了点问题")}</p><p className="muted small">{this.state.error}</p>
        <button className="btn" onClick={() => this.setState({ error: null })}>{t("重试")}</button></div>
    ) : this.props.children;
  }
}
import { ArrowDownToLine, BookOpen, Captions, ChevronDown, ScrollText, ExternalLink, Loader2, MessageCircle, PanelRightClose, PanelRightOpen, Play, WandSparkles, FolderOpen, Trash2, Youtube, Bookmark, Pause } from "lucide-react";
import { BookArt, DoneCheck, EmptyState } from "./Illustrations";
import { Splitter } from "./Splitter";
import { DeepRead } from "./DeepRead";
import { SkeletonEpisode } from "./Skeleton";
import { PANEL, useLayout } from "../lib/layout";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorText, llmChat, type Episode } from "../lib/api";
import { date, duration, notesText } from "../lib/format";
import { showName } from "../lib/picks";
import { isZh, useZh, useZhParagraphs } from "../lib/zh";
import { loadTranscript, useJobs } from "../lib/jobs";
import { providerFor, useStore } from "../store";
import { ChatPanel, SummaryPanel } from "./AiPanels";
import { Controls, YouTubePlayer } from "./Players";
import { bytes, cancelDownload, downloadEpisode, isSaved, removeDownload, useOffline } from "../lib/offline";
import { showLinks } from "../lib/showLinks";
import { toggleFavorite, useLibrary } from "../lib/library";
import { YtVideoStrip } from "./YtPromo";
import { activeIndex, TranscriptPanel } from "./TranscriptPanel";

type Tab = "transcript" | "deep" | "chat" | "summary";
const TAB_NAMES: Record<Tab, string> = { transcript: tk("字幕"), deep: tk("乔木精读"), chat: tk("AI 问答"), summary: tk("导读 · 节目简介与 AI 总结") };

/** Splits a long subtitle block into screen-sized pieces at word / punctuation boundaries. */
export function pieces(text: string, cjk: boolean): string[] {
  const max = cjk ? 26 : 60;
  const parts = cjk ? text.split(/(?<=[，。！？；：、,.!?;])/) : text.split(/(?<=\s)/);
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (cur && (cur + p).length > max) { out.push(cur.trim()); cur = ""; }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [text];
}

/** The piece being spoken now, assuming speech is spread evenly over the block. */
function pieceAt(text: string, cjk: boolean, progress: number): string {
  const ps = pieces(text, cjk);
  const total = ps.reduce((n, p) => n + p.length, 0);
  let acc = 0;
  for (const p of ps) { acc += p.length; if (acc / total >= progress) return p; }
  return ps[ps.length - 1];
}

function SubtitleOverlay({ ep }: { ep: Episode }) {
  const transcript = useJobs((s) => s.transcripts[ep.id]);
  const items = useJobs((s) => s.translations[ep.id]?.items);
  const time = useStore((s) => s.time);
  const mode = useStore((s) => s.settings.subtitleMode);
  if (!transcript) return null;
  const i = activeIndex(transcript.segments, time);
  const seg = transcript.segments[i];
  if (!seg || time > seg.end + 1.5) return null;
  const zh = items?.[i];
  const progress = Math.min(1, Math.max(0, (time - seg.start) / Math.max(0.5, seg.end - seg.start)));
  const cjk = /[\u4e00-\u9fff]/.test(seg.text);
  return (
    <div className="subtitle-overlay">
      {zh && mode !== "original" && <p className="sub-zh">{pieceAt(zh, true, progress)}</p>}
      {(mode !== "translation" || !zh) && <p className="sub-orig">{pieceAt(seg.text, cjk, progress)}</p>}
    </div>
  );
}

export function EpisodeView({ id }: { id: string }) {
  const { load } = useStore(useShallow((s) => ({ load: s.load })));
  const [ep, setEp] = useState<Episode | null>(null);
  const [tab, setTab] = useState<Tab>("transcript");
  const [startAudio, setStartAudio] = useState(false);

  useEffect(() => {
    api.getEpisode(id).then(async (e) => {
      if (!e) return;
      // 乔木精读 episodes learn their audio address from their page the first time they are opened.
      if (e.transcriptType === "qiaomu" && !e.audioUrl) {
        try { await api.qiaomuDetail(e.id); e = (await api.getEpisode(id)) ?? e; } catch { /* plays video, or shows the error later */ }
      }
      // Offline with the audio saved: a YouTube episode starts in audio mode instead of a player that cannot load.
      const offline = !!e.videoId && !navigator.onLine && isSaved(e.id);
      setStartAudio(offline);
      setEp(e);
      if (e.deep) setTab((t) => (t === "transcript" ? "deep" : t));
      void loadTranscript(e);
      // Opening an episode loads it into the player, unless something else is playing.
      const s = useStore.getState();
      if (s.current?.id !== e.id && !s.playing) load(offline ? { ...e, videoId: undefined } : e);
    });
  }, [id]);

  if (!ep) return <SkeletonEpisode />;
  return <EpisodeBody ep={ep} tab={tab} setTab={setTab} startAudio={startAudio} />;
}

// i18n-ignore-start
const notesSystem = () => `你把播客的「本集简介」翻译成通顺、准确的${lang() === "zh-TW" ? "繁體中文" : "简体中文"}。
保留段落划分（段落之间空一行）、人名、公司名、产品名和链接；时间戳、列表符号原样保留。
广告、赞助商信息照常翻译，不要删减，也不要添加解释。只输出译文。`;
// i18n-ignore-end

/** Chapter times in show notes ("00:00 开场", "1:02:30") become buttons that seek; links open in the browser. */
function withStamps(text: string, seek: (s: number) => void): ReactNode[] {
  return text.split(/(https?:\/\/[^\s<>"'）)】]+|\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b)/g).map((part, i) => {
    if (i % 2 === 0) return part;
    if (/^https?:/.test(part)) return <a key={i} href={part} className="notes-link" onClick={(e) => { e.preventDefault(); e.stopPropagation(); void openUrl(part); }}>{part.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}</a>;
    const sec = part.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
    return <button key={i} type="button" className="stamp" title={t("跳到这里播放")} onClick={(e) => { e.stopPropagation(); seek(sec); }}>{part}</button>;
  });
}

function Notes({ ep, text, defaultOpen = false }: { ep: Episode; text: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [orig, setOrig] = useState(false);
  const settings = useStore((s) => s.settings);
  const zhAlready = isZh(text);
  // Translated with Google in the background as soon as the page opens, so it is ready before the card is.
  const google = useZhParagraphs(text, !zhAlready);
  const [model, setModel] = useState<{ paras: string[]; by: string; src?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const srcKey = `${text.length}:${text.slice(0, 40)}`;
  const seek = (sec: number) => {
    const s = useStore.getState();
    if (s.current?.id === ep.id) s.player?.seek(sec);
    else { s.load({ ...ep, progress: sec }); window.setTimeout(() => useStore.getState().player?.seek(sec), 600); }
  };
  const provider = providerFor(settings, "translate");

  useEffect(() => {
    setModel(null);
    api.getBlob(ep.id, "notes-zh").then((raw) => { if (raw) try { const m = JSON.parse(raw); if (!m.src || m.src === srcKey) setModel(m); } catch { /* ignore */ } });
  }, [ep.id, srcKey]);

  const retranslate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const s = useStore.getState();
    const p = providerFor(s.settings, "translate");
    if (!p?.model || !p.baseUrl || (p.needsKey && !(await api.hasApiKey(p.id)))) { s.notify(t("先连接一个 AI 模型，就能用它重新翻译")); s.openSettings("model"); return; }
    setBusy(true); setOrig(false); setOpen(true);
    const split = (t: string) => t.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
    try {
      const out = await llmChat({ provider: p, system: notesSystem(), messages: [{ role: "user", content: paras.join("\n\n").slice(0, 20000) }], maxTokens: 6000, onDelta: (d) => setModel({ paras: split(d), by: p.name }) });
      const next = { paras: split(out), by: p.name, src: srcKey };
      setModel(next);
      void api.setBlob(ep.id, "notes-zh", JSON.stringify(next));
    } catch (err) { s.notify(t("翻译失败：{error}", { error: errorText(err) })); }
    finally { setBusy(false); }
  };

  const zh = model?.paras.length ? model.paras : google;
  const shown = zhAlready || orig || !zh ? paras : zh;
  return (
    <div className={`notes ${open ? "open" : ""}`}>
      <div className="notes-head" role="button" tabIndex={0} onClick={() => setOpen(!open)} onKeyDown={(e) => e.key === "Enter" && setOpen(!open)}>
        <span>{t("本集简介")}</span>
        {open && zh && !zhAlready && <span className="notes-by">{model?.paras.length ? t("{name} 翻译", { name: t(model.by) }) : t("谷歌翻译")}</span>}
        {open && zh && !zhAlready && <button className="link-btn" onClick={(e) => { e.stopPropagation(); setOrig(!orig); }}>{orig ? t("看中文") : t("原文")}</button>}
        {!zhAlready && isChineseUi() && (
          <button className="icon-btn sm" title={busy ? t("正在翻译…") : t("用 {name} 重新翻译", { name: provider ? t(provider.name) : t("AI 模型") })} aria-label={t("用 AI 模型重新翻译")} disabled={busy} onClick={retranslate}>
            {busy ? <Loader2 size={14} className="spin" /> : <WandSparkles size={14} />}
          </button>
        )}
        <ChevronDown size={14} className={open ? "flip" : ""} />
      </div>
      {open && (
        <div className="notes-body">
          {!zh && !orig && !zhAlready && <p className="muted small">{t("正在翻译…")}</p>}
          {shown.map((p, i) => <p key={i}>{withStamps(p, seek)}</p>)}
        </div>
      )}
    </div>
  );
}
/** The AI summary of the whole episode, folded under the show notes until asked for. */
function GuideCard({ ep }: { ep: Episode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`notes guide-card ${open ? "open" : ""}`}>
      <div className="notes-head" role="button" tabIndex={0} onClick={() => setOpen(!open)} onKeyDown={(e) => e.key === "Enter" && setOpen(!open)}>
        <span><ScrollText size={14} className="accent" /> {t("AI 导读")}</span>
        <span className="muted small guide-hint">{t("要点与时间线")}</span>
        <ChevronDown size={14} className={open ? "flip" : ""} />
      </div>
      {open && <div className="guide-body"><SummaryPanel ep={ep} /></div>}
    </div>
  );
}

/** Save for offline listening; shows progress while saving and the saved state after. */
function DownloadButton({ ep }: { ep: Episode }) {
  const [menu, setMenu] = useState(false);
  const notify = useStore((s) => s.notify);
  const go = useStore((s) => s.go);
  const saved = useOffline((s) => s.saved[ep.id]);
  const progress = useOffline((s) => s.active[ep.id]);
  if (!ep.audioUrl && !ep.videoId) return null;
  if (progress !== undefined) {
    const r = 7, c = 2 * Math.PI * r;
    return (
      <button className="round-btn dl-busy" title={progress == null ? t("正在下载，点一下取消") : t("已下载 {pct}%，点一下取消", { pct: Math.round(progress * 100) })} onClick={() => cancelDownload(ep.id)}>
        <svg viewBox="0 0 20 20" width="18" height="18" className={progress == null ? "dl-ring spin" : "dl-ring"} aria-hidden>
          <circle cx="10" cy="10" r={r} className="dl-track" />
          <circle cx="10" cy="10" r={r} className="dl-fill" strokeDasharray={c} strokeDashoffset={c * (1 - (progress ?? 0.25))} />
        </svg>
      </button>
    );
  }
  if (saved) {
    // A download that just finished draws its tick once; older saves show it already drawn.
    const fresh = Date.now() - saved.savedAt < 5000;
    const close = () => setMenu(false);
    return (
      <div className="menu-wrap">
        <button className="round-btn dl-done" title={t("已下载 · {size}", { size: bytes(saved.bytes) })} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><DoneCheck fresh={fresh} /></button>
        {menu && (
          <div className="menu right" role="menu" onMouseLeave={close}>
            <p className="menu-note">{t("已下载 · {size}", { size: bytes(saved.bytes) })}</p>
            <button role="menuitem" onClick={() => { close(); void api.revealDownload(ep.id).catch((e) => notify(errorText(e))); }}><FolderOpen size={14} /> {t("在文件夹中显示")}</button>
            <button role="menuitem" onClick={() => { close(); go({ kind: "downloads" }); }}><ArrowDownToLine size={14} /> {t("管理全部下载")}</button>
            <button role="menuitem" className="danger" onClick={() => { close(); void ask({ title: t("删除这一集已下载的音频？"), message: t("之后在线播放，字幕和进度都会保留。"), ok: t("删除"), danger: true }).then((yes) => { if (yes) void removeDownload(ep.id); }); }}><Trash2 size={14} /> {t("删除下载")}</button>
          </div>
        )}
      </div>
    );
  }
  return <button className="round-btn" title={ep.audioUrl ? t("下载，离线也能听") : t("下载音频，离线也能听")} onClick={() => void downloadEpisode(ep)}><ArrowDownToLine size={15} /></button>;
}

function EpisodeBody({ ep, tab, setTab, startAudio }: { ep: Episode; tab: Tab; setTab: (t: Tab) => void; startAudio: boolean }) {
  const { current, load } = useStore(useShallow((s) => ({ current: s.current, load: s.load })));
  const titleZh = useZh(ep.title);
  const isCurrent = current?.id === ep.id;
  const playing = useStore((s) => s.playing);
  const fav = useLibrary((s) => s.favorites.some((f) => f.id === ep.id));
  const coverToggle = () => {
    if (isCurrent) { useStore.getState().player?.toggle(); return; }
    load(ep); window.setTimeout(() => useStore.getState().player?.play(), 400);
  };
  // When the player controls scroll out of view, a copy docks at the bottom of the column.
  const leftRef = useRef<HTMLElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState(false);
  useEffect(() => {
    const root = leftRef.current, el = controlsRef.current;
    if (!root || !el) { setDocked(false); return; }
    const io = new IntersectionObserver(([e]) => setDocked(!e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0)), { root, threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [isCurrent, ep.id]);
  // rss.qiaomu.ai channels only carry a ~300-character summary; fetch the full notes once (YouTube or 小宇宙).
  const [fullNotes, setFullNotes] = useState<string | null>(null);
  useEffect(() => {
    setFullNotes(null);
    const short = notesText(ep.notes).length < 800;
    if (short && (ep.videoId || ep.link?.includes("xiaoyuzhoufm.com/episode/"))) void api.fullNotes(ep.id).then((n) => n && setFullNotes(n)).catch(() => {});
  }, [ep.id]);
  const notes = notesText(fullNotes ?? ep.notes);
  const { panel, panelOpen, put } = useLayout();
  // Video first; the audio file is the fallback (and a choice, for listening without the picture).
  const [audioMode, setAudioMode] = useState(startAudio);
  const saved = useOffline((s) => !!s.saved[ep.id]);
  const both = !!ep.videoId && (!!ep.audioUrl || saved);
  const showVideo = !!ep.videoId && !audioMode;
  const ytPromo = useStore((s) => s.settings.youtubePromo);
  const epShow = useStore((s) => s.shows.find((x) => x.id === ep.showId));
  const ytChannel = showLinks(epShow?.feedUrl).youtube;
  const switchTo = (audio: boolean, why?: string) => {
    const s = useStore.getState();
    const t = s.current?.id === ep.id ? s.time : ep.progress;
    setAudioMode(audio);
    s.set({ current: audio ? { ...ep, videoId: undefined, progress: t } : { ...ep, progress: t }, time: t, player: null, playing: false });
    if (why) s.notify(why);
  };

  return (
    <div className="episode">
      <div className={`ep-body ${panelOpen ? "" : "panel-collapsed"}`} style={{ "--panel-w": `${panelOpen ? panel : 0}px` } as React.CSSProperties}>
        <div className="ep-leftcol">
        <TopBar />
        <section className="ep-left" ref={leftRef}>
          <div className="ep-title-block">
            <div className="ep-title">
              <p className="meta-line">{[ep.showTitle && ep.showId !== "single" ? <span key="s">{showName(ep.showTitle)}</span> : null, date(ep.published), duration(ep.duration)].filter(Boolean).map((x, i) => <span key={i}>{i > 0 && " · "}{x}</span>)}</p>
              <h1>{titleZh ?? ep.title}</h1>
              {titleZh && titleZh !== ep.title && <p className="orig-line clamp1">{ep.title}</p>}
            </div>
            {!panelOpen && <button className="round-btn" title={t("显示字幕栏（⌘\\）")} onClick={() => put({ panelOpen: true })}><PanelRightOpen size={15} /></button>}
            <button className={`round-btn fav-btn ${fav ? "on" : ""}`} aria-pressed={fav} title={fav ? t("取消收藏") : t("收藏这一集")} onClick={() => toggleFavorite(ep)}><Bookmark size={15} fill={fav ? "currentColor" : "none"} /></button>
            <DownloadButton ep={ep} />
            {ep.videoId
              ? <button className="round-btn yt-open" title={t("在 YouTube 打开（从当前位置继续）")} onClick={() => { const s = Math.floor(isCurrent ? useStore.getState().time : ep.progress ?? 0); void openUrl(`https://www.youtube.com/watch?v=${ep.videoId}${s > 5 ? `&t=${s}s` : ""}`); }}><Youtube size={16} /></button>
              : ep.link && <button className="round-btn" title={t("节目网页")} onClick={() => openUrl(ep.link!)}><ExternalLink size={15} /></button>}
          </div>
          {both && (
            <div className="media-switch seg-control" role="radiogroup" aria-label={t("播放方式")}>
              <button role="radio" aria-checked={!audioMode} className={!audioMode ? "on" : ""} onClick={() => audioMode && switchTo(false)}>{t("视频")}</button>
              <button role="radio" aria-checked={audioMode} className={audioMode ? "on" : ""} onClick={() => !audioMode && switchTo(true)}>{t("仅音频")}</button>
            </div>
          )}
          {showVideo ? (
            <YouTubePlayer ep={ep} overlay={<SubtitleOverlay ep={ep} />} onUnplayable={ep.audioUrl || saved ? () => switchTo(true, t("这个视频无法在应用内播放，已切换为音频")) : undefined} />
          ) : (
            <div className="audio-stage">
              <button type="button" className="cover-play" onClick={coverToggle} title={isCurrent && playing ? t("暂停（空格）") : t("播放（空格）")} aria-label={isCurrent && playing ? t("暂停") : t("播放")}>
                {ep.cover ? <img src={ep.cover} alt="" /> : <span className="cover-fallback" />}
                <span className={`cover-play-btn ${isCurrent && playing ? "playing" : ""}`}>{isCurrent && playing ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}</span>
              </button>
              <div className="audio-sub"><SubtitleOverlay ep={ep} /></div>
            </div>
          )}
          {isCurrent ? <div className="controls-slot" ref={controlsRef}><Controls /></div> : (
            <button className="btn primary" onClick={() => { load(ep); setTimeout(() => useStore.getState().player?.play(), 400); }}><Play size={14} /> {t("播放这一集")}</button>
          )}
          {ytPromo && ytChannel && <YtVideoStrip channel={ytChannel} name={showName(epShow?.title ?? "")} cover={epShow?.cover} />}
          {notes && <Notes ep={ep} text={notes} />}
          <GuideCard ep={ep} />
          {isCurrent && docked && <div className="controls-dock"><Controls /></div>}
        </section>
        </div>
        {panelOpen && <Splitter value={panel} min={PANEL.min} max={PANEL.max} def={PANEL.def} snap={PANEL.snap} edge="left" label={t("字幕栏宽度")} onChange={(w) => put({ panel: w })} onCollapse={() => put({ panelOpen: false })} />}
        {panelOpen && <section className="ep-right">
          <div className="tabs" role="tablist" data-tauri-drag-region>
            <button role="tab" title={t(TAB_NAMES.transcript)} aria-label={t(TAB_NAMES.transcript)} aria-selected={tab === "transcript"} className={tab === "transcript" ? "on" : ""} onClick={() => setTab("transcript")}><Captions size={15} /><span className="tab-label">{t("字幕")}</span></button>
            {ep.deep && <button role="tab" title={t(TAB_NAMES.deep)} aria-label={t(TAB_NAMES.deep)} aria-selected={tab === "deep"} className={tab === "deep" ? "on" : ""} onClick={() => setTab("deep")}><BookOpen size={15} /><span className="tab-label">{t("精读")}</span></button>}
            <button role="tab" title={t(TAB_NAMES.chat)} aria-label={t(TAB_NAMES.chat)} aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}><MessageCircle size={15} /><span className="tab-label">{t("问答")}</span></button>
            <span className="spacer" data-tauri-drag-region />
            <button className="icon-btn tabs-close" title={t("收起字幕栏（⌘\\）")} onClick={() => put({ panelOpen: false })}><PanelRightClose size={16} /></button>
          </div>
          <div className="tab-body">
            <PanelBoundary key={tab}>
              {tab === "transcript" && <TranscriptPanel ep={ep} />}
              {tab === "chat" && <ChatPanel ep={ep} />}
              {tab === "deep" && <DeepRead ep={ep}><EmptyState art={<BookArt />} title={t("这一集还没有精读")} note={t("这期没有精读长文，字幕和 AI 导读依然可以帮你")} /></DeepRead>}

            </PanelBoundary>
          </div>
        </section>}
      </div>
    </div>
  );
}
