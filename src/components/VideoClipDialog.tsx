import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Check, Copy, FolderOpen, Image as ImageIcon, Loader2, Minus, Pause, Play, Plus, RotateCcw, Scissors, Sparkles, Volume2, VolumeX, Wand2 } from "lucide-react";
import { create } from "zustand";
import { api, errorText, rawErrorText, type Episode, type RenderVideoClipResult, type Segment, type VideoClipProgress } from "../lib/api";
import { clock } from "../lib/format";
import { buildPlatformPost, polishClipCopy, previewEpisodeRange, type HighlightClip, type PostPlatform } from "../lib/highlights";
import { t, tk, tr, tx, useLang } from "../lib/i18n";
import { showName } from "../lib/picks";
import { buildClipCues, canvasDimensions, canvasToPngBase64, renderCueBand, renderStaticOverlay, type CardBg, type ClipLayout, type ClipVisualConfig, type SubStyleId } from "../lib/videoClipCanvas";
import { renderCoverCanvas, type CoverAspect, type CoverTemplateId } from "../lib/videoCoverCanvas";
import { type SubContent } from "../lib/subexport";
import { useStore } from "../store";
import { Modal } from "./Chrome";
import { Seg } from "./ReadingSettings";

export interface ClipModalTarget {
  ep: Episode;
  segments: Segment[];
  zh?: (string | null | undefined)[];
  clip: HighlightClip;
}

export const useClipModal = create<{ target: ClipModalTarget | null }>(() => ({ target: null }));

export function openVideoClipDialog(target: ClipModalTarget) {
  useClipModal.setState({ target });
}

export function closeVideoClipDialog() {
  useClipModal.setState({ target: null });
}

const PREF_KEY = "subcast.vclip";
type CoverMode = "flash" | "hold" | "none";
type SideTab = "clip" | "cover" | "copy";

interface ClipPrefs {
  layout?: ClipLayout;
  cardBg?: CardBg;
  subStyle?: SubStyleId;
  subLang?: SubContent;
  showTitle?: boolean;
  showSource?: boolean;
  coverTpl?: CoverTemplateId;
  coverMode?: CoverMode;
  embedThumbnail?: boolean;
  saveCoverSidecar?: boolean;
  extraLandscapeCover?: boolean;
}

function readPrefs(): ClipPrefs {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}"); } catch { return {}; }
}

function savePrefs(p: ClipPrefs) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

const SUB_STYLES: { id: SubStyleId; name: string; swatchBg: string; swatchFg: string }[] = [
  { id: "cinema", name: tk("电影描边"), swatchBg: "#1b1c20", swatchFg: "#ffffff" },
  { id: "amber", name: tk("暖金高亮"), swatchBg: "#1b1c20", swatchFg: "#ffd866" },
  { id: "pill", name: tk("暗底胶囊"), swatchBg: "#2c2e35", swatchFg: "#f5f5f5" },
];

const COVER_TEMPLATES: { id: CoverTemplateId; name: string; bg: string; fg: string; accent: string }[] = [
  { id: "impact", name: tk("暗幕金句"), bg: "#17171b", fg: "#ffffff", accent: "#ffd866" },
  { id: "magazine", name: tk("杂志大字"), bg: "#faf7f2", fg: "#18181b", accent: "#d9481a" },
  { id: "marker", name: tk("荧光重点"), bg: "#1a1a1f", fg: "#141416", accent: "#facc15" },
  { id: "cinema", name: tk("电影画报"), bg: "#141315", fg: "#f5f2eb", accent: "#f59e0b" },
];

const DOWNLOADS_DIR = /^.*\/(Downloads|下载)\//; // i18n-ignore

interface PreparedState {
  path: string;
  start: number;
  end: number;
  duration: number;
  hasBurnedSubtitles: boolean;
  frames: string[];
  bestFrame: number;
}

export function VideoClipDialog() {
  const target = useClipModal((s) => s.target);
  if (!target) return null;
  const key = `${target.ep.id}:${target.clip.id}:${target.clip.startIdx}:${target.clip.endIdx}`;
  return <VideoClipDialogBody key={key} target={target} />;
}

function VideoClipDialogBody({ target }: { target: ClipModalTarget }) {
  useLang((s) => s.lang);
  const { ep, segments, zh, clip } = target;
  const notify = useStore((s) => s.notify);
  const openSettings = useStore((s) => s.openSettings);
  const hasZh = useMemo(() => !!zh?.some((x) => !!x?.trim()), [zh]);
  const prefs = useMemo(readPrefs, []);
  const showDisplay = useMemo(() => (ep.showTitle ? showName(ep.showTitle) : ""), [ep.showTitle]);

  const [sideTab, setSideTab] = useState<SideTab>("clip");
  const [pvView, setPvView] = useState<"video" | "cover">("video");

  const [startIdx, setStartIdx] = useState(() => Math.max(0, Math.min(segments.length - 1, clip.startIdx)));
  const [endIdx, setEndIdx] = useState(() => Math.max(startIdx, Math.min(segments.length - 1, clip.endIdx)));
  const [padBefore, setPadBefore] = useState(0.25);
  const [padAfter, setPadAfter] = useState(0.4);

  const [layout, setLayout] = useState<ClipLayout>(() => prefs.layout ?? "portrait_card");
  const [cardBg, setCardBg] = useState<CardBg>(() => prefs.cardBg ?? "blur");
  const [cropX, setCropX] = useState(0.5);
  const [subStyle, setSubStyle] = useState<SubStyleId>(() => prefs.subStyle ?? "cinema");
  const [subLang, setSubLang] = useState<SubContent>(() => (hasZh ? (prefs.subLang ?? "bilingual") : "original"));
  const [showTitle, setShowTitle] = useState(() => prefs.showTitle ?? true);
  const [showSource, setShowSource] = useState(() => prefs.showSource ?? true);
  const [title, setTitle] = useState(() => clip.title);
  const [liftBurned, setLiftBurned] = useState(false);

  // Cover & Publish state
  const [coverTpl, setCoverTpl] = useState<CoverTemplateId>(() => prefs.coverTpl ?? "impact");
  const [coverAspectPv, setCoverAspectPv] = useState<"auto" | CoverAspect>("auto");
  const [coverMode, setCoverMode] = useState<CoverMode>(() => prefs.coverMode ?? "flash");
  const [embedThumbnail, setEmbedThumbnail] = useState(() => prefs.embedThumbnail ?? true);
  const [saveCoverSidecar, setSaveCoverSidecar] = useState(() => prefs.saveCoverSidecar ?? true);
  const [extraLandscapeCover, setExtraLandscapeCover] = useState(() => prefs.extraLandscapeCover ?? true);

  const [coverHook, setCoverHook] = useState(() => clip.coverHook || clip.title);
  const [coverSub, setCoverSub] = useState(() => clip.coverSub || (clip.reason && clip.reason !== t("手动选取片段") ? clip.reason : ""));
  const [coverKicker, setCoverKicker] = useState(() => showDisplay || t("播客高光"));
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);

  const [shareCopy, setShareCopy] = useState(() => clip.shareCopy);
  const [articleCopy, setArticleCopy] = useState(() => clip.articleCopy || "");
  const [postPlatform, setPostPlatform] = useState<PostPlatform>("short");
  const [postEdits, setPostEdits] = useState<Partial<Record<PostPlatform, string>>>({});
  const [polishing, setPolishing] = useState(false);

  const [zhEdits, setZhEdits] = useState<Record<number, string>>({});
  const [origEdits, setOrigEdits] = useState<Record<number, string>>({});
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [activePreviewIdx, setActivePreviewIdx] = useState(startIdx);

  const [prepared, setPrepared] = useState<PreparedState | null>(null);
  const [busyJob, setBusyJob] = useState<{ id: string; stage: string; progress: number; message: string } | null>(null);
  const [exported, setExported] = useState<RenderVideoClipResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [pvPlaying, setPvPlaying] = useState(false);
  const [pvMuted, setPvMuted] = useState(false);
  const [pvTime, setPvTime] = useState(0);

  useEffect(() => {
    savePrefs({
      layout,
      cardBg,
      subStyle,
      subLang,
      showTitle,
      showSource,
      coverTpl,
      coverMode,
      embedThumbnail,
      saveCoverSidecar,
      extraLandscapeCover,
    });
  }, [layout, cardBg, subStyle, subLang, showTitle, showSource, coverTpl, coverMode, embedThumbnail, saveCoverSidecar, extraLandscapeCover]);

  useEffect(() => {
    if (!busyJob) return;
    const un = listen<VideoClipProgress>("video-clip-progress", (e) => {
      if (e.payload.jobId !== busyJob.id) return;
      setBusyJob({ id: e.payload.jobId, stage: e.payload.stage, progress: e.payload.progress, message: e.payload.message });
    });
    return () => { void un.then((f) => f()); };
  }, [busyJob?.id]);

  const activeJobId = useRef<string | null>(null);
  activeJobId.current = busyJob?.id ?? null;
  useEffect(() => () => { if (activeJobId.current) void api.cancelJob(activeJobId.current); }, []);

  const clipStart = Math.max(0, (segments[startIdx]?.start ?? 0) - padBefore);
  const clipEnd = Math.max(clipStart + 1, (segments[endIdx]?.end ?? clipStart + 5) + padAfter);
  const clipDur = clipEnd - clipStart;

  const effectiveSegments = useMemo(
    () => segments.map((s, i) => (origEdits[i] !== undefined ? { ...s, text: origEdits[i] } : s)),
    [segments, origEdits],
  );
  const effectiveZh = useMemo(
    () => segments.map((_, i) => (zhEdits[i] !== undefined ? zhEdits[i] : zh?.[i] ?? null)),
    [segments, zh, zhEdits],
  );

  const cues = useMemo(
    () => buildClipCues(effectiveSegments, effectiveZh, startIdx, endIdx, clipStart, clipEnd, subLang),
    [effectiveSegments, effectiveZh, startIdx, endIdx, clipStart, clipEnd, subLang],
  );

  const visualConfig: ClipVisualConfig = useMemo(() => ({
    layout,
    cardBg,
    subStyle,
    subLang,
    showTitle,
    title,
    showSource,
    showName: showDisplay,
    episodeTitle: ep.title,
    liftForBurnedSub: liftBurned,
  }), [layout, cardBg, subStyle, subLang, showTitle, title, showSource, showDisplay, ep.title, liftBurned]);

  const staticOverlayUrl = useMemo(() => {
    const c = renderStaticOverlay(visualConfig);
    return c ? c.toDataURL("image/png") : null;
  }, [visualConfig]);

  const currentCue = useMemo(() => {
    if (!cues.length) return null;
    if (prepared && Math.abs(prepared.start - clipStart) < 0.1 && Math.abs(prepared.end - clipEnd) < 0.1) {
      return cues.find((c) => pvTime >= c.start && pvTime <= c.end) ?? cues[0];
    }
    const seg = effectiveSegments[activePreviewIdx];
    const relMid = seg ? Math.max(0, (seg.start + seg.end) / 2 - clipStart) : 0;
    return cues.find((c) => relMid >= c.start && relMid <= c.end) ?? cues[0];
  }, [cues, prepared, clipStart, clipEnd, pvTime, effectiveSegments, activePreviewIdx]);

  const cueBandPreview = useMemo(() => {
    if (!currentCue) return null;
    const band = renderCueBand(currentCue, visualConfig);
    const { height } = canvasDimensions(layout);
    return {
      url: band.canvas.toDataURL("image/png"),
      topPct: (band.y / height) * 100,
    };
  }, [currentCue, visualConfig, layout]);

  const posterBackdrop = ep.cover || (ep.videoId ? `https://i.ytimg.com/vi/${ep.videoId}/hqdefault.jpg` : undefined);
  const preparedValid = !!prepared && Math.abs(prepared.start - clipStart) < 0.08 && Math.abs(prepared.end - clipEnd) < 0.08;
  const activeFrameIdx = selectedFrame != null && prepared?.frames[selectedFrame] ? selectedFrame : (prepared?.bestFrame ?? 0);
  const activeCoverBackdrop = (prepared?.frames[activeFrameIdx]) || posterBackdrop || null;
  const effectiveCoverAspect: CoverAspect = coverAspectPv === "auto" ? (layout === "landscape" ? "16:9" : "9:16") : coverAspectPv;

  useEffect(() => {
    let live = true;
    void renderCoverCanvas({
      template: coverTpl,
      aspect: effectiveCoverAspect,
      hookTitle: coverHook,
      subTitle: coverSub,
      kicker: coverKicker,
      showName: showDisplay,
      durationSec: clipDur,
      backdropUrl: activeCoverBackdrop,
    }).then((c) => {
      if (live) setCoverPreviewUrl(c.toDataURL("image/png"));
    }).catch(() => {});
    return () => { live = false; };
  }, [coverTpl, effectiveCoverAspect, coverHook, coverSub, coverKicker, showDisplay, clipDur, activeCoverBackdrop]);

  const generatedPost = useMemo(
    () => buildPlatformPost(postPlatform, {
      ep,
      title,
      coverHook,
      coverSub,
      shareCopy,
      articleCopy,
      tags: clip.tags,
      segments: effectiveSegments,
      zh: effectiveZh,
      startIdx,
      endIdx,
      clipStart,
    }),
    [postPlatform, ep, title, coverHook, coverSub, shareCopy, articleCopy, clip.tags, effectiveSegments, effectiveZh, startIdx, endIdx, clipStart],
  );
  const currentPostText = postEdits[postPlatform] ?? generatedPost;

  const switchSideTab = (tab: SideTab) => {
    setSideTab(tab);
    if (tab === "cover") setPvView("cover");
    else if (tab === "clip") setPvView("video");
  };

  const ensurePrepared = async (): Promise<PreparedState | null> => {
    if (preparedValid && prepared) return prepared;
    if (!ep.videoId) { setError(t("当前单集没有可用视频源")); return null; }
    const jobId = `vclip-prep-${Date.now()}`;
    setError(null);
    setNeedsSetup(false);
    setBusyJob({ id: jobId, stage: "download", progress: 0.06, message: t("正在获取这一段原视频…") });
    try {
      const res = await api.videoClipPrepare(jobId, ep.videoId, clipStart, clipEnd);
      const next: PreparedState = {
        path: res.path,
        start: clipStart,
        end: clipEnd,
        duration: res.duration || clipDur,
        hasBurnedSubtitles: res.hasBurnedSubtitles,
        frames: res.frames ?? [],
        bestFrame: res.bestFrame ?? 0,
      };
      setPrepared(next);
      if (selectedFrame == null) setSelectedFrame(next.bestFrame);
      if (res.hasBurnedSubtitles) setLiftBurned(true);
      return next;
    } catch (e) {
      if (!rawErrorText(e).includes("已取消")) setError(errorText(e)); // i18n-ignore
      return null;
    } finally {
      setBusyJob(null);
    }
  };

  const runAiPolish = async () => {
    if (polishing) return;
    setPolishing(true);
    setError(null);
    setNeedsSetup(false);
    try {
      const res = await polishClipCopy({ ep, segments: effectiveSegments, zh: effectiveZh, startIdx, endIdx });
      setTitle(res.title);
      setCoverHook(res.coverHook);
      setCoverSub(res.coverSub);
      setShareCopy(res.shareCopy);
      setArticleCopy(res.articleCopy);
      setPostEdits({});
      notify(t("AI 已生成封面金句与多平台文案"));
    } catch (e) {
      setNeedsSetup(Boolean((e as { setup?: boolean })?.setup) || /设置|API Key|模型/.test(rawErrorText(e)));
      setError(errorText(e));
    } finally {
      setPolishing(false);
    }
  };

  const copyCoverImage = async (aspectOverride?: CoverAspect) => {
    try {
      const c = await renderCoverCanvas({
        template: coverTpl,
        aspect: aspectOverride ?? effectiveCoverAspect,
        hookTitle: coverHook,
        subTitle: coverSub,
        kicker: coverKicker,
        showName: showDisplay,
        durationSec: clipDur,
        backdropUrl: activeCoverBackdrop,
      });
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
      if (!blob) throw new Error("blob");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      notify(t("封面图已复制到剪贴板"));
    } catch {
      notify(t("复制失败，请用「保存封面」"));
    }
  };

  const saveCoverImage = async (aspectOverride?: CoverAspect) => {
    try {
      const targetAspect = aspectOverride ?? effectiveCoverAspect;
      const c = await renderCoverCanvas({
        template: coverTpl,
        aspect: targetAspect,
        hookTitle: coverHook,
        subTitle: coverSub,
        kicker: coverKicker,
        showName: showDisplay,
        durationSec: clipDur,
        backdropUrl: activeCoverBackdrop,
      });
      const safeTitle = (title.trim() || ep.title).replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").trim().slice(0, 50);
      const name = `${safeTitle || t("SubCast 切片")}-${t("封面")}-${targetAspect.replace(":", "x")}`;
      const p = await api.saveImage(name, c.toDataURL("image/png"));
      notify(t("封面已保存到 {path}", { path: p.replace(DOWNLOADS_DIR, tx("folder", "下载") + "/") }));
    } catch (e) {
      notify(errorText(e));
    }
  };

  const runExport = async (askPath: boolean) => {
    if (busyJob) return;
    setExported(null);
    setError(null);
    setNeedsSetup(false);

    let customPath: string | null = null;
    const safeTitle = (title.trim() || ep.title).replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").trim().slice(0, 60);
    const defaultName = `${safeTitle || t("SubCast 切片")} (${clock(clipStart).replace(/:/g, "-")})`;
    if (askPath) {
      customPath = await saveDialog({
        defaultPath: `${defaultName}.mp4`,
        filters: [{ name: "MP4", extensions: ["mp4"] }],
      }).catch(() => null);
      if (!customPath) return;
    }

    const prep = await ensurePrepared();
    if (!prep) return;

    const jobId = `vclip-render-${Date.now()}`;
    setBusyJob({ id: jobId, stage: "render", progress: 0.05, message: t("正在生成封面与双语字幕图层…") });
    try {
      const staticCanvas = renderStaticOverlay(visualConfig);
      const staticOverlayPng = staticCanvas ? canvasToPngBase64(staticCanvas) : null;
      const renderedCues = cues.map((cue) => {
        const band = renderCueBand(cue, visualConfig);
        return { start: cue.start, end: cue.end, y: band.y, pngBase64: canvasToPngBase64(band.canvas) };
      });

      const bestIdx = selectedFrame != null && prep.frames[selectedFrame] ? selectedFrame : prep.bestFrame;
      const backdropForExport = prep.frames[bestIdx] || posterBackdrop || null;
      const mainAspect: CoverAspect = layout === "landscape" ? "16:9" : "9:16";
      const needMainCover = coverMode !== "none" || embedThumbnail || saveCoverSidecar;

      let coverPng: string | null = null;
      if (needMainCover) {
        const coverCanvas = await renderCoverCanvas({
          template: coverTpl,
          aspect: mainAspect,
          hookTitle: coverHook,
          subTitle: coverSub,
          kicker: coverKicker,
          showName: showDisplay,
          durationSec: prep.duration,
          backdropUrl: backdropForExport,
        });
        coverPng = canvasToPngBase64(coverCanvas);
      }

      let landscapeCoverPng: string | null = null;
      if (layout !== "landscape" && saveCoverSidecar && extraLandscapeCover) {
        const landCanvas = await renderCoverCanvas({
          template: coverTpl,
          aspect: "16:9",
          hookTitle: coverHook,
          subTitle: coverSub,
          kicker: coverKicker,
          showName: showDisplay,
          durationSec: prep.duration,
          backdropUrl: backdropForExport,
        });
        landscapeCoverPng = canvasToPngBase64(landCanvas);
      }

      const result = await api.videoClipRender(jobId, {
        rawPath: prep.path,
        outputPath: customPath,
        defaultName,
        layout,
        cardBg,
        cropX,
        duration: prep.duration,
        staticOverlayPng,
        cues: renderedCues,
        coverPng,
        coverMode,
        embedThumbnail,
        saveCoverSidecar,
        landscapeCoverPng,
      });
      setExported(result);
      notify(t("视频切片已导出到 {path}", { path: result.videoPath.replace(DOWNLOADS_DIR, tx("folder", "下载") + "/") }));
    } catch (e) {
      if (!rawErrorText(e).includes("已取消")) setError(errorText(e)); // i18n-ignore
    } finally {
      setBusyJob(null);
    }
  };

  const copyCurrentPost = async () => {
    try {
      await navigator.clipboard.writeText(currentPostText);
      notify(t("发布文案已复制"));
    } catch {
      notify(t("复制失败"));
    }
  };

  const togglePreviewPlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };

  const stageBgClass =
    layout === "portrait_card"
      ? cardBg === "paper"
        ? "bg-paper"
        : cardBg === "night"
          ? "bg-night"
          : "bg-blur"
      : "bg-dark";

  return (
    <Modal title={t("双语视频切片")} onClose={closeVideoClipDialog} wide>
      <div className="vclip-layout">
        {/* Left: live WYSIWYG video / cover preview */}
        <div className="vclip-preview-col">
          <div className="vclip-pv-switch">
            <Seg
              value={pvView}
              options={[["video", t("正片预览")], ["cover", t("封面预览")]]}
              onChange={setPvView}
            />
            {pvView === "cover" && (
              <Seg
                value={coverAspectPv}
                options={[["auto", t("随视频")], ["3:4", "3:4"], ["16:9", "16:9"]]}
                onChange={setCoverAspectPv}
              />
            )}
          </div>

          {pvView === "cover" ? (
            <div className={`vclip-cover-stage aspect-${effectiveCoverAspect.replace(":", "-")}`}>
              {coverPreviewUrl
                ? <img src={coverPreviewUrl} alt={t("封面预览")} className="vclip-cover-img" />
                : <div className="poster-wait"><Loader2 size={16} className="spin" /> {t("正在生成封面…")}</div>}
            </div>
          ) : (
            <div className={`vclip-stage ${layout === "landscape" ? "is-land" : "is-port"} ${stageBgClass}`}>
              {layout === "portrait_card" && cardBg === "blur" && posterBackdrop && (
                <img src={posterBackdrop} alt="" className="vclip-blur-bg" />
              )}
              <div className={`vclip-video-box ${layout === "portrait_card" ? (cardBg === "blur" ? "card-blur" : "card-solid") : ""}`}>
                {preparedValid && prepared ? (
                  <video
                    ref={videoRef}
                    src={convertFileSrc(prepared.path)}
                    loop
                    playsInline
                    muted={pvMuted}
                    style={layout === "portrait_fill" ? { objectPosition: `${cropX * 100}% center` } : undefined}
                    onTimeUpdate={(e) => setPvTime(e.currentTarget.currentTime)}
                    onPlay={() => {
                      setPvPlaying(true);
                      const s = useStore.getState();
                      if (s.playing) s.player?.toggle();
                    }}
                    onPause={() => setPvPlaying(false)}
                    onClick={togglePreviewPlay}
                  />
                ) : (
                  <div className="vclip-placeholder" onClick={() => void ensurePrepared()}>
                    {posterBackdrop && (
                      <img
                        src={posterBackdrop}
                        alt=""
                        style={layout === "portrait_fill" ? { objectPosition: `${cropX * 100}% center` } : undefined}
                      />
                    )}
                    <button type="button" className="vclip-load-btn" disabled={!!busyJob}>
                      {busyJob?.stage === "download" || busyJob?.stage === "ffmpeg" || busyJob?.stage === "trim"
                        ? <><Loader2 size={14} className="spin" /> {t("正在加载画面…")}</>
                        : <><Play size={14} fill="currentColor" /> {t("加载这段画面试看")}</>}
                    </button>
                  </div>
                )}
              </div>
              {staticOverlayUrl && <img src={staticOverlayUrl} alt="" className="vclip-overlay-img" />}
              {cueBandPreview && (
                <img src={cueBandPreview.url} alt="" className="vclip-cue-img" style={{ top: `${cueBandPreview.topPct}%` }} />
              )}
            </div>
          )}

          <div className="vclip-pv-bar">
            {pvView === "cover" ? (
              <span className="small muted">{effectiveCoverAspect} · {t("支持【】高亮关键词")}</span>
            ) : preparedValid ? (
              <>
                <button type="button" className="icon-btn sm" onClick={togglePreviewPlay} title={pvPlaying ? t("暂停") : t("播放")}>
                  {pvPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
                </button>
                <button type="button" className="icon-btn sm" onClick={() => setPvMuted(!pvMuted)} title={pvMuted ? t("取消静音") : t("静音")}>
                  {pvMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                </button>
                <span className="num small muted">{clock(pvTime)} / {clock(clipDur)}</span>
              </>
            ) : (
              <span className="small muted">{t("预览已与成片像素对齐")} · {clock(clipStart)} – {clock(clipEnd)}</span>
            )}
            <span className="spacer" />
            <button type="button" className="btn ghost sm" onClick={() => previewEpisodeRange(ep, clipStart, clipEnd)}>
              <Play size={12} /> {t("主播放器试听")}
            </button>
          </div>
          {prepared?.hasBurnedSubtitles && layout === "landscape" && pvView === "video" && (
            <p className="vclip-hint small">{t("检测到原视频底部已有自带字幕，已自动抬高双语字幕避免重叠。")}</p>
          )}
        </div>

        {/* Right: 3 clean studio tabs */}
        <div className="vclip-side">
          <div className="vclip-tabs">
            <Seg
              value={sideTab}
              options={[["clip", t("片段与字幕")], ["cover", t("封面设计")], ["copy", t("发布文案")]]}
              onChange={switchSideTab}
            />
            <button type="button" className="btn ghost sm" disabled={polishing} onClick={() => void runAiPolish()} title={t("让 AI 提炼爆款封面大字与多平台文案")}>
              {polishing ? <Loader2 size={12} className="spin" /> : <Wand2 size={12} />} {t("AI 润色")}
            </button>
          </div>

          {sideTab === "clip" && (
            <>
              <section className="vclip-sec">
                <div className="vclip-sec-head">
                  <span className="vclip-label">{t("片段范围与文稿")}</span>
                  <span className="num small muted">{clock(clipStart)} – {clock(clipEnd)} · {Math.round(clipDur)}s</span>
                </div>
                <div className="vclip-bound-btns">
                  <button type="button" className="btn ghost sm" disabled={startIdx <= 0} onClick={() => setStartIdx((i) => Math.max(0, i - 1))}><Plus size={12} /> {t("前一句")}</button>
                  <button type="button" className="btn ghost sm" disabled={startIdx >= endIdx} onClick={() => setStartIdx((i) => Math.min(endIdx, i + 1))}><Minus size={12} /> {t("缩首句")}</button>
                  <button type="button" className="btn ghost sm" disabled={endIdx <= startIdx} onClick={() => setEndIdx((i) => Math.max(startIdx, i - 1))}><Minus size={12} /> {t("缩尾句")}</button>
                  <button type="button" className="btn ghost sm" disabled={endIdx >= segments.length - 1} onClick={() => setEndIdx((i) => Math.min(segments.length - 1, i + 1))}><Plus size={12} /> {t("后一句")}</button>
                </div>
                <div className="vclip-pads">
                  <label className="small muted">{t("开头留白")} <input type="range" min={-0.3} max={1.0} step={0.05} value={padBefore} onChange={(e) => setPadBefore(Number(e.target.value))} /><span className="num">{padBefore.toFixed(2)}s</span></label>
                  <label className="small muted">{t("结尾留白")} <input type="range" min={-0.3} max={1.2} step={0.05} value={padAfter} onChange={(e) => setPadAfter(Number(e.target.value))} /><span className="num">{padAfter.toFixed(2)}s</span></label>
                </div>
                <div className="vclip-lines">
                  {segments.slice(startIdx, endIdx + 1).map((seg, offset) => {
                    const idx = startIdx + offset;
                    const zhText = effectiveZh[idx] ?? "";
                    const origText = effectiveSegments[idx]?.text ?? seg.text;
                    const isEditing = editingIdx === idx;
                    const isActive = activePreviewIdx === idx;
                    return (
                      <div
                        key={idx}
                        className={`vclip-line ${isActive ? "on" : ""}`}
                        onClick={() => {
                          setActivePreviewIdx(idx);
                          if (preparedValid && videoRef.current) {
                            videoRef.current.currentTime = Math.max(0, seg.start - clipStart + 0.05);
                          }
                        }}
                      >
                        <span className="num vclip-lt">{clock(seg.start)}</span>
                        <div className="vclip-lbody">
                          {isEditing ? (
                            <div className="vclip-edit-box" onClick={(e) => e.stopPropagation()}>
                              {hasZh && (
                                <input value={zhText} placeholder={t("中文译文")} onChange={(e) => setZhEdits((m) => ({ ...m, [idx]: e.target.value }))} />
                              )}
                              <input value={origText} placeholder={t("原文")} onChange={(e) => setOrigEdits((m) => ({ ...m, [idx]: e.target.value }))} />
                              <div className="vclip-edit-actions">
                                <button type="button" className="btn ghost sm" onClick={() => {
                                  setZhEdits((m) => { const n = { ...m }; delete n[idx]; return n; });
                                  setOrigEdits((m) => { const n = { ...m }; delete n[idx]; return n; });
                                }}><RotateCcw size={11} /> {t("还原")}</button>
                                <button type="button" className="btn primary sm" onClick={() => setEditingIdx(null)}><Check size={11} /> {t("完成")}</button>
                              </div>
                            </div>
                          ) : (
                            <>
                              {zhText && <p className="vclip-lzh">{zhText}</p>}
                              <p className="vclip-lorig">{origText}</p>
                            </>
                          )}
                        </div>
                        {!isEditing && (
                          <button type="button" className="link-btn vclip-edit-btn" onClick={(e) => { e.stopPropagation(); setEditingIdx(idx); }}>{t("改字")}</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="vclip-sec">
                <div className="reading-row">
                  <span>{t("画面比例")}</span>
                  <Seg
                    value={layout}
                    options={[["portrait_card", t("9:16 卡片")], ["landscape", t("16:9 原画")], ["portrait_fill", t("9:16 满屏")]]}
                    onChange={setLayout}
                  />
                </div>
                {layout === "portrait_card" && (
                  <div className="reading-row">
                    <span>{t("卡片底色")}</span>
                    <Seg
                      value={cardBg}
                      options={[["blur", t("画面模糊")], ["night", t("墨夜")], ["paper", t("纸白")]]}
                      onChange={setCardBg}
                    />
                  </div>
                )}
                {layout === "portrait_fill" && (
                  <div className="reading-row">
                    <span>{t("水平取景")}</span>
                    <div className="vclip-crop-row">
                      <input type="range" min={0} max={1} step={0.02} value={cropX} onChange={(e) => setCropX(Number(e.target.value))} />
                      <span className="num small muted">{Math.round(cropX * 100)}%</span>
                    </div>
                  </div>
                )}
                <div className="reading-row">
                  <span>{t("字幕语言")}</span>
                  <Seg
                    value={subLang}
                    options={hasZh ? [["bilingual", t("双语")], ["translation", t("中文")], ["original", t("原文")]] : [["original", t("原文")]]}
                    onChange={setSubLang}
                  />
                </div>
                <div className="vclip-styles">
                  {SUB_STYLES.map((st) => (
                    <button key={st.id} type="button" className={`vclip-style-btn ${subStyle === st.id ? "on" : ""}`} onClick={() => setSubStyle(st.id)}>
                      <span className="vclip-swatch" style={{ background: st.swatchBg, color: st.swatchFg }}>Aa</span>
                      <span>{t(st.name)}</span>
                    </button>
                  ))}
                </div>
                <div className="vclip-toggles">
                  <label><input type="checkbox" checked={showTitle} onChange={(e) => setShowTitle(e.target.checked)} /> {t("顶部金句标题")}</label>
                  <label><input type="checkbox" checked={showSource} onChange={(e) => setShowSource(e.target.checked)} /> {t("节目出处")}</label>
                  {layout === "landscape" && (
                    <label><input type="checkbox" checked={liftBurned} onChange={(e) => setLiftBurned(e.target.checked)} /> {t("避让原字幕")}</label>
                  )}
                </div>
                {showTitle && (
                  <input className="vclip-title-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("输入切片顶部金句标题")} />
                )}
              </section>
            </>
          )}

          {sideTab === "cover" && (
            <>
              <section className="vclip-sec">
                <div className="vclip-sec-head">
                  <span className="vclip-label">{t("封面视觉模板")}</span>
                  <span className="small muted">{t("用【】包住关键词自动高亮")}</span>
                </div>
                <div className="vclip-tpl-grid">
                  {COVER_TEMPLATES.map((tpl) => (
                    <button key={tpl.id} type="button" className={`vclip-tpl-btn ${coverTpl === tpl.id ? "on" : ""}`} onClick={() => setCoverTpl(tpl.id)}>
                      <span className="vclip-tpl-swatch" style={{ background: tpl.bg }}>
                        <b style={{ color: tpl.id === "marker" ? "#ffffff" : (tpl.id === "magazine" ? "#18181b" : tpl.fg) }}>{t("金")}</b>
                        <i style={{ background: tpl.accent }} />
                      </span>
                      <span>{t(tpl.name)}</span>
                    </button>
                  ))}
                </div>
                <input className="vclip-title-input" value={coverHook} onChange={(e) => setCoverHook(e.target.value)} placeholder={t("封面大字标题，如：未来三年，【会提问的人】胜出")} />
                <div className="vclip-cover-inputs">
                  <input className="vclip-title-input" value={coverSub} onChange={(e) => setCoverSub(e.target.value)} placeholder={t("副标题钩子（可选）")} />
                  <input className="vclip-title-input" value={coverKicker} onChange={(e) => setCoverKicker(e.target.value)} placeholder={t("顶部眉标（节目名）")} />
                </div>
              </section>

              <section className="vclip-sec">
                <div className="vclip-sec-head">
                  <span className="vclip-label">{t("封面背景剧照")}</span>
                  {!preparedValid && (
                    <button type="button" className="btn ghost sm" disabled={!!busyJob} onClick={() => void ensurePrepared()}>
                      <ImageIcon size={12} /> {t("提取本段高清剧照")}
                    </button>
                  )}
                </div>
                {prepared?.frames.length ? (
                  <div className="vclip-frames">
                    {prepared.frames.map((src, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className={`vclip-frame-btn ${activeFrameIdx === idx ? "on" : ""}`}
                        onClick={() => setSelectedFrame(idx)}
                        title={idx === prepared.bestFrame ? t("AI 自动优选最清晰帧") : undefined}
                      >
                        <img src={src} alt="" />
                        {idx === prepared.bestFrame && <span className="vclip-frame-best">{t("推荐")}</span>}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="muted small">{t("默认使用节目封面；点右上角「提取本段高清剧照」或导出时自动抽取 5 帧真实人物画面并优选。")}</p>
                )}
              </section>

              <section className="vclip-sec">
                <div className="reading-row">
                  <span>{t("MP4 片头封面")}</span>
                  <Seg
                    value={coverMode}
                    options={[["flash", t("隐形首帧")], ["hold", t("定格 1 秒")], ["none", t("不压片头")]]}
                    onChange={setCoverMode}
                  />
                </div>
                <p className="muted small">
                  {coverMode === "flash"
                    ? t("开头 0.14 秒隐形放入爆款封面：小红书/视频号/抖音/B站自动抓第 0 帧当封面，播放几乎无感且不吞字。")
                    : coverMode === "hold"
                      ? t("片头静态展示 1 秒爆款封面后再开讲，音画同步顺延，适合直接发朋友圈与公众号视频。")
                      : t("正片开头不压封面，仅通过下方选项内嵌缩略图或保存独立封面 PNG。")}
                </p>
                <div className="vclip-toggles">
                  <label><input type="checkbox" checked={embedThumbnail} onChange={(e) => setEmbedThumbnail(e.target.checked)} /> {t("内嵌视频缩略图")}</label>
                  <label><input type="checkbox" checked={saveCoverSidecar} onChange={(e) => setSaveCoverSidecar(e.target.checked)} /> {t("同目录保存封面 PNG")}</label>
                  {layout !== "landscape" && saveCoverSidecar && (
                    <label><input type="checkbox" checked={extraLandscapeCover} onChange={(e) => setExtraLandscapeCover(e.target.checked)} /> {t("附带 16:9 横版封面（公众号/B站）")}</label>
                  )}
                </div>
                <div className="vclip-cover-actions">
                  <button type="button" className="btn ghost sm" onClick={() => void copyCoverImage()}><Copy size={12} /> {t("复制封面图")}</button>
                  <button type="button" className="btn ghost sm" onClick={() => void saveCoverImage()}><ImageIcon size={12} /> {t("保存当前封面")}</button>
                  <button type="button" className="btn ghost sm" onClick={() => void saveCoverImage("3:4")}><ImageIcon size={12} /> {t("保存 3:4 小红书封面")}</button>
                </div>
              </section>
            </>
          )}

          {sideTab === "copy" && (
            <section className="vclip-sec vclip-copy-sec">
              <div className="vclip-sec-head">
                <Seg
                  value={postPlatform}
                  options={[["short", t("短视频")], ["article", t("视频文章")], ["social", t("X · 推文")]]}
                  onChange={setPostPlatform}
                />
                <div className="row-actions tight">
                  {postEdits[postPlatform] !== undefined && (
                    <button type="button" className="link-btn" onClick={() => setPostEdits((m) => { const n = { ...m }; delete n[postPlatform]; return n; })}>
                      {t("还原")}
                    </button>
                  )}
                  <button type="button" className="btn sm" onClick={() => void copyCurrentPost()}>
                    <Copy size={12} /> {t("复制文案")}
                  </button>
                </div>
              </div>
              <p className="muted small">
                {postPlatform === "short"
                  ? t("适配小红书、微信视频号、抖音、B站：直接粘贴标题、推荐钩子与标签。")
                  : postPlatform === "article"
                    ? t("适配公众号文章、即刻、知乎：包含观点导读、双语原话摘录与回跳出处。")
                    : t("适配 X / 朋友圈：精炼一句话钩子 + 金句原话 + 跳转链接。")}
              </p>
              <textarea
                className="vclip-post-box"
                value={currentPostText}
                onChange={(e) => setPostEdits((m) => ({ ...m, [postPlatform]: e.target.value }))}
              />
            </section>
          )}

          {busyJob && (
            <div className="vclip-progress">
              <div className="vclip-progress-top">
                <span><Loader2 size={13} className="spin" /> {tr(busyJob.message)}</span>
                <span className="num">{Math.round(busyJob.progress * 100)}%</span>
                <button type="button" className="link-btn" onClick={() => void api.cancelJob(busyJob.id)}>{t("取消")}</button>
              </div>
              <div className="bar live"><div style={{ width: `${Math.max(4, busyJob.progress * 100)}%` }} /></div>
            </div>
          )}

          {error && (
            <div className="vclip-err-row">
              <p className="error-text">{error}</p>
              {needsSetup && <button type="button" className="btn sm" onClick={() => { closeVideoClipDialog(); openSettings("model"); }}>{t("去设置")}</button>}
            </div>
          )}

          {exported && !busyJob && (
            <div className="vclip-done">
              <span><Sparkles size={14} /> {exported.coverPath ? t("已导出 MP4 与配套封面") : t("已导出带双语字幕 MP4")}</span>
              <div className="row-actions tight">
                <button type="button" className="btn ghost sm" onClick={() => void copyCoverImage()}>{t("复制封面")}</button>
                <button type="button" className="btn ghost sm" onClick={() => void copyCurrentPost()}>{t("复制文案")}</button>
                <button type="button" className="btn sm" onClick={() => void api.revealFile(exported.videoPath).catch((e) => notify(errorText(e)))}>
                  <FolderOpen size={13} /> {t("在文件夹中显示")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="modal-foot">
        <button type="button" className="btn ghost" onClick={() => void copyCurrentPost()}>
          <Copy size={14} /> {t("复制发布文案")}
        </button>
        <span className="spacer" />
        <button type="button" className="btn ghost" onClick={closeVideoClipDialog}>{t("关闭")}</button>
        <button type="button" className="btn" disabled={!!busyJob} onClick={() => void runExport(true)}>
          {t("另存为…")}
        </button>
        <button type="button" className="btn primary" disabled={!!busyJob} onClick={() => void runExport(false)}>
          <Scissors size={14} /> {t("导出 MP4")}
        </button>
      </div>
    </Modal>
  );
}
