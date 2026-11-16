import { useEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { api, type Episode } from "../lib/api";
import { clock } from "../lib/format";
import { loadYouTube } from "../lib/youtube";
import { useStore } from "../store";

const SAVE_EVERY = 10;
let lastSaved = 0;
function track(ep: Episode, time: number, length?: number) {
  const s = useStore.getState();
  if (s.current?.id !== ep.id) return;
  s.set({ time, ...(length ? { length } : {}) });
  if (Math.abs(time - lastSaved) > SAVE_EVERY) { lastSaved = time; void api.setProgress(ep.id, time); }
}

/** The audio element lives at the app root so playback continues while browsing. */
export function AudioEngine() {
  const current = useStore((s) => s.current);
  const rate = useStore((s) => s.settings.playbackRate);
  const ref = useRef<HTMLAudioElement>(null);
  const audio = current && !current.videoId ? current : null;

  useEffect(() => {
    const el = ref.current;
    if (!el || !audio) return;
    const handle = {
      seek: (t: number) => { el.currentTime = t; el.play().catch(() => {}); },
      toggle: () => (el.paused ? void el.play().catch(() => {}) : el.pause()),
      play: () => void el.play().catch(() => {}),
      setRate: (r: number) => { el.playbackRate = r; },
    };
    useStore.getState().set({ player: handle });
    return () => { if (useStore.getState().player === handle) useStore.getState().set({ player: null }); };
  }, [audio?.id]);

  useEffect(() => { if (ref.current) ref.current.playbackRate = rate; }, [rate, audio?.id]);

  if (!audio?.audioUrl) return null;
  return (
    <audio
      ref={ref}
      src={audio.audioUrl}
      preload="metadata"
      onLoadedMetadata={(e) => {
        const el = e.currentTarget;
        el.playbackRate = rate;
        if (audio.progress > 5 && audio.progress < el.duration - 10) el.currentTime = audio.progress;
        track(audio, el.currentTime, el.duration);
      }}
      onTimeUpdate={(e) => track(audio, e.currentTarget.currentTime)}
      onPlay={() => useStore.getState().set({ playing: true })}
      onPause={(e) => { useStore.getState().set({ playing: false }); void api.setProgress(audio.id, e.currentTarget.currentTime); }}
      onError={() => useStore.getState().notify("音频加载失败，可能是网络问题或地址已失效")}
    />
  );
}

/** Our subtitles replace YouTube's: turning the caption module off alone is not enough when the viewer has captions on. */
function hideYouTubeCaptions(player: any) {
  try { player.setOption?.("captions", "track", {}); } catch { /* module not loaded yet */ }
  try { player.unloadModule?.("captions"); player.unloadModule?.("cc"); } catch { /* not loaded */ }
}

export const RATES = [0.8, 1, 1.15, 1.25, 1.5, 1.75, 2];

export function YouTubePlayer({ ep, overlay }: { ep: Episode; overlay?: React.ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const rate = useStore((s) => s.settings.playbackRate);
  const playerRef = useRef<any>(null);

  useEffect(() => {
    let player: any, timer: number | undefined, disposed = false;
    loadYouTube().then((YT) => {
      if (disposed || !host.current) return;
      const mount = document.createElement("div");
      host.current.appendChild(mount);
      player = new YT.Player(mount, {
        videoId: ep.videoId,
        width: "100%",
        height: "100%",
        host: "https://www.youtube.com",
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, cc_load_policy: 0, iv_load_policy: 3, start: Math.floor(ep.progress > 5 ? ep.progress : 0), origin: window.location.origin },
        events: {
          onReady: () => {
            playerRef.current = player;
            // Our own subtitles replace YouTube's.
            hideYouTubeCaptions(player);
            player.setPlaybackRate?.(useStore.getState().settings.playbackRate);
            useStore.getState().set({
              length: player.getDuration?.() || ep.duration || 0,
              player: {
                seek: (t: number) => { player.seekTo(t, true); player.playVideo(); },
                toggle: () => (player.getPlayerState() === 1 ? player.pauseVideo() : player.playVideo()),
                play: () => player.playVideo(),
                setRate: (r: number) => player.setPlaybackRate(r),
              },
            });
            timer = window.setInterval(() => {
              const t = player.getCurrentTime?.();
              if (typeof t === "number") track(ep, t, player.getDuration?.());
            }, 250);
          },
          onStateChange: (e: any) => {
            useStore.getState().set({ playing: e.data === 1 });
            if (e.data === 1) hideYouTubeCaptions(player);
            if (e.data === 2) void api.setProgress(ep.id, player.getCurrentTime());
          },
          onError: (e: any) => setError(e.data === 150 || e.data === 101 ? "视频作者不允许在其他应用中播放，可点「在 YouTube 打开」" : `视频无法播放（错误 ${e.data}）`),
        },
      });
    }).catch((e) => setError(String(e.message ?? e)));
    return () => {
      disposed = true;
      window.clearInterval(timer);
      try { void api.setProgress(ep.id, player?.getCurrentTime?.() ?? 0); player?.destroy?.(); } catch { /* already gone */ }
      const s = useStore.getState();
      if (s.current?.id === ep.id) s.set({ player: null, playing: false });
    };
  }, [ep.id]);

  useEffect(() => { playerRef.current?.setPlaybackRate?.(rate); }, [rate]);

  return (
    <div className="video">
      <div className="video-host" ref={host} />
      {error && <div className="video-error">{error}</div>}
      {overlay}
    </div>
  );
}


export function Controls({ compact = false }: { compact?: boolean }) {
  const { time, length, playing, player, settings } = useStore();
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? time;
  const nextRate = cycleRate;
  return (
    <div className={`controls ${compact ? "compact" : ""}`}>
      <button className="icon-btn" title="后退 15 秒（←）" onClick={() => player?.seek(Math.max(0, time - 15))} disabled={!player}><RotateCcw size={18} /></button>
      <button className="play-btn" title={playing ? "暂停（空格）" : "播放（空格）"} onClick={() => player?.toggle()} disabled={!player}>
        {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
      </button>
      <button className="icon-btn" title="前进 30 秒（→）" onClick={() => player?.seek(time + 30)} disabled={!player}><RotateCw size={18} /></button>
      <span className="time">{clock(shown)}</span>
      <input
        className="seek"
        type="range"
        min={0}
        max={Math.max(length, 1)}
        step={1}
        value={Math.min(shown, length || shown)}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => { if (drag != null) { player?.seek(drag); setDrag(null); } }}
        onKeyUp={() => { if (drag != null) { player?.seek(drag); setDrag(null); } }}
        style={{ "--fill": `${length ? (shown / length) * 100 : 0}%` } as React.CSSProperties}
        aria-label="播放进度"
      />
      <span className="time">{length ? clock(length) : "--:--"}</span>
      <button className="rate-btn" onClick={nextRate} title="播放速度（S）">{settings.playbackRate}×</button>
      <button className="rate-btn" onClick={() => cycleMode()} title="字幕：双语 / 中文 / 原文（C）">{settings.subtitleMode === "bilingual" ? "双语" : settings.subtitleMode === "translation" ? "中文" : "原文"}</button>
    </div>
  );
}

export function cycleMode() {
  const { settings, saveSettings } = useStore.getState();
  const order = ["bilingual", "translation", "original"] as const;
  void saveSettings({ subtitleMode: order[(order.indexOf(settings.subtitleMode) + 1) % 3] });
}

export function cycleRate() {
  const { settings, saveSettings, player } = useStore.getState();
  const r = RATES[(RATES.indexOf(settings.playbackRate) + 1) % RATES.length];
  player?.setRate(r);
  void saveSettings({ playbackRate: r });
}
