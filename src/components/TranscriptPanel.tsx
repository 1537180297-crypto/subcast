import { memo, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Languages, Loader2, Search, Square, Wand2, X } from "lucide-react";
import { api, errorText, type Episode, type ModelInfo, type Segment } from "../lib/api";
import { clock } from "../lib/format";
import { generateTranscript, loadTranslation, needsTranslation, stopTranslation, translateEpisode, useJobs } from "../lib/jobs";
import { useStore } from "../store";

const SOURCE_LABEL: Record<string, string> = { youtube: "YouTube 官方字幕", "youtube-auto": "YouTube 自动字幕", rss: "节目方提供的文字稿", whisper: "本机识别", cloud: "云端识别" };

export function activeIndex(segments: Segment[], time: number): number {
  let lo = 0, hi = segments.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= time + 0.15) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

const Row = memo(function Row({ seg, zh, active, mode, onSeek, query }: { seg: Segment; zh?: string | null; active: boolean; mode: string; onSeek: (t: number) => void; query: string }) {
  const mark = (text: string) => {
    if (!query) return text;
    const i = text.toLowerCase().indexOf(query.toLowerCase());
    return i < 0 ? text : <>{text.slice(0, i)}<mark>{text.slice(i, i + query.length)}</mark>{text.slice(i + query.length)}</>;
  };
  return (
    <div className={`line ${active ? "active" : ""}`} data-active={active || undefined} role="button" tabIndex={0} onClick={() => onSeek(seg.start)} onKeyDown={(e) => e.key === "Enter" && onSeek(seg.start)}>
      <span className="line-time">{clock(seg.start)}</span>
      <div className="line-text">
        {mode !== "translation" && <p className="orig">{mark(seg.text)}</p>}
        {mode !== "original" && zh && <p className="zh">{mark(zh)}</p>}
        {mode === "translation" && !zh && <p className="orig">{mark(seg.text)}</p>}
      </div>
    </div>
  );
});

export function TranscriptPanel({ ep }: { ep: Episode }) {
  const transcript = useJobs((s) => s.transcripts[ep.id]);
  const official = useJobs((s) => s.officialChecked[ep.id]);
  const officialError = useJobs((s) => s.officialError[ep.id]);
  const asr = useJobs((s) => s.asr[ep.id]);
  const translation = useJobs((s) => s.translations[ep.id]);
  const { time, player, settings, saveSettings, current } = useStore();
  const isCurrent = current?.id === ep.id;
  const list = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(0);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const segments = transcript?.segments ?? [];
  const active = isCurrent ? activeIndex(segments, time) : -1;
  const seek = (t: number) => { if (isCurrent) player?.seek(t); };

  useEffect(() => { if (transcript) void loadTranslation(ep.id, transcript.segments.length); }, [transcript, ep.id]);

  // Translate on open when the episode is not in Chinese and a model is set up.
  useEffect(() => {
    if (!transcript || !translation || translation.running || translation.error) return;
    if (!settings.autoTranslate || !needsTranslation(transcript)) return;
    if (translation.items.every((x) => x != null)) return;
    translateEpisode(ep, transcript).catch(() => { /* shown as a button below */ });
  }, [transcript, !!translation, settings.autoTranslate]);

  useEffect(() => {
    if (active < 0 || Date.now() - userScrolled.current < 5000 || query) return;
    const row = list.current?.querySelector<HTMLElement>("[data-active]");
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active, query]);

  const matches = useMemo(() => {
    if (!query) return null;
    const q = query.toLowerCase();
    return segments.map((s, i) => (s.text.toLowerCase().includes(q) || translation?.items[i]?.toLowerCase().includes(q) ? i : -1)).filter((i) => i >= 0);
  }, [query, segments, translation]);

  if (!transcript) {
    if (asr && asr.stage !== "done") return <Generating ep={ep} />;
    if (official === "searching" || official === undefined) return <div className="panel-empty"><Loader2 className="spin" size={20} /><p>正在查找官方字幕…</p></div>;
    return <GeneratePanel ep={ep} note={official === "error" ? `读取官方字幕失败：${officialError}` : ep.videoId ? "这个视频没有可用的字幕。" : "这集节目没有附带文字稿。"} />;
  }

  const total = segments.length;
  const done = translation?.items.filter((x) => x != null).length ?? 0;
  const wantsZh = needsTranslation(transcript);
  const startTranslate = () => { setStartError(null); translateEpisode(ep, transcript).catch((e) => setStartError(errorText(e))); };
  const barError = startError ?? translation?.error;
  const needsSetup = barError && /设置|API Key|模型/.test(barError);
  const rows = matches ?? segments.map((_, i) => i);

  return (
    <div className="transcript">
      <div className="panel-bar">
        <span className="source-tag">{SOURCE_LABEL[transcript.source] ?? transcript.source}</span>
        {wantsZh && (
          <div className="seg-control" role="radiogroup" aria-label="字幕显示">
            {(["bilingual", "translation", "original"] as const).map((m) => (
              <button key={m} role="radio" aria-checked={settings.subtitleMode === m} className={settings.subtitleMode === m ? "on" : ""} onClick={() => saveSettings({ subtitleMode: m })}>
                {m === "bilingual" ? "双语" : m === "translation" ? "中文" : "原文"}
              </button>
            ))}
          </div>
        )}
        <div className="spacer" />
        {searching ? (
          <div className="search-inline">
            <Search size={14} />
            <input autoFocus spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索文稿" onKeyDown={(e) => e.key === "Escape" && (setQuery(""), setSearching(false))} />
            {matches && <span className="muted">{matches.length}</span>}
            <button className="icon-btn sm" onClick={() => { setQuery(""); setSearching(false); }}><X size={14} /></button>
          </div>
        ) : (
          <button className="icon-btn" title="搜索文稿" onClick={() => setSearching(true)}><Search size={16} /></button>
        )}
      </div>
      {wantsZh && translation && done < total && (
        <div className="translate-bar">
          {translation.running ? (
            <>
              <Loader2 className="spin" size={14} />
              <span>正在翻译 {done}/{total}</span>
              <div className="bar"><div style={{ width: `${(done / total) * 100}%` }} /></div>
              <button className="btn ghost sm" onClick={() => stopTranslation(ep.id)}><Square size={12} /> 停止</button>
            </>
          ) : (
            <>
              <Languages size={14} />
              <span className="grow">{barError ? (needsSetup ? barError : `翻译未完成：${barError}`) : done ? `已翻译 ${done}/${total}` : "翻译成中文，对照阅读"}</span>
              {needsSetup
                ? <button className="btn primary sm" onClick={() => useStore.getState().openSettings("model")}>去设置</button>
                : <button className="btn primary sm" onClick={startTranslate}>{done ? "继续翻译" : "翻译成中文"}</button>}
            </>
          )}
        </div>
      )}
      <div className="lines" ref={list} onWheel={() => (userScrolled.current = Date.now())}>
        {rows.map((i) => (
          <Row key={i} seg={segments[i]} zh={translation?.items[i]} active={i === active} mode={wantsZh ? settings.subtitleMode : "original"} onSeek={seek} query={query} />
        ))}
        {matches?.length === 0 && <p className="muted center">没有找到「{query}」</p>}
      </div>
    </div>
  );
}

function useModels() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const refresh = () => api.asrModels().then(setModels);
  useEffect(() => { void refresh(); }, []);
  return { models, refresh };
}

export function useModelDownload(onDone: () => void) {
  const [downloading, setDownloading] = useState<{ id: string; received: number; total?: number } | null>(null);
  useEffect(() => {
    const un = listen<{ id: string; received: number; total?: number }>("model-download", (e) => setDownloading(e.payload));
    return () => { void un.then((f) => f()); };
  }, []);
  const start = async (id: string, mirrorFirst: boolean) => {
    setDownloading({ id, received: 0 });
    try { await api.downloadModel(id, mirrorFirst); onDone(); return true; }
    catch (e) { if (!errorText(e).includes("取消")) useStore.getState().notify(`模型下载失败：${errorText(e)}`); return false; }
    finally { setDownloading(null); }
  };
  return { downloading, start, cancel: (id: string) => api.cancelJob(`model:${id}`) };
}

function GeneratePanel({ ep, note }: { ep: Episode; note: string }) {
  const { settings, saveSettings } = useStore();
  const { models, refresh } = useModels();
  const { downloading, start, cancel } = useModelDownload(refresh);
  const model = models.find((m) => m.id === settings.asrModel) ?? models[0];
  const generate = async () => {
    if (!model) return;
    if (!model.installed && !(await start(model.id, settings.mirrorFirst))) return;
    void generateTranscript(ep, model.id, settings.asrLanguage);
  };
  return (
    <div className="panel-empty generate">
      <Wand2 size={28} className="accent" />
      <p className="lead">{note}</p>
      <p className="muted">用本机模型生成字幕，音频不会离开你的电脑。</p>
      <div className="gen-options">
        <label>
          <span>识别模型</span>
          <select value={model?.id} onChange={(e) => saveSettings({ asrModel: e.target.value })}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}{m.installed ? "" : ` · 需下载 ${m.sizeMb} MB`}</option>)}
          </select>
        </label>
        <label>
          <span>说话语言</span>
          <select value={settings.asrLanguage} onChange={(e) => saveSettings({ asrLanguage: e.target.value })}>
            <option value="auto">自动识别</option><option value="en">英语</option><option value="zh">中文</option><option value="ja">日语</option><option value="ko">韩语</option><option value="de">德语</option><option value="fr">法语</option><option value="es">西班牙语</option>
          </select>
        </label>
      </div>
      {model && <p className="muted small">{model.note}</p>}
      {downloading ? (
        <div className="progress-block">
          <span>正在下载模型 {downloading.total ? `${Math.round((downloading.received / downloading.total) * 100)}%` : `${Math.round(downloading.received / 1048576)} MB`}</span>
          <div className="bar"><div style={{ width: `${downloading.total ? (downloading.received / downloading.total) * 100 : 5}%` }} /></div>
          <button className="btn ghost sm" onClick={() => cancel(downloading.id)}>取消</button>
        </div>
      ) : (
        <button className="btn primary" onClick={generate} disabled={!model}>{model?.installed ? "生成字幕" : `下载模型并生成字幕`}</button>
      )}
    </div>
  );
}

function Generating({ ep }: { ep: Episode }) {
  const asr = useJobs((s) => s.asr[ep.id]);
  const { player, current } = useStore();
  if (!asr) return null;
  if (asr.stage === "error") {
    return (
      <div className="panel-empty">
        <p className="lead">字幕没有生成成功</p>
        <p className="muted">{asr.message}</p>
        <button className="btn primary" onClick={() => useJobs.setState((s) => { const a = { ...s.asr }; delete a[ep.id]; return { asr: a }; })}>重新选择</button>
      </div>
    );
  }
  const label = asr.stage === "download" ? (asr.message ?? "正在获取音频") : "正在识别";
  return (
    <div className="transcript">
      <div className="translate-bar">
        <Loader2 className="spin" size={14} />
        <span>{label} {Math.round(asr.progress * 100)}%</span>
        <div className="bar"><div style={{ width: `${asr.progress * 100}%` }} /></div>
        <button className="btn ghost sm" onClick={() => api.cancelJob(ep.id)}>取消</button>
      </div>
      <div className="lines">
        {asr.live.map((s, i) => (
          <div className="line" key={i} role="button" tabIndex={0} onClick={() => current?.id === ep.id && player?.seek(s.start)}>
            <span className="line-time">{clock(s.start)}</span>
            <div className="line-text"><p className="orig">{s.text}</p></div>
          </div>
        ))}
        {!asr.live.length && <p className="muted center">{useStore.getState().settings.asrModel === "qwen3-asr" ? "Qwen3-ASR 识别完成后会一次性显示全部文字" : "识别出的文字会实时出现在这里"}</p>}
      </div>
    </div>
  );
}
