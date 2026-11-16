import { memo, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Loader2, Search, X } from "lucide-react";
import { api, errorText, type Episode, type ModelInfo, type Segment } from "../lib/api";
import { clock } from "../lib/format";
import { generateTranscript, llmReady, loadTranslation, needsTranslation, stopTranslation, translateEpisode, useJobs } from "../lib/jobs";
import { providerFor, useStore } from "../store";

const SOURCE_LABEL: Record<string, string> = { youtube: "YouTube 字幕", "youtube-auto": "YouTube 自动字幕", rss: "节目方文字稿", whisper: "本机识别", cloud: "云端识别", qiaomu: "精读站原文 · 时间为估算" };

export function activeIndex(segments: Segment[], time: number): number {
  let lo = 0, hi = segments.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= time + 0.15) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

function highlight(text: string, query: string) {
  if (!query) return text;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  return i < 0 ? text : <>{text.slice(0, i)}<mark>{text.slice(i, i + query.length)}</mark>{text.slice(i + query.length)}</>;
}

const Row = memo(function Row({ seg, zh, active, mode, pending, onSeek, query, current }: { seg: Segment; zh?: string | null; active: boolean; mode: string; pending: boolean; onSeek: (t: number) => void; query: string; current: boolean }) {
  const showZh = mode !== "original";
  const showOrig = mode !== "translation" || (!zh && !pending);
  return (
    <div className={`line ${active ? "active" : ""} ${current ? "hit" : ""}`} data-active={active || undefined} data-hit={current || undefined} role="button" tabIndex={0} onClick={() => onSeek(seg.start)} onKeyDown={(e) => e.key === "Enter" && onSeek(seg.start)}>
      <span className="line-time">{clock(seg.start)}</span>
      <div className="line-text">
        {showZh && (zh ? <p className="zh">{highlight(zh, query)}</p> : pending ? <span className="skeleton" /> : null)}
        {showOrig && <p className="orig">{highlight(seg.text, query)}</p>}
      </div>
    </div>
  );
});

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

/** The one line under the tabs that says how this episode's subtitles stand, with the one action that applies. */
function StatusLine({ left, text, spin, progress, action, right }: { left?: React.ReactNode; text: React.ReactNode; spin?: boolean; progress?: number; action?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="status-line">
      {left}
      <span className="status-text" key={typeof text === "string" ? text : undefined}>{spin && <Loader2 size={13} className="spin" />}{text}</span>
      {progress != null && <div className="bar slim"><div style={{ width: `${Math.max(2, progress * 100)}%` }} /></div>}
      <div className="spacer" />
      {action}
      {right}
    </div>
  );
}

export function TranscriptPanel({ ep }: { ep: Episode }) {
  const transcript = useJobs((s) => s.transcripts[ep.id]);
  const official = useJobs((s) => s.officialChecked[ep.id]);
  const officialError = useJobs((s) => s.officialError[ep.id]);
  const translation = useJobs((s) => s.translations[ep.id]);
  const { time, player, settings, saveSettings, current, openSettings } = useStore();
  const isCurrent = current?.id === ep.id;
  const list = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hit, setHit] = useState(0);
  const [startError, setStartError] = useState<string | null>(null);
  const [canUpgrade, setCanUpgrade] = useState(false);
  const segments = transcript?.segments ?? [];
  const active = isCurrent ? activeIndex(segments, time) : -1;
  const seek = (t: number) => { if (isCurrent) player?.seek(t); };
  const wantsZh = transcript ? needsTranslation(transcript) : false;
  const mode = wantsZh ? settings.subtitleMode : "original";

  useEffect(() => { if (transcript) void loadTranslation(ep.id, transcript.segments.length); }, [transcript, ep.id]);
  useEffect(() => { void llmReady("translate").then(setCanUpgrade); }, [settings]);

  // Foreign-language episodes are translated on open; with no model set up this uses free Google translation.
  useEffect(() => {
    if (!transcript || !translation || translation.running || translation.error) return;
    if (!settings.autoTranslate || !wantsZh || translation.items.every((x) => x != null)) return;
    translateEpisode(ep, transcript).catch((e) => setStartError(errorText(e)));
  }, [transcript, !!translation, settings.autoTranslate]);

  useEffect(() => {
    if (active < 0 || Date.now() - userScrolled.current < 5000 || query) return;
    list.current?.querySelector<HTMLElement>("[data-active]")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active, query]);

  // ⌘F searches the transcript; Enter / ⇧Enter step through matches.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") { e.preventDefault(); setSearching(true); setTimeout(() => searchInput.current?.focus(), 0); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const matches = useMemo(() => {
    if (!query) return null;
    const q = query.toLowerCase();
    return segments.map((s, i) => (s.text.toLowerCase().includes(q) || translation?.items[i]?.toLowerCase().includes(q) ? i : -1)).filter((i) => i >= 0);
  }, [query, segments, translation]);
  useEffect(() => { setHit(0); }, [query]);
  useEffect(() => { list.current?.querySelector<HTMLElement>("[data-hit]")?.scrollIntoView({ block: "center" }); }, [hit, matches]);

  if (!transcript) return <NoTranscript ep={ep} official={official} officialError={officialError} />;

  const total = segments.length;
  const done = Math.min(total, translation?.items.slice(0, total).filter((x) => x != null).length ?? 0);
  const running = !!translation?.running;
  const engineName = translation?.engine === "google" ? "谷歌翻译" : `${providerFor(settings, "translate")?.name ?? "模型"}翻译`;
  const error = startError ?? translation?.error;
  const pending = wantsZh && (running || (settings.autoTranslate && !error && done < total));
  const start = (force?: "llm" | "google") => { setStartError(null); translateEpisode(ep, transcript, force).catch((e) => setStartError(errorText(e))); };

  const modeControl = wantsZh && (
    <div className="seg-control" role="radiogroup" aria-label="字幕显示（快捷键 C）">
      {(["bilingual", "translation", "original"] as const).map((m) => (
        <button key={m} role="radio" aria-checked={settings.subtitleMode === m} className={settings.subtitleMode === m ? "on" : ""} onClick={() => saveSettings({ subtitleMode: m })}>
          {m === "bilingual" ? "双语" : m === "translation" ? "中文" : "原文"}
        </button>
      ))}
    </div>
  );
  const searchBtn = <button className="icon-btn" title="搜索文稿（⌘F）" onClick={() => { setSearching(true); setTimeout(() => searchInput.current?.focus(), 0); }}><Search size={15} /></button>;
  const source = SOURCE_LABEL[transcript.source] ?? transcript.source;

  let status: React.ReactNode;
  if (!wantsZh) status = <StatusLine left={<span className="source-tag">{source}</span>} text="" right={searchBtn} />;
  else if (running) status = <StatusLine left={modeControl} text={`${engineName} · 正在翻译 ${done}/${total}`} spin progress={done / total} action={<button className="btn ghost sm" onClick={() => stopTranslation(ep.id)}>停止</button>} right={searchBtn} />;
  else if (error && /设置|API Key|模型/.test(error)) status = <StatusLine left={modeControl} text={error} action={<button className="btn primary sm" onClick={() => openSettings("model")}>去设置</button>} right={searchBtn} />;
  else if (done < total && (error || translation?.failed)) status = <StatusLine left={modeControl} text={`已翻译 ${done}/${total}${error ? ` · ${error.slice(0, 40)}` : ""}`} action={<button className="btn primary sm" onClick={() => start()}>重试</button>} right={searchBtn} />;
  else if (done < total) status = <StatusLine left={modeControl} text={done ? `已翻译 ${done}/${total}` : source} action={<button className="btn primary sm" onClick={() => start()}>{done ? "继续翻译" : "翻译成中文"}</button>} right={searchBtn} />;
  else status = <StatusLine left={modeControl} text={`${source} · ${engineName}`} action={translation?.engine === "google" && canUpgrade ? <button className="btn ghost sm" onClick={() => start("llm")}>用模型重译</button> : undefined} right={searchBtn} />;

  const rows = matches ?? segments.map((_, i) => i);
  return (
    <div className="transcript">
      {status}
      {searching && (
        <div className="search-row">
          <Search size={14} />
          <input ref={searchInput} spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索中文或原文"
            onKeyDown={(e) => {
              if (e.key === "Escape") { setQuery(""); setSearching(false); }
              if (e.key === "Enter" && matches?.length) setHit((h) => (h + (e.shiftKey ? -1 : 1) + matches.length) % matches.length);
            }} />
          {matches && <span className="muted small">{matches.length ? `${hit + 1}/${matches.length}` : "无结果"}</span>}
          <button className="icon-btn sm" onClick={() => { setQuery(""); setSearching(false); }} aria-label="关闭搜索"><X size={14} /></button>
        </div>
      )}
      <div className="lines" ref={list} onWheel={() => (userScrolled.current = Date.now())}>
        {rows.map((i, k) => (
          <Row key={i} seg={segments[i]} zh={translation?.items[i]} active={i === active} mode={mode} pending={pending} onSeek={seek} query={query} current={!!matches && k === hit} />
        ))}
      </div>
    </div>
  );
}

function NoTranscript({ ep, official, officialError }: { ep: Episode; official?: string; officialError?: string }) {
  const asr = useJobs((s) => s.asr[ep.id]);
  const { settings, saveSettings, player, current } = useStore();
  const { models, refresh } = useModels();
  const { downloading, start, cancel } = useModelDownload(refresh);
  const [options, setOptions] = useState(false);
  const model = models.find((m) => m.id === settings.asrModel) ?? models[0];
  const cloud = settings.asrEngine !== "local" ? settings.cloudAsr[settings.asrEngine] : undefined;
  const generate = async () => {
    if (!model) return;
    if (!cloud && !model.installed && !(await start(model.id, settings.mirrorFirst))) return;
    void generateTranscript(ep, model.id, settings.asrLanguage);
  };
  const retry = () => useJobs.setState((s) => { const a = { ...s.asr }; delete a[ep.id]; return { asr: a }; });

  if (official === "searching" || official === undefined) {
    return <div className="transcript"><StatusLine text="正在查找字幕…" spin /><div className="panel-empty" /></div>;
  }
  if (downloading) {
    const pct = downloading.total ? downloading.received / downloading.total : 0;
    return (
      <div className="transcript">
        <StatusLine text={`正在下载识别模型 · ${Math.round(pct * 100)}% · 可以先听`} spin progress={pct} action={<button className="btn ghost sm" onClick={() => cancel(downloading.id)}>取消</button>} />
        <div className="panel-empty"><p className="muted">下载完成后会自动开始识别，之后不再需要下载。</p></div>
      </div>
    );
  }
  if (asr && asr.stage !== "done") {
    if (asr.stage === "error") {
      return (
        <div className="transcript">
          <StatusLine text={`字幕没有生成成功：${(asr.message ?? "").slice(0, 60)}`} action={<button className="btn primary sm" onClick={retry}>重试</button>} />
          <div className="panel-empty"><p className="muted">可以换一个识别模型，或检查网络后重试。</p></div>
        </div>
      );
    }
    const label = asr.stage === "download" ? (asr.message ?? "正在获取音频") : asr.message ?? (ep.duration ? `正在识别 · ${clock(asr.progress * ep.duration)} / ${clock(ep.duration)}` : "正在识别");
    return (
      <div className="transcript">
        <StatusLine text={`${label} · ${Math.round(asr.progress * 100)}%`} spin progress={asr.progress} action={<button className="btn ghost sm" onClick={() => api.cancelJob(ep.id)}>取消</button>} />
        <div className="lines">
          {asr.live.map((s, i) => (
            <div className="line" key={i} role="button" tabIndex={0} onClick={() => current?.id === ep.id && player?.seek(s.start)}>
              <span className="line-time">{clock(s.start)}</span>
              <div className="line-text"><p className="orig">{s.text}</p></div>
            </div>
          ))}
          {!asr.live.length && <p className="muted center">{settings.asrModel === "qwen3-asr" ? "识别完成后会一次性显示全部文字" : "识别出的文字会实时出现在这里"}</p>}
        </div>
      </div>
    );
  }
  const needsDownload = !cloud && model && !model.installed;
  const reason = official === "error" ? `读取字幕失败：${officialError}` : "这集没有字幕";
  return (
    <div className="transcript">
      <StatusLine text={needsDownload ? `${reason} · 首次需下载识别模型（约 ${model.sizeMb >= 900 ? "1 GB" : `${model.sizeMb} MB`}，仅一次）` : reason}
        action={<button className="btn primary sm" onClick={generate} disabled={!model}>{needsDownload ? "下载并生成字幕" : "生成字幕"}</button>} />
      <div className="panel-empty">
        <p className="lead">{cloud ? `用${cloud.name}生成字幕` : "用本机模型生成字幕"}</p>
        <p className="muted">{cloud ? "音频会发送到所选的云端识别服务，速度更快。可在设置 › 语音识别里切换回本机。" : "音频只在本机处理，识别完即删除。生成后会自动翻译成中文。"}</p>
        <button className="link-btn" onClick={() => setOptions(!options)}>{options ? "收起识别设置" : "识别设置"}</button>
        {options && (
          <div className="gen-options">
            <label><span>识别模型</span>
              <select value={model?.id} onChange={(e) => saveSettings({ asrModel: e.target.value })}>
                {models.map((m) => <option key={m.id} value={m.id}>{m.name}{m.installed ? "" : ` · ${m.sizeMb} MB`}</option>)}
              </select>
            </label>
            <label><span>说话语言</span>
              <select value={settings.asrLanguage} onChange={(e) => saveSettings({ asrLanguage: e.target.value })}>
                <option value="auto">自动识别</option><option value="en">英语</option><option value="zh">中文</option><option value="ja">日语</option><option value="ko">韩语</option><option value="de">德语</option><option value="fr">法语</option><option value="es">西班牙语</option>
              </select>
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
