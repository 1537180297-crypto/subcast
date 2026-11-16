import { useEffect, useState } from "react";
import { ArrowLeft, Captions, ExternalLink, MessageCircle, Play, ScrollText } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type Episode } from "../lib/api";
import { date, duration, notesText } from "../lib/format";
import { loadTranscript, useJobs } from "../lib/jobs";
import { useStore } from "../store";
import { ChatPanel, SummaryPanel } from "./AiPanels";
import { Controls, YouTubePlayer } from "./Players";
import { activeIndex, TranscriptPanel } from "./TranscriptPanel";

type Tab = "transcript" | "chat" | "summary";

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
  return (
    <div className="subtitle-overlay">
      {zh && mode !== "original" && <p className="sub-zh">{zh}</p>}
      {(mode !== "translation" || !zh) && <p className="sub-orig">{seg.text}</p>}
    </div>
  );
}

export function EpisodeView({ id }: { id: string }) {
  const { back, current, load, player, playing } = useStore();
  const [ep, setEp] = useState<Episode | null>(null);
  const [tab, setTab] = useState<Tab>("transcript");

  useEffect(() => {
    api.getEpisode(id).then((e) => {
      if (!e) return;
      setEp(e);
      void loadTranscript(e);
      // Opening an episode loads it into the player, unless something else is playing.
      const s = useStore.getState();
      if (s.current?.id !== e.id && !s.playing) load(e);
    });
  }, [id]);

  if (!ep) return <div className="page" />;
  const isCurrent = current?.id === ep.id;
  const notes = notesText(ep.notes);

  return (
    <div className="episode">
      <header className="ep-head">
        <button className="icon-btn" onClick={back} title="返回"><ArrowLeft size={18} /></button>
        <div className="ep-title">
          <p className="muted small">{ep.showTitle && ep.showId !== "single" ? ep.showTitle : ""}{ep.published ? ` · ${date(ep.published)}` : ""}{ep.duration ? ` · ${duration(ep.duration)}` : ""}</p>
          <h1>{ep.title}</h1>
        </div>
        {ep.link && <button className="btn ghost sm" onClick={() => openUrl(ep.link!)}><ExternalLink size={13} /> {ep.videoId ? "在 YouTube 打开" : "原网页"}</button>}
      </header>
      <div className="ep-body">
        <section className="ep-left">
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
          {!ep.videoId && isCurrent && !playing && player == null && <p className="muted small">正在加载音频…</p>}
          {notes && (
            <details className="notes" open={!ep.videoId}>
              <summary>节目简介</summary>
              <p>{notes}</p>
            </details>
          )}
        </section>
        <section className="ep-right">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "transcript"} className={tab === "transcript" ? "on" : ""} onClick={() => setTab("transcript")}><Captions size={15} /> 字幕</button>
            <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}><MessageCircle size={15} /> AI 问答</button>
            <button role="tab" aria-selected={tab === "summary"} className={tab === "summary" ? "on" : ""} onClick={() => setTab("summary")}><ScrollText size={15} /> 导读</button>
          </div>
          <div className="tab-body">
            {tab === "transcript" && <TranscriptPanel ep={ep} />}
            {tab === "chat" && <ChatPanel ep={ep} />}
            {tab === "summary" && <SummaryPanel ep={ep} />}
          </div>
        </section>
      </div>
    </div>
  );
}
