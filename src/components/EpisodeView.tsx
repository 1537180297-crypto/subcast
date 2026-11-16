import { TopBar } from "./Chrome";
import { Component, useEffect, useState, type ReactNode } from "react";

class PanelBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) { return { error: e.message }; }
  render() {
    return this.state.error ? (
      <div className="panel-empty"><p className="lead">这里出了点问题</p><p className="muted small">{this.state.error}</p>
        <button className="btn" onClick={() => this.setState({ error: null })}>重试</button></div>
    ) : this.props.children;
  }
}
import { BookOpen, Captions, ChevronDown, ExternalLink, MessageCircle, PanelRightClose, PanelRightOpen, Play, ScrollText } from "lucide-react";
import { Splitter } from "./Splitter";
import { DeepRead } from "./DeepRead";
import { PANEL, useLayout } from "../lib/layout";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type Episode } from "../lib/api";
import { date, duration, notesText } from "../lib/format";
import { showName } from "../lib/picks";
import { useZh, useZhParagraphs } from "../lib/zh";
import { loadTranscript, useJobs } from "../lib/jobs";
import { useStore } from "../store";
import { ChatPanel, SummaryPanel } from "./AiPanels";
import { Controls, YouTubePlayer } from "./Players";
import { activeIndex, TranscriptPanel } from "./TranscriptPanel";

type Tab = "transcript" | "deep" | "chat" | "summary";

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
  const { load } = useStore();
  const [ep, setEp] = useState<Episode | null>(null);
  const [tab, setTab] = useState<Tab>("transcript");

  useEffect(() => {
    api.getEpisode(id).then(async (e) => {
      if (!e) return;
      // 乔木精读 episodes learn their audio address from their page the first time they are opened.
      if (e.transcriptType === "qiaomu" && !e.audioUrl) {
        try { await api.qiaomuDetail(e.id); e = (await api.getEpisode(id)) ?? e; } catch { /* plays video, or shows the error later */ }
      }
      setEp(e);
      if (e.transcriptType === "qiaomu") setTab((t) => (t === "transcript" ? "deep" : t));
      void loadTranscript(e);
      // Opening an episode loads it into the player, unless something else is playing.
      const s = useStore.getState();
      if (s.current?.id !== e.id && !s.playing) load(e);
    });
  }, [id]);

  if (!ep) return <div className="page" />;
  return <EpisodeBody ep={ep} tab={tab} setTab={setTab} />;
}

function Notes({ text, defaultOpen = false }: { text: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [orig, setOrig] = useState(false);
  const zh = useZhParagraphs(text, open);
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (
    <div className={`notes ${open ? "open" : ""}`}>
      <div className="notes-head" role="button" tabIndex={0} onClick={() => setOpen(!open)} onKeyDown={(e) => e.key === "Enter" && setOpen(!open)}>
        <span>本集简介</span>
        {open && zh && <button className="link-btn" onClick={(e) => { e.stopPropagation(); setOrig(!orig); }}>{orig ? "看中文" : "原文"}</button>}
        <ChevronDown size={14} className={open ? "flip" : ""} />
      </div>
      {open && (
        <div className="notes-body">
          {open && !zh && !orig && paras.length > 0 && !/[\u4e00-\u9fff]/.test(text) && <p className="muted small">正在翻译…</p>}
          {(orig || !zh ? paras : zh).map((p, i) => <p key={i}>{p}</p>)}
        </div>
      )}
    </div>
  );
}

function EpisodeBody({ ep, tab, setTab }: { ep: Episode; tab: Tab; setTab: (t: Tab) => void }) {
  const { current, load } = useStore();
  const titleZh = useZh(ep.title);
  const isCurrent = current?.id === ep.id;
  const notes = notesText(ep.notes);
  const { panel, panelOpen, put } = useLayout();

  return (
    <div className="episode">
      <div className={`ep-body ${panelOpen ? "" : "panel-collapsed"}`} style={{ "--panel-w": `${panelOpen ? panel : 0}px` } as React.CSSProperties}>
        <div className="ep-leftcol">
        <TopBar />
        <section className="ep-left">
          <div className="ep-title-block">
            <div className="ep-title">
              <p className="meta-line">{[ep.showTitle && ep.showId !== "single" ? <span key="s">{showName(ep.showTitle)}</span> : null, date(ep.published), duration(ep.duration)].filter(Boolean).map((x, i) => <span key={i}>{i > 0 && " · "}{x}</span>)}</p>
              <h1>{titleZh ?? ep.title}</h1>
              {titleZh && titleZh !== ep.title && <p className="orig-line clamp1">{ep.title}</p>}
            </div>
            {!panelOpen && <button className="round-btn" title="显示字幕栏（⌘\\）" onClick={() => put({ panelOpen: true })}><PanelRightOpen size={15} /></button>}
            {ep.link && <button className="round-btn" title={ep.videoId ? "在 YouTube 打开" : "节目网页"} onClick={() => openUrl(ep.link!)}><ExternalLink size={15} /></button>}
          </div>
          {ep.videoId ? (
            <YouTubePlayer ep={ep} overlay={<SubtitleOverlay ep={ep} />} />
          ) : (
            <div className="audio-stage">
              {ep.cover ? <img src={ep.cover} alt="" /> : <div className="cover-fallback" />}
              <div className="audio-sub"><SubtitleOverlay ep={ep} /></div>
            </div>
          )}
          {isCurrent ? <Controls /> : (
            <button className="btn primary" onClick={() => { load(ep); setTimeout(() => useStore.getState().player?.play(), 400); }}><Play size={14} /> 播放这一集</button>
          )}
        </section>
        </div>
        {panelOpen && <Splitter value={panel} min={PANEL.min} max={PANEL.max} def={PANEL.def} snap={PANEL.snap} edge="left" label="字幕栏宽度" onChange={(w) => put({ panel: w })} onCollapse={() => put({ panelOpen: false })} />}
        {panelOpen && <section className="ep-right">
          <div className="tabs" role="tablist" data-tauri-drag-region>
            <button role="tab" aria-selected={tab === "transcript"} className={tab === "transcript" ? "on" : ""} onClick={() => setTab("transcript")}><Captions size={15} /> 字幕</button>
            {ep.transcriptType === "qiaomu" && <button role="tab" aria-selected={tab === "deep"} className={tab === "deep" ? "on" : ""} onClick={() => setTab("deep")}><BookOpen size={15} /> 精读</button>}
            <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}><MessageCircle size={15} /> 问答</button>
            <button role="tab" aria-selected={tab === "summary"} className={tab === "summary" ? "on" : ""} onClick={() => setTab("summary")}><ScrollText size={15} /> 导读</button>
            <span className="spacer" data-tauri-drag-region />
            <button className="icon-btn tabs-close" title="收起字幕栏（⌘\\）" onClick={() => put({ panelOpen: false })}><PanelRightClose size={16} /></button>
          </div>
          <div className="tab-body">
            <PanelBoundary key={tab}>
              {tab === "transcript" && <TranscriptPanel ep={ep} />}
              {tab === "chat" && <ChatPanel ep={ep} />}
              {tab === "deep" && <DeepRead ep={ep}><div className="panel-empty"><p className="muted">这一集还没有精读</p></div></DeepRead>}
              {tab === "summary" && (
                <div className="guide-panel">
                  {notes && <Notes text={notes} defaultOpen />}
                  <div className="guide-summary"><SummaryPanel ep={ep} /></div>
                </div>
              )}
            </PanelBoundary>
          </div>
        </section>}
      </div>
    </div>
  );
}
