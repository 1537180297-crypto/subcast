import { useShallow } from "zustand/react/shallow";
import { SkeletonLines } from "./Skeleton";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, Languages, Loader2, Search, X } from "lucide-react";
import { CassetteArt, FlatLineArt, NightNote, TrayArt, WaveToTextArt } from "./Illustrations";
import { bytes } from "../lib/offline";
import { api, errorText, rawErrorText, type Episode, type ModelInfo, type Segment } from "../lib/api";
import { clock } from "../lib/format";
import { generateTranscript, llmReady, loadTranslation, needsTranslation, stopTranslation, switchYoutubeTrack, translateEpisode, useJobs } from "../lib/jobs";
import { providerFor, useStore } from "../store";
import { ASR_SERVICES } from "../lib/settings";
import { lang, t, tk, tr, useLang } from "../lib/i18n";

const SOURCE_LABEL: Record<string, string> = { youtube: tk("YouTube 字幕"), "youtube-auto": tk("YouTube 自动字幕"), rss: tk("节目方文字稿"), whisper: tk("本机识别"), cloud: tk("云端识别"), qiaomu: tk("精读站原文 · 时间为估算"), podscribe: tk("Podscribe 文字稿") };

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
    catch (e) { if (!rawErrorText(e).includes("取消")) useStore.getState().notify(t("模型下载失败：{error}", { error: errorText(e) })); return false; } // i18n-ignore (matches the backend's cancel message)
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
  const { time, player, settings, saveSettings, current, openSettings } = useStore(useShallow((s) => ({ time: s.time, player: s.player, settings: s.settings, saveSettings: s.saveSettings, current: s.current, openSettings: s.openSettings })));
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
  const providerName = providerFor(settings, "translate")?.name;
  const engineName = translation?.engine === "youtube" ? t("节目方中文字幕") : translation?.engine === "google" ? t("谷歌翻译") : t("{name}翻译", { name: providerName ? t(providerName) : t("模型") });
  const error = startError ?? translation?.error;
  const pending = wantsZh && (running || (settings.autoTranslate && !error && done < total));
  const start = (force?: "llm" | "google") => { setStartError(null); translateEpisode(ep, transcript, force).catch((e) => setStartError(rawErrorText(e))); };

  const modeControl = wantsZh && (
    <div className="seg-control" role="radiogroup" aria-label={t("字幕显示（快捷键 C）")}>
      {(["bilingual", "translation", "original"] as const).map((m) => (
        <button key={m} role="radio" aria-checked={settings.subtitleMode === m} className={settings.subtitleMode === m ? "on" : ""} onClick={() => saveSettings({ subtitleMode: m })}>
          {m === "bilingual" ? t("双语") : m === "translation" ? t("中文") : t("原文")}
        </button>
      ))}
    </div>
  );
  const searchBtn = <>
    {transcript.source.startsWith("youtube") && <TrackPicker ep={ep} language={transcript.language} auto={transcript.source === "youtube-auto"} />}
    <button className="icon-btn" title={t("搜索文稿（⌘F）")} onClick={() => { setSearching(true); setTimeout(() => searchInput.current?.focus(), 0); }}><Search size={15} /></button>
  </>;
  const source = SOURCE_LABEL[transcript.source] ? t(SOURCE_LABEL[transcript.source]) : transcript.source;

  let status: React.ReactNode;
  if (!wantsZh) status = <StatusLine left={<span className="source-tag">{source}</span>} text="" right={searchBtn} />;
  else if (running) status = <StatusLine left={modeControl} text={t("{engine} · 正在翻译 {done}/{total}", { engine: engineName, done, total })} spin progress={done / total} action={<button className="btn ghost sm" onClick={() => stopTranslation(ep.id)}>{t("停止")}</button>} right={searchBtn} />;
  else if (error && /设置|API Key|模型/.test(error)) status = <StatusLine left={modeControl} text={tr(error)} action={<button className="btn primary sm" onClick={() => openSettings("model")}>{t("去设置")}</button>} right={searchBtn} />;
  else if (done < total && (error || translation?.failed)) status = <StatusLine left={modeControl} text={`${t("已翻译 {done}/{total}", { done, total })}${error ? ` · ${tr(error).slice(0, 40)}` : ""}`} action={<button className="btn primary sm" onClick={() => start()}>{t("重试")}</button>} right={searchBtn} />;
  else if (done < total) status = <StatusLine left={modeControl} text={done ? t("已翻译 {done}/{total}", { done, total }) : source} action={<button className="btn primary sm" onClick={() => start()}>{done ? t("继续翻译") : t("翻译成中文")}</button>} right={searchBtn} />;
  else status = <StatusLine left={modeControl} text={`${source} · ${engineName}`} action={translation?.engine === "google" && canUpgrade ? <button className="btn ghost sm" onClick={() => start("llm")}>{t("用模型重译")}</button> : undefined} right={searchBtn} />;

  const rows = matches ?? segments.map((_, i) => i);
  return (
    <div className="transcript">
      {status}
      {searching && (
        <div className="search-row">
          <Search size={14} />
          <input ref={searchInput} spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("搜索中文或原文")}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setQuery(""); setSearching(false); }
              if (e.key === "Enter" && matches?.length) setHit((h) => (h + (e.shiftKey ? -1 : 1) + matches.length) % matches.length);
            }} />
          {matches && <span className="muted small">{matches.length ? `${hit + 1}/${matches.length}` : t("无结果")}</span>}
          <button className="icon-btn sm" onClick={() => { setQuery(""); setSearching(false); }} aria-label={t("关闭搜索")}><X size={14} /></button>
        </div>
      )}
      <div className="lines" ref={list} onWheel={() => (userScrolled.current = Date.now())}>
        {rows.map((i, k) => (
          <Row key={i} seg={segments[i]} zh={translation?.items[i]} active={i === active} mode={mode} pending={pending} onSeek={seek} query={query} current={!!matches && k === hit} />
        ))}
        {!matches && total > 0 && (
          <div className={`lines-end ${active === total - 1 ? "reached" : ""}`}>
            <FlatLineArt />
            {active === total - 1 && <p>{t("到最后一句了，耳朵辛苦了")}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

const trackCache = new Map<string, { language: string; auto: boolean }[]>();
/** The subtitle language, when the video has captions in more than one. */
function TrackPicker({ ep, language, auto }: { ep: Episode; language: string; auto: boolean }) {
  const [tracks, setTracks] = useState(trackCache.get(ep.id) ?? null);
  const [busy, setBusy] = useState(false);
  useLang((s) => s.lang);
  useEffect(() => {
    if (tracks) return;
    void api.youtubeTracks(ep.id).then((list) => { trackCache.set(ep.id, list); setTracks(list); }).catch(() => {});
  }, [ep.id]);
  if (!tracks || tracks.length < 2) return null;
  let names: Intl.DisplayNames | null = null;
  try { names = new Intl.DisplayNames([lang()], { type: "language" }); } catch { /* old WebView */ }
  const name = (l: string) => { try { return names?.of(l) ?? l; } catch { return l; } };
  const value = `${auto ? "a" : "m"}:${language}`;
  const pick = async (v: string) => {
    const [kind, ...rest] = v.split(":");
    setBusy(true);
    try { await switchYoutubeTrack(ep, rest.join(":"), kind === "a"); }
    catch (e) { useStore.getState().notify(t("切换字幕失败：{error}", { error: errorText(e) })); }
    finally { setBusy(false); }
  };
  return (
    <label className="track-pick" title={t("字幕语言")}>
      {busy ? <Loader2 size={13} className="spin" /> : <Languages size={14} />}
      <select value={value} disabled={busy} onChange={(e) => void pick(e.target.value)} aria-label={t("字幕语言")}>
        {tracks.map((x) => <option key={`${x.auto}:${x.language}`} value={`${x.auto ? "a" : "m"}:${x.language}`}>{name(x.language)}{x.auto ? ` · ${t("自动生成")}` : ""}</option>)}
      </select>
      <ChevronDown size={12} />
    </label>
  );
}

function NoTranscript({ ep, official, officialError }: { ep: Episode; official?: string; officialError?: string }) {
  const asr = useJobs((s) => s.asr[ep.id]);
  const { settings, saveSettings, player, current } = useStore(useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings, player: s.player, current: s.current })));
  const { models, refresh } = useModels();
  const { downloading, start, cancel } = useModelDownload(refresh);
  const [options, setOptions] = useState(false);
  const model = models.find((m) => m.id === settings.asrModel) ?? models[0];
  const cloud = settings.asrEngine !== "local" ? settings.cloudAsr[settings.asrEngine] : undefined;
  const [cloudKey, setCloudKey] = useState<boolean | null>(null);
  const settingsOpen = useStore((s) => s.settingsOpen);
  useEffect(() => {
    setCloudKey(null);
    if (cloud?.needsKey && !settingsOpen) void api.hasApiKey(`asr.${cloud.id}`).then(setCloudKey);
  }, [cloud?.id, settingsOpen]);
  const missingKey = !!cloud?.needsKey && cloudKey === false;
  const pickEngine = (value: string) => {
    const [kind, id] = value.split(":");
    void saveSettings(kind === "cloud" ? { asrEngine: id } : { asrEngine: "local", asrModel: id });
  };
  const generate = async () => {
    if (!model) return;
    if (missingKey) { useStore.getState().openSettings("asr"); return; }
    if (!cloud && !model.installed && !(await start(model.id, settings.mirrorFirst))) return;
    void generateTranscript(ep, model.id, settings.asrLanguage);
  };
  const retry = () => useJobs.setState((s) => { const a = { ...s.asr }; delete a[ep.id]; return { asr: a }; });

  if (official === "searching" || official === undefined) {
    return <div className="transcript"><StatusLine text={t("正在查找字幕…")} spin /><SkeletonLines /></div>;
  }
  if (downloading) {
    const pct = downloading.total ? downloading.received / downloading.total : 0;
    return (
      <GenCard icon={<TrayArt busy />} title={t("正在准备识别模型")} note={t("只需下载这一次，完成后自动生成字幕。可以先听着。")}>
        <div className="gen-progress"><div className="bar live"><div style={{ width: `${Math.max(2, pct * 100)}%` }} /></div><span>{Math.round(pct * 100)}%</span></div>
        {downloading.total ? <p className="gen-size num">{bytes(downloading.received)} / {bytes(downloading.total)}</p> : null}
        <button className="btn ghost sm" onClick={() => cancel(downloading.id)}>{t("取消")}</button>
      </GenCard>
    );
  }
  if (asr && asr.stage !== "done") {
    if (asr.stage === "error") {
      return (
        <GenCard icon={<CassetteArt mode="tangled" />} title={t("字幕没有生成成功")} note={t("可以换一个识别模型，或检查网络后再试。")}>
          {asr.message && <p className="gen-warn" title={tr(asr.message)}><span>{plainError(tr(asr.message))}</span></p>}
          <button className="btn primary gen-go" onClick={retry}>{t("重试")}</button>
        </GenCard>
      );
    }
    const label = asr.message ? tr(asr.message) : asr.stage === "download" ? t("正在获取音频") : ep.duration ? t("正在识别 · {elapsed} / {total}", { elapsed: clock(asr.progress * ep.duration), total: clock(ep.duration) }) : t("正在识别");
    return (
      <div className="transcript">
        <StatusLine text={`${label} · ${Math.round(asr.progress * 100)}%`} spin progress={asr.progress} action={<button className="btn ghost sm" onClick={() => api.cancelJob(ep.id)}>{t("取消")}</button>} />
        <div className="lines">
          {asr.live.map((s, i) => (
            <div className="line live" key={i} role="button" tabIndex={0} onClick={() => current?.id === ep.id && player?.seek(s.start)}>
              <span className="line-time">{clock(s.start)}</span>
              <div className="line-text"><p className="orig">{s.text}{i === asr.live.length - 1 && <span className="live-caret" aria-hidden />}</p></div>
            </div>
          ))}
          {!asr.live.length && (
            <div className="asr-wait">
              <CassetteArt mode={asr.stage === "download" ? "fetch" : "listen"} />
              <p className="muted">{asr.stage === "download" ? t("先把音频取回来，马上开始听写") : settings.asrModel === "qwen3-asr" ? t("识别完成后会一次性显示全部文字") : t("识别出的文字会实时出现在这里")}</p>
            </div>
          )}
        </div>
      </div>
    );
  }
  const needsDownload = !cloud && model && !model.installed;
  const size = model ? (model.sizeMb >= 900 ? `${(model.sizeMb / 1024).toFixed(1)} GB` : `${model.sizeMb} MB`) : "";
  return (
    <GenCard icon={<WaveToTextArt />} title={t("这集还没有字幕")}
      note={cloud ? t("用{name}生成，音频会上传到该服务，速度更快。生成后自动翻译成中文。", { name: t(cloud.name) }) : t("用本机模型生成，音频只在这台电脑上处理。生成后自动翻译成中文。")}>
      {official === "error" && officialError && <p className="gen-warn" title={tr(officialError)}><span>{t("节目自带的字幕没读到：{error}", { error: plainError(tr(officialError)) })}</span></p>}
      <button className="btn primary gen-go" onClick={generate} disabled={!model}>{missingKey ? t("先填写 API Key") : t("生成字幕")}</button>
      {needsDownload && <p className="gen-size">{t("第一次会先下载识别模型（约 {size}），之后不用再下载", { size })}</p>}
      {missingKey && <p className="gen-size">{t("用{name}识别需要它的 API Key，填好就能开始", { name: t(cloud!.name) })}</p>}
      <button className="link-btn gen-more" aria-expanded={options} onClick={() => setOptions(!options)}>{t("识别设置")}<ChevronDown size={12} className={options ? "flip" : ""} /></button>
      {!options && <NightNote />}
      {options && (
        <div className="gen-options">
          <label><span>{t("识别方式")}</span>
            <select value={cloud ? `cloud:${cloud.id}` : `local:${model?.id}`} onChange={(e) => pickEngine(e.target.value)}>
              <optgroup label={t("本机模型 · 音频不出本机")}>
                {models.map((m) => <option key={m.id} value={`local:${m.id}`}>{tr(m.name)}{m.installed ? "" : ` · ${m.sizeMb} MB`}</option>)}
              </optgroup>
              <optgroup label={t("云端服务 · 更快，需要 Key")}>
                {ASR_SERVICES.map((a) => <option key={a.id} value={`cloud:${a.id}`}>{t(a.name)}</option>)}
              </optgroup>
            </select>
          </label>
          <label><span>{t("说话语言")}</span>
            <select value={settings.asrLanguage} onChange={(e) => saveSettings({ asrLanguage: e.target.value })}>
              <option value="auto">{t("自动识别")}</option><option value="en">{t("英语")}</option><option value="zh">{t("中文")}</option><option value="ja">{t("日语")}</option><option value="ko">{t("韩语")}</option><option value="de">{t("德语")}</option><option value="fr">{t("法语")}</option><option value="es">{t("西班牙语")}</option>
            </select>
          </label>
        </div>
      )}
    </GenCard>
  );
}

/** An error for reading: long addresses carry no meaning for the listener (the full text stays in the tooltip). */
const plainError = (m: string) => m.replace(/[：:]?\s*https?:\/\/\S+/g, "").trim() || m;

/** The centred card shown in the subtitle panel while an episode has no subtitles yet. */
function GenCard({ icon, title, note, children }: { icon: React.ReactNode; title: string; note: string; children?: React.ReactNode }) {
  return (
    <div className="transcript">
      <div className="gen-wrap">
        <div className="gen-card">
          <span className="gen-art" aria-hidden>{icon}</span>
          <h3 className="gen-title">{title}</h3>
          <p className="gen-note">{note}</p>
          {children}
        </div>
      </div>
    </div>
  );
}
