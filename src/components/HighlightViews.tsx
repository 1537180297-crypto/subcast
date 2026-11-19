import { useEffect, useMemo, useState } from "react";
import { Copy, Loader2, LocateFixed, Play, RefreshCw, Scissors, Sparkles, Square } from "lucide-react";
import { type Episode, type Segment } from "../lib/api";
import { clock } from "../lib/format";
import { clearHighlightsError, loadHighlights, previewEpisodeRange, runHighlights, stopHighlights, useHighlights, type HighlightClip } from "../lib/highlights";
import { t, tk, useLang } from "../lib/i18n";
import { useStore } from "../store";
import { openVideoClipDialog } from "./VideoClipDialog";

const INTENT_SUGGESTIONS = [
  tk("犀利观点与金句"),
  tk("实战方法与具体案例"),
  tk("争议判断与行业趋势"),
];

export function HighlightsPanel({
  ep,
  segments,
  zh,
  onJumpToTranscript,
}: {
  ep: Episode;
  segments: Segment[];
  zh?: (string | null | undefined)[];
  onJumpToTranscript: (index: number, time: number) => void;
}) {
  useLang((s) => s.lang);
  const bundle = useHighlights((s) => s.bundles[ep.id]);
  const loading = useHighlights((s) => !!s.loading[ep.id]);
  const error = useHighlights((s) => s.error[ep.id]);
  const needsSetup = useHighlights((s) => !!s.needsSetup[ep.id]);
  const notify = useStore((s) => s.notify);
  const openSettings = useStore((s) => s.openSettings);

  const [intent, setIntent] = useState(bundle?.intent ?? "");
  const [sortBy, setSortBy] = useState<"score" | "time">("score");
  const [reasking, setReasking] = useState(false);

  useEffect(() => {
    void loadHighlights(ep.id);
  }, [ep.id]);

  const clips = useMemo(() => {
    const list = bundle?.clips ?? [];
    if (sortBy === "time") return [...list].sort((a, b) => a.start - b.start);
    return [...list].sort((a, b) => b.score - a.score || a.start - b.start);
  }, [bundle, sortBy]);

  const startRun = (customIntent?: string) => {
    clearHighlightsError(ep.id);
    setReasking(false);
    void runHighlights(ep, segments, zh, customIntent ?? intent);
  };

  const copyShare = async (c: HighlightClip) => {
    try {
      await navigator.clipboard.writeText([c.title, c.shareCopy].filter(Boolean).join("\n\n"));
      notify(t("传播文案已复制"));
    } catch {
      notify(t("复制失败"));
    }
  };

  if (loading) {
    return (
      <div className="hl-empty">
        <div className="hl-card-intro">
          <Sparkles size={20} className="hl-spark" />
          <p className="es-title">{t("正在从整期文稿挑选高光片段")}</p>
          <p className="muted small">{t("按「钩子 → 论证 → 金句收束」结构筛选，自动吸附完整句首尾…")}</p>
          <div className="hl-wait-row">
            <Loader2 size={14} className="spin" />
            <button type="button" className="btn ghost sm" onClick={() => stopHighlights(ep.id)}>
              <Square size={12} fill="currentColor" /> {t("停止")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!bundle?.clips.length) {
    return (
      <div className="hl-empty">
        <div className="hl-card-intro">
          <Sparkles size={20} className="hl-spark" />
          <p className="es-title">{t("自动挑选高光金句片段")}</p>
          <p className="muted small">{t("从整期中抽取 30–120 秒独立成篇的高传播段落，支持一键剪出带双语字幕的视频切片。")}</p>
          <div className="hl-intent-box">
            <input
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder={t("可选：想重点找哪类话题，例如「创业踩坑」")}
              onKeyDown={(e) => { if (e.key === "Enter") startRun(); }}
            />
            <div className="hl-chips">
              {INTENT_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`hl-chip ${intent === t(s) ? "on" : ""}`}
                  onClick={() => setIntent(t(s))}
                >{t(s)}</button>
              ))}
            </div>
          </div>
          {error && <p className="error-text">{error}</p>}
          <div className="row-actions center">
            {needsSetup && (
              <button type="button" className="btn" onClick={() => openSettings("model")}>{t("去设置")}</button>
            )}
            <button type="button" className="btn primary" disabled={!segments.length} onClick={() => startRun()}>
              <Sparkles size={14} /> {t("提取高光片段")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="hl-panel">
      <div className="hl-toolbar">
        <span className="muted small">{t("共 {n} 段高光", { n: clips.length })}{bundle.intent ? ` · ${bundle.intent}` : ""}</span>
        <span className="spacer" />
        <button type="button" className="link-btn" onClick={() => setSortBy(sortBy === "score" ? "time" : "score")}>
          {sortBy === "score" ? t("按时间顺序") : t("按传播度")}
        </button>
        <button type="button" className="link-btn" onClick={() => setReasking(!reasking)}>
          <RefreshCw size={12} /> {t("换方向重选")}
        </button>
      </div>

      {reasking && (
        <div className="hl-reask">
          <input
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder={t("输入想找的话题方向（留空则全面挑选）")}
            onKeyDown={(e) => { if (e.key === "Enter") startRun(); }}
          />
          <button type="button" className="btn primary sm" onClick={() => startRun()}>{t("重新提取")}</button>
        </div>
      )}

      {error && <p className="error-text hl-err">{error}</p>}

      <div className="hl-list">
        {clips.map((c) => {
          const previewZh = zh?.[c.startIdx]?.trim();
          const previewOrig = segments[c.startIdx]?.text ?? "";
          const durSec = Math.max(1, Math.round(c.end - c.start));
          return (
            <article key={c.id} className="hl-card">
              <div className="hl-card-top">
                <span className="hl-score" title={t("传播潜力评分")}>✦ {c.score}</span>
                <span className="num small muted">{clock(c.start)} – {clock(c.end)} · {durSec}s</span>
              </div>
              <h4 className="hl-title">{c.title}</h4>
              {c.reason && <p className="hl-reason">{c.reason}</p>}
              <div className="hl-quote">
                {previewZh && <p className="hl-qzh clamp2">{previewZh}</p>}
                {previewOrig && <p className="hl-qorig clamp2">{previewOrig}</p>}
              </div>
              {c.tags.length > 0 && (
                <div className="hl-tags">
                  {c.tags.map((tag) => <span key={tag} className="hl-tag">{tag}</span>)}
                </div>
              )}
              <div className="hl-actions">
                <button type="button" className="btn ghost sm" onClick={() => previewEpisodeRange(ep, c.start, c.end)}>
                  <Play size={12} fill="currentColor" /> {t("试看")}
                </button>
                {ep.videoId && (
                  <button type="button" className="btn primary sm" onClick={() => openVideoClipDialog({ ep, segments, zh, clip: c })}>
                    <Scissors size={12} /> {t("剪成视频")}
                  </button>
                )}
                <button type="button" className="btn ghost sm" onClick={() => void copyShare(c)}>
                  <Copy size={12} /> {t("文案")}
                </button>
                <button type="button" className="icon-btn sm" title={t("定位到字幕")} onClick={() => onJumpToTranscript(c.startIdx, c.start)}>
                  <LocateFixed size={13} />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

/** Displays AI highlight markers along the episode progress bar. */
export function SeekHighlights({
  episodeId,
  length,
  onSeek,
}: {
  episodeId?: string;
  length: number;
  onSeek: (seconds: number) => void;
}) {
  const clips = useHighlights((s) => (episodeId ? s.bundles[episodeId]?.clips : undefined));
  useEffect(() => {
    if (episodeId) void loadHighlights(episodeId);
  }, [episodeId]);

  if (!episodeId || !clips?.length || length <= 1) return null;
  return (
    <div className="seek-marks" aria-hidden>
      {clips.map((c) => {
        const left = Math.max(0, Math.min(99, (c.start / length) * 100));
        const width = Math.max(0.8, Math.min(100 - left, ((c.end - c.start) / length) * 100));
        return (
          <button
            key={c.id}
            type="button"
            className="seek-mark"
            style={{ left: `${left}%`, width: `${width}%` }}
            title={`${c.title} · ${clock(c.start)}`}
            onClick={(e) => { e.stopPropagation(); onSeek(c.start); }}
          />
        );
      })}
    </div>
  );
}
