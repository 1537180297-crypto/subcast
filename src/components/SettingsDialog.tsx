import { ask } from "../lib/confirm";
import { useShallow } from "zustand/react/shallow";
import { useEffect, useState } from "react";
import { BookOpen, Check, ChevronDown, Cloud, Cpu, ExternalLink, FolderOpen, Github, Loader2, MessageCircle, Play, RefreshCw, Square, Trash2, X } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { ASR_SERVICES, VOICES } from "../lib/settings";
import { speak, stopSpeaking } from "../lib/tts";
import logoUrl from "../assets/logo.png";
import wechatQr from "../assets/about-wechat-qr.jpg";
import rewardQr from "../assets/about-reward-qr.png";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, errorText, llmChat, type CloudAsr, type ModelInfo, type Provider } from "../lib/api";
import { llmReady } from "../lib/jobs";
import { useStore } from "../store";
import { Modal } from "./Chrome";
import { bytes, clearDownloads, useOffline } from "../lib/offline";
import { HomeShowCard } from "./YtPromo";
import { useModelDownload } from "./TranscriptPanel";
import { LANGS, systemLang, t, tk, tr, type LangSetting, IS_MAC } from "../lib/i18n";
import { ModelSettings } from "./ModelSettings";
import { ShortcutSettings } from "./ShortcutSettings";
import { DOWNLOAD_PAGE, checkForUpdate, hasUpdate, installUpdate, useUpdate } from "../lib/updater";

const NO_AUTO = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

function ProviderEditor({ p, onChange }: { p: Provider; onChange: (p: Provider) => void }) {
  const { settings, saveSettings } = useStore(useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings })));
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testOk, setTestOk] = useState(false);
  const [live, setLive] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => { setKey(""); setLive(null); setAdvanced(!p.needsKey); api.hasApiKey(p.id).then(setHasKey); }, [p.id]);
  const fetchModels = async () => {
    setFetching(true); setTesting(null); setTestOk(false);
    try { if (key.trim()) await saveKey(); const ids = await api.listModels(p); setLive(ids); if (!ids.length) setTesting(t("这个服务没有返回模型列表，请手动填写")); }
    catch (e) { setTesting(errorText(e)); } finally { setFetching(false); }
  };
  const saveKey = async () => { await api.setApiKey(p.id, key); setHasKey(!!key.trim()); setKey(""); };
  const test = async () => {
    setTesting("…"); setTestOk(false);
    try {
      if (key.trim()) await saveKey();
      const r = await llmChat({ provider: p, system: "Reply with one short word.", messages: [{ role: "user", content: "ping" }], maxTokens: 400 });
      setTesting(t("可用 ✓ {reply}", { reply: r.slice(0, 20) })); setTestOk(true);
    } catch (e) { setTesting(errorText(e)); }
  };
  const forChat = settings.chatProvider === p.id;
  const forTranslate = settings.translateProvider === p.id;
  return (
    <div className="provider-form">
      {p.needsKey && (
        <div className="setup-block">
          <div className="setup-head">
            <p className="setup-title">API Key{hasKey && <span className="ok-text small"> · {t("已保存")}</span>}</p>
            {p.keyUrl && <button className="link-btn" onClick={() => openUrl(p.keyUrl!)}>{t("去官网申请")} <ExternalLink size={11} /></button>}
          </div>
          <div className="key-row">
            <input {...NO_AUTO} type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? t("已保存（存于系统钥匙串）") : t("粘贴 API Key")} />
            <button className="btn sm" onClick={saveKey} disabled={!key.trim()}>{t("保存")}</button>
            {hasKey && <button className="icon-btn" title={t("删除 Key")} onClick={async () => { await api.setApiKey(p.id, ""); setHasKey(false); }}><Trash2 size={14} /></button>}
          </div>
        </div>
      )}
      <div className="setup-block">
        <p className="setup-title">{t("用它做什么")}</p>
        <div className="use-picks">
          <button className={`chip sm ${forChat ? "on" : ""}`} aria-pressed={forChat} onClick={() => !forChat && saveSettings({ chatProvider: p.id, chatModel: "", modelChosen: true })}>{forChat && <Check size={12} />}{t("问答与导读")}</button>
          <button className={`chip sm ${forTranslate ? "on" : ""}`} aria-pressed={forTranslate} onClick={() => !forTranslate && saveSettings({ translateProvider: p.id, modelChosen: true })}>{forTranslate && <Check size={12} />}{t("字幕翻译")}</button>
        </div>
        <p className="muted small">{t("每项用途只能交给一个服务，选中后原来的会自动换下。")}</p>
      </div>
      <div className="row-actions">
        <button className="btn sm" onClick={test} disabled={testing === "…"}>{testing === "…" && <Loader2 size={13} className="spin" />} {t("测试连接")}</button>
        {testing && testing !== "…" && <span className={testOk ? "ok-text small" : "error-text small"}>{testing}</span>}
        <span className="spacer" />
        <button className="adv-toggle" onClick={() => setAdvanced(!advanced)}><ChevronDown size={12} className={advanced ? "flip" : ""} /> {t("高级设置")}</button>
      </div>
      {advanced && (
        <div className="adv-body">
          <label><span>{t("接口类型")}</span>
            <select value={p.protocol} onChange={(e) => onChange({ ...p, protocol: e.target.value as Provider["protocol"] })}>
              <option value="openai">{t("OpenAI 兼容")}</option><option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label><span>{t("接口地址")}</span><input {...NO_AUTO} value={p.baseUrl} onChange={(e) => onChange({ ...p, baseUrl: e.target.value })} placeholder="https://…/v1" /></label>
          <label><span>{t("模型")}</span>
            <input {...NO_AUTO} value={p.model} list={`models-${p.id}`} onChange={(e) => onChange({ ...p, model: e.target.value })} placeholder={t("模型名")} />
            <datalist id={`models-${p.id}`}>{[...new Set([...(live ?? []), ...(p.models ?? [])])].map((m) => <option key={m} value={m} />)}</datalist>
          </label>
          {(p.models?.length || live?.length) ? (
            <div className="model-chips">
              {[...new Set([...(p.models ?? []), ...(live ?? []).slice(0, 40)])].map((m) => <button key={m} className={`chip sm ${p.model === m ? "on" : ""}`} onClick={() => onChange({ ...p, model: m })}>{m}</button>)}
            </div>
          ) : null}
          <div className="row-actions">
            <button className="btn ghost sm" onClick={fetchModels} disabled={fetching}>{fetching ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} {t("获取模型列表")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsDialog() {
  const { settings, saveSettings, set, notify, settingsSection } = useStore(useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings, set: s.set, notify: s.notify, settingsSection: s.settingsSection })));
  type Section = "overview" | "model" | "asr" | "tts" | "shortcuts" | "general" | "storage" | "about";
  const [section, setSection] = useState<Section>((settingsSection as Section) ?? "overview");
  const [chatOk, setChatOk] = useState<boolean | null>(null);
  const [trOk, setTrOk] = useState<boolean | null>(null);
  useEffect(() => { void llmReady("chat").then(setChatOk); void llmReady("translate").then(setTrOk); }, [settings, section]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [proxy, setProxy] = useState(settings.proxy);
  const proxyHint = t("留空使用系统代理，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:7890"); // i18n-ignore: scripts/i18n.mjs reads the URL's "//" as a comment; the key is still extracted
  const refresh = () => api.asrModels().then(setModels);
  const { downloading, start, cancel } = useModelDownload(refresh);
  useEffect(() => { void refresh(); }, []);
  const updateWaiting = useUpdate(hasUpdate);
  const NAV: [Section, string][] = [["overview", tk("概览")], ["model", tk("AI 模型")], ["asr", tk("语音识别")], ["tts", tk("朗读")], ["shortcuts", tk("快捷键")], ["general", tk("通用")], ["storage", tk("存储")], ["about", tk("关于")]];

  return (
    <Modal title={t("设置")} onClose={() => { stopSpeaking(); set({ settingsOpen: false }); }} wide>
      <div className="settings">
        <nav className="settings-nav">
          {NAV.map(([k, label]) => <button key={k} className={section === k ? "on" : ""} onClick={() => setSection(k)}>{t(label)}{k === "about" && updateWaiting && <span className="update-dot" aria-label={t("有新版本")} />}</button>)}
        </nav>
        <div className="settings-body">
          {section === "overview" && (
            <div className="overview">
              <div className="ov-card">
                <div className="ov-head"><p className="ov-title">{t("字幕翻译")}</p><span className={`pill ok`}>{trOk ? t(settings.providers[settings.translateProvider]?.name ?? "") : t("谷歌翻译 · 免费")}</span></div>
                <p className="muted small">{trOk ? t("用你的模型翻译，译文更通顺、术语更准。") : t("无需设置即可使用；连接自己的模型可获得更好的译文。")}</p>
                <div className="seg-control">
                  {([["auto", t("自动")], ["google", t("谷歌翻译")], ["llm", t("我的模型")]] as const).map(([k, label]) => (
                    <button key={k} className={settings.translateMode === k ? "on" : ""} onClick={() => saveSettings({ translateMode: k })}>{label}</button>
                  ))}
                </div>
                <label className="check"><input type="checkbox" checked={settings.autoTranslate} onChange={(e) => saveSettings({ autoTranslate: e.target.checked })} /> {t("打开外语节目时自动翻译字幕")}</label>
                {trOk && settings.translateMode !== "google" && (
                  <div className="ov-row">
                    <span className="small">{t("用模型翻译时")}</span>
                    <div className="seg-control">
                      {([["fast", t("快速")], ["best", t("精翻")]] as const).map(([k, label]) => (
                        <button key={k} className={settings.translateQuality === k ? "on" : ""} title={k === "best" ? t("多一遍润色，读起来更像中文口语；花费约为两倍") : t("一遍翻译，最快出字幕")} onClick={() => saveSettings({ translateQuality: k })}>{label}</button>
                      ))}
                    </div>
                  </div>
                )}
                <label className="check" title={t("把标题和节目简介里的人名、公司和术语告诉识别与翻译模型，名字更少写错")}><input type="checkbox" checked={settings.useShowNotes} onChange={(e) => saveSettings({ useShowNotes: e.target.checked })} /> {t("用节目简介辅助识别和翻译")}</label>
                </div>
              <div className="ov-card">
                <div className="ov-head"><p className="ov-title">{t("AI 问答与导读")}</p><span className={`pill ${chatOk ? "ok" : ""}`}>{chatOk ? t(settings.providers[settings.chatProvider]?.name ?? "") : t("未连接")}</span></div>
                <p className="muted small">{t("基于整期文字稿回答问题、生成中文导读。推荐 DeepSeek，国内直连，一集约 ¥0.1。")}</p>
                <button className="btn sm primary" onClick={() => setSection("model")}>{chatOk ? t("管理模型") : t("连接模型")}</button>
              </div>
              <div className="ov-card">
                <div className="ov-head"><p className="ov-title">{t("语音识别")}</p><span className={`pill ${settings.asrEngine !== "local" || models.find((m) => m.id === settings.asrModel)?.installed ? "ok" : ""}`}>{settings.asrEngine !== "local" ? t(settings.cloudAsr[settings.asrEngine]?.name ?? "") : models.find((m) => m.id === settings.asrModel)?.installed ? t("本机 · 已下载") : t("本机 · 未下载")}</span></div>
                <p className="muted small">{t("没有字幕的节目用它生成。本机模型音频不出本机；云端服务更快，适合长节目。")}</p>
                <button className="btn sm" onClick={() => setSection("asr")}>{t("管理")}</button>
              </div>
            </div>
          )}
          {section === "model" && <ModelSettings ProviderEditor={ProviderEditor} />}
          {section === "shortcuts" && <ShortcutSettings />}
          {section === "asr" && (
            <>
              <div className="engine-switch">
                <button className={`engine ${settings.asrEngine === "local" ? "on" : ""}`} onClick={() => saveSettings({ asrEngine: "local" })}>
                  <Cpu size={18} /><div><p>{t("本机模型")}</p><p className="muted small">{t("免费、离线，音频不出本机")}</p></div>
                </button>
                <button className={`engine ${settings.asrEngine !== "local" ? "on" : ""}`} onClick={() => saveSettings({ asrEngine: settings.asrEngine !== "local" ? settings.asrEngine : "doubao" })}>
                  <Cloud size={18} /><div><p>{t("云端服务")}</p><p className="muted small">{t("更快，适合长节目，需要 Key")}</p></div>
                </button>
              </div>
              {settings.asrEngine === "local" ? (
                <>
<p className="muted small">{t("没有官方字幕时，用本机模型识别。音频只在本机处理，识别完即删除。")}</p>
              <div className="model-list">
                {models.filter((m) => !m.id.startsWith("file:")).map((m) => (
                  <div key={m.id} className={`model-item ${settings.asrModel === m.id ? "on" : ""}`}>
                    <div role="button" tabIndex={0} className="model-pick" onClick={() => saveSettings({ asrModel: m.id })}>
                      <span className={`radio ${settings.asrModel === m.id ? "on" : ""}`} />
                      <div><p>{tr(m.name)}</p><p className="muted small">{tr(m.note)} · {m.sizeMb} MB</p></div>
                    </div>
                    {downloading?.id === m.id ? (
                      <div className="dl"><span className="small">{downloading.total ? Math.round((downloading.received / downloading.total) * 100) : 0}%</span><button className="btn ghost sm" onClick={() => cancel(m.id)}>{t("取消")}</button></div>
                    ) : m.installed && m.from ? (
                      <div className="dl"><span className="from-tag small" title={t("这台电脑上已有这个模型，直接使用，不占额外空间")}>{t("来自 {app}", { app: tr(m.from) })}</span><button className="icon-btn" title={t("不再使用（原文件保留）")} onClick={async () => { await api.deleteModel(m.id); void refresh(); }}><X size={14} /></button></div>
                    ) : m.installed ? (
                      <div className="dl"><span className="ok-text small"><Check size={13} /> {t("已下载")}</span><button className="icon-btn" title={t("删除模型")} onClick={async () => { await api.deleteModel(m.id); void refresh(); }}><Trash2 size={14} /></button></div>
                    ) : (
                      <button className="btn sm" onClick={() => start(m.id, settings.mirrorFirst)} disabled={downloading != null}>{t("下载")}</button>
                    )}
                  </div>
                ))}
              </div>
              {models.some((m) => m.id.startsWith("file:")) && (
                <>
                  <p className="model-found-h">{t("这台电脑上其他软件下载过的模型")}<span className="muted small">{t("直接使用，不用再下载")}</span></p>
                  <div className="model-list">
                    {models.filter((m) => m.id.startsWith("file:")).map((m) => (
                      <div key={m.id} className={`model-item ${settings.asrModel === m.id ? "on" : ""}`}>
                        <div role="button" tabIndex={0} className="model-pick" onClick={() => saveSettings({ asrModel: m.id })}>
                          <span className={`radio ${settings.asrModel === m.id ? "on" : ""}`} />
                          <div><p>{m.name}</p><p className="muted small">{m.sizeMb >= 1024 ? `${(m.sizeMb / 1024).toFixed(1)} GB` : `${m.sizeMb} MB`}</p></div>
                        </div>
                        <div className="dl"><span className="from-tag small">{t("来自 {app}", { app: tr(m.from ?? "") })}</span><button className="icon-btn" title={t("不再使用（原文件保留）")} onClick={async () => { await api.deleteModel(m.id); void refresh(); }}><X size={14} /></button></div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <button className="link-btn small" onClick={async () => { await api.rescanModels(); void refresh(); notify(t("已重新查找本机的识别模型")); }}><RefreshCw size={12} /> {t("重新查找本机已有的模型")}</button>
              <label className="check"><input type="checkbox" checked={settings.mirrorFirst} onChange={(e) => saveSettings({ mirrorFirst: e.target.checked })} /> {t("优先从国内镜像（hf-mirror.com）下载模型")}</label>
              <label><span>{t("默认说话语言")}</span>
                <select value={settings.asrLanguage} onChange={(e) => saveSettings({ asrLanguage: e.target.value })}>
                  <option value="auto">{t("自动识别")}</option><option value="en">{t("英语")}</option><option value="zh">{t("中文")}</option><option value="ja">{t("日语")}</option>
                </select>
              </label>
                            </>
              ) : (
                <>
                  <div className="provider-tabs">
                    {ASR_SERVICES.map((a) => <button key={a.id} className={`chip ${settings.asrEngine === a.id ? "on" : ""}`} onClick={() => saveSettings({ asrEngine: a.id })}>{t(a.name)}</button>)}
                  </div>
                  {settings.cloudAsr[settings.asrEngine] && <CloudAsrEditor key={settings.asrEngine} a={settings.cloudAsr[settings.asrEngine]} onChange={(na) => saveSettings({ cloudAsr: { ...settings.cloudAsr, [na.id]: na } })} />}
                </>
              )}
            </>
          )}
          {section === "tts" && <TtsSettings />}
          {section === "general" && (
            <>
              <div className="setup-block">
                <p className="setup-title">{t("订阅")}</p>
                <div className="row-actions">
                  <button className="btn sm" onClick={() => { set({ settingsOpen: false, addOpen: true, addTab: "import" }); }}>{t("导入订阅…")}</button>
                  <button className="btn sm" onClick={async () => { try { const path = await api.exportOpml(); notify(t("已导出到「下载」：{name}", { name: path.split(/[\\/]/).pop() ?? "" })); void revealItemInDir(path).catch(() => {}); } catch (e) { notify(errorText(e)); } }}>{t("导出 OPML")}</button>
                </div>
                <p className="muted small">{t("从 YouTube、小宇宙和其他播客 App 导入；导出的 OPML 可以在其他播客 App 里打开。")}</p>
              </div>
              <label><span>{t("YouTube 要求验证时")}</span>
                <select value={settings.ytCookiesBrowser ?? ""} onChange={(e) => void saveSettings({ ytCookiesBrowser: e.target.value })}>
                  <option value="">{t("不借用浏览器登录")}</option>
                  {(IS_MAC ? ["chrome", "safari", "edge", "firefox", "brave"] : ["chrome", "edge", "firefox", "brave"]).map((b) => <option key={b} value={b}>{t("借用 {name} 的 YouTube 登录", { name: b[0].toUpperCase() + b.slice(1) })}</option>)}
                </select>
              </label>
              <p className="muted small">{t("下载音频或生成字幕时，YouTube 有时会要求「确认不是机器人」。选一个已登录 YouTube 的浏览器，SubCast 会在那时借用它的登录，只在本机读取，不保存。")}</p>
              <label><span>{t("界面语言")}</span>
                <select value={settings.uiLang} onChange={(e) => void saveSettings({ uiLang: e.target.value as LangSetting })}>
                  <option value="auto">{t("跟随系统（{name}）", { name: LANGS.find((l) => l.id === systemLang())?.name ?? "" })}</option>
                  {LANGS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </label>
              <p className="muted small">{t("切换后立即生效。字幕仍翻译成中文。")}</p>
              <label className="check"><input type="checkbox" checked={settings.youtubePromo} onChange={(e) => saveSettings({ youtubePromo: e.target.checked })} /> {t("推荐节目的 YouTube 频道")}</label>
              {settings.youtubePromo && <label className="check"><input type="checkbox" checked={!settings.homeBannerHidden} onChange={(e) => saveSettings({ homeBannerHidden: !e.target.checked })} /> {t("在发现页顶部推荐「词元之外」")}</label>}
              <p className="muted small">{t("节目有官方 YouTube 频道时，在节目页和单集页显示订阅入口，不影响 App 内播放。")}</p>
              <label className="check"><input type="checkbox" checked={settings.shareTranscripts} onChange={(e) => saveSettings({ shareTranscripts: e.target.checked })} /> {t("分享识别好的字幕")}</label>
              <p className="muted small">{t("字幕匿名上传到公共库，别人打开同一集就能直接用，帮他们省一次识别。只上传字幕文本，不含音频。关闭后仍能使用别人分享的字幕。")}</p>
              <label><span>{t("网络代理")}</span>
                <div className="key-row">
                  <input {...NO_AUTO} value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder={proxyHint} />
                  <button className="btn sm" onClick={async () => { try { await saveSettings({ proxy }); notify(t("代理已保存")); } catch (e) { notify(errorText(e)); } }}>{t("保存")}</button>
                </div>
              </label>
              <p className="muted small">{t("在国内访问 YouTube 需要代理。视频画面由系统浏览器内核播放，使用系统代理设置。谷歌翻译连不上时会自动改走国内中转。")}</p>
            </>
          )}
          {section === "storage" && <Storage onAsr={() => setSection("asr")} />}
          {section === "about" && <About />}
        </div>
      </div>
    </Modal>
  );
}

function KeyField({ account, placeholder }: { account: string; placeholder?: string }) {
  const [key, setKey] = useState("");
  const [has, setHas] = useState(false);
  useEffect(() => { setKey(""); api.hasApiKey(account).then(setHas); }, [account]);
  return (
    <div className="key-row">
      <input {...NO_AUTO} type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={has ? t("已保存（存于系统钥匙串）") : placeholder ?? t("粘贴 API Key")} />
      <button className="btn sm" onClick={async () => { await api.setApiKey(account, key); setHas(!!key.trim()); setKey(""); }} disabled={!key.trim()}>{t("保存")}</button>
      {has && <button className="icon-btn" title={t("删除 Key")} onClick={async () => { await api.setApiKey(account, ""); setHas(false); }}><Trash2 size={14} /></button>}
    </div>
  );
}

function CloudAsrEditor({ a, onChange }: { a: CloudAsr; onChange: (a: CloudAsr) => void }) {
  return (
    <div className="provider-form">
      <p className="muted small">{t("{note}。识别时音频会发送到 {name}。", { note: t(a.note), name: t(a.name) })}</p>
      <label><span>{t("接口地址")}</span><input {...NO_AUTO} value={a.baseUrl} onChange={(e) => onChange({ ...a, baseUrl: e.target.value })} /></label>
      <label><span>{t("模型")}</span>
        <input {...NO_AUTO} value={a.model} list={`asr-${a.id}`} onChange={(e) => onChange({ ...a, model: e.target.value })} />
        <datalist id={`asr-${a.id}`}>{a.models.map((m) => <option key={m} value={m} />)}</datalist>
      </label>
      {a.models.length > 1 && <div className="model-chips">{a.models.map((m) => <button key={m} className={`chip sm ${a.model === m ? "on" : ""}`} onClick={() => onChange({ ...a, model: m })}>{m}</button>)}</div>}
      {a.needsKey && <label><span>API Key</span><KeyField account={`asr.${a.id}`} /></label>}
      {a.protocol === "deepseek" && <p className="muted small">{t("已在「AI 模型」里填过 DeepSeek Key 的话，这里可以留空。")}</p>}
      <div className="row-actions">
        <span className="spacer" />
        {a.keyUrl && <button className="btn ghost sm" onClick={() => openUrl(a.keyUrl!)}><ExternalLink size={13} /> {t("获取 Key")}</button>}
      </div>
    </div>
  );
}

function TtsSettings() {
  const { settings, saveSettings, speaking } = useStore(useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings, speaking: s.speaking })));
  const [error, setError] = useState<string | null>(null);
  const known = VOICES.some(([id]) => id === settings.ttsVoice);
  const sample = settings.ttsVoice.startsWith("en_") ? "Hi, this is SubCast. Your podcasts, now with subtitles and AI notes." : "你好，这里是 SubCast。海外好播客，配上中文字幕和精读，也可以听。"; // i18n-ignore
  return (
    <>
      <p className="muted small">{t("用豆包语音（seed-tts-2.0）把精读、导读朗读出来，适合通勤时「听中文版」。Key 与豆包语音识别共用，填一个即可。")}</p>
      <div className="provider-form">
        <label><span>API Key</span><KeyField account="tts.doubao" placeholder={t("粘贴火山引擎语音 API Key（留空则用语音识别的 Key）")} /></label>
        <label><span>{t("音色")}</span>
          <div className="model-chips">
            {VOICES.map(([id, name]) => <button key={id} className={`chip sm ${settings.ttsVoice === id ? "on" : ""}`} onClick={() => saveSettings({ ttsVoice: id })}>{t(name)}</button>)}
          </div>
        </label>
        <label><span>{t("音色 ID")}</span><input {...NO_AUTO} value={settings.ttsVoice} onChange={(e) => saveSettings({ ttsVoice: e.target.value.trim() })} placeholder={t("可填复刻音色或其他音色 ID")} /></label>
        <label><span>{t("模型")}</span>
          <div className="seg-control">
            {(["seed-tts-2.0", "seed-icl-2.0"] as const).map((r) => <button key={r} className={settings.ttsResource === r ? "on" : ""} onClick={() => saveSettings({ ttsResource: r })}>{r === "seed-tts-2.0" ? t("标准音色") : t("声音复刻")}</button>)}
          </div>
        </label>
        <div className="row-actions">
          {speaking
            ? <button className="btn sm" onClick={stopSpeaking}><Square size={12} /> {t("停止")}</button>
            : <button className="btn primary sm" onClick={() => { setError(null); void speak(sample, setError); }}><Play size={12} /> {known ? t("试听") : t("试听（自定义音色）")}</button>}
          {error && <span className="error-text small">{error}</span>}
          <span className="spacer" />
          <button className="btn ghost sm" onClick={() => openUrl("https://console.volcengine.com/speech/new/setting/apikeys?projectName=default")}><ExternalLink size={13} /> {t("获取 Key")}</button>
          <button className="btn ghost sm" onClick={() => openUrl("https://docs.volcengine.com/docs/doubao-voice/tone-list-3?lang=zh")}><ExternalLink size={13} /> {t("全部音色")}</button>
        </div>
      </div>
    </>
  );
}

function UpdateButton() {
  const { phase } = useUpdate();
  if (phase === "available") return <button className="btn primary sm" onClick={() => void installUpdate()}><RefreshCw size={13} /> {t("更新并重启")}</button>;
  if (phase === "ready") return <button className="btn primary sm" onClick={() => void installUpdate()}><RefreshCw size={13} /> {t("立即重启以更新")}</button>;
  const busy = phase === "checking" || phase === "downloading" || phase === "installing";
  return <button className="btn sm" disabled={busy} onClick={() => void checkForUpdate(true)}>{busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} {t("检查更新")}</button>;
}

function UpdateStatus() {
  const { phase, version, progress, error } = useUpdate();
  const { settings, saveSettings } = useStore(useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings })));
  const line = phase === "latest" ? <p className="ok-text small">{t("已经是最新版本")}</p>
    : phase === "available" ? <p className="small">{t("SubCast {version} 可以更新了", { version: version ?? "" })}</p>
    : phase === "ready" ? <p className="small">{t("SubCast {version} 已下载好，重启即可完成更新", { version: version ?? "" })}</p>
    : phase === "downloading" ? <p className="muted small">{progress == null ? t("正在下载新版本…") : t("正在下载新版本 {pct}%", { pct: Math.round(progress * 100) })}</p>
    : phase === "error" ? <p className="error-text small">{t("检查更新失败：{error}", { error: error ?? "" })} <button className="link-btn" onClick={() => void openUrl(DOWNLOAD_PAGE)}>{t("去官网下载")}</button></p>
    : null;
  return (
    <>
      {line}
      <label className="check small-check"><input type="checkbox" checked={settings.autoUpdate} onChange={(e) => saveSettings({ autoUpdate: e.target.checked })} /> {t("自动下载新版本，重启后生效")}</label>
    </>
  );
}

const REPO = "https://github.com/joeseesun/subcast";
function Storage({ onAsr }: { onAsr: () => void }) {
  const { set, go } = useStore(useShallow((s) => ({ set: s.set, go: s.go })));
  const saved = useOffline((s) => s.saved);
  const [info, setInfo] = useState<{ downloads: number; models: number; library: number; temp: number } | null>(null);
  const load = () => void api.storageInfo().then(setInfo).catch(() => {});
  useEffect(load, [saved]);
  const n = Object.keys(saved).length;
  const size = (b?: number) => (info ? (b ? bytes(b) : "0 MB") : "…");
  const clearAll = async () => {
    if (!(await ask({ title: t("删除全部已下载的音频？"), message: t("字幕、精读和收听进度都会保留。"), ok: t("全部删除"), danger: true }))) return;
    await clearDownloads(); load();
  };
  return (
    <>
      <p className="muted small">{t("SubCast 存在这台电脑上的内容。删除下载不会影响字幕、精读和收听进度。")}</p>
      <div className="storage-list">
        <div className="storage-row">
          <div className="storage-row-text">
            <p className="storage-row-name">{t("离线下载")}</p>
            <p className="muted small">{n ? t("{n} 集音频，没有网络也能听", { n }) : t("在单集页点下载按钮，就能离线收听")}</p>
          </div>
          <span className="storage-size">{size(info?.downloads)}</span>
          <button className="btn sm" onClick={() => void api.openDataFolder("downloads")}><FolderOpen size={13} /> {t("打开文件夹")}</button>
          {n > 0 && <button className="btn ghost sm" onClick={() => { set({ settingsOpen: false }); go({ kind: "downloads" }); }}>{t("查看")}</button>}
          {n > 0 && <button className="icon-btn" title={t("全部删除")} onClick={clearAll}><Trash2 size={14} /></button>}
        </div>
        <div className="storage-row">
          <div className="storage-row-text">
            <p className="storage-row-name">{t("语音识别模型")}</p>
            <p className="muted small">{t("本机识别用的模型，在「语音识别」里下载或删除")}</p>
          </div>
          <span className="storage-size">{size(info?.models)}</span>
          <button className="btn sm" onClick={() => void api.openDataFolder("models")}><FolderOpen size={13} /> {t("打开文件夹")}</button>
          <button className="btn ghost sm" onClick={onAsr}>{t("管理")}</button>
        </div>
        <div className="storage-row">
          <div className="storage-row-text">
            <p className="storage-row-name">{t("节目库")}</p>
            <p className="muted small">{t("订阅、字幕、翻译、精读和收听进度")}</p>
          </div>
          <span className="storage-size">{size(info?.library)}</span>
          <button className="btn ghost sm" onClick={() => void api.openDataFolder("data")}><FolderOpen size={13} /> {t("打开文件夹")}</button>
        </div>
        {!!info?.temp && (
          <div className="storage-row">
            <div className="storage-row-text">
              <p className="storage-row-name">{t("临时文件")}</p>
              <p className="muted small">{t("中断的识别留下的音频，可以放心清理")}</p>
            </div>
            <span className="storage-size">{size(info.temp)}</span>
            <button className="btn sm" onClick={() => void api.clearTemp().then(load)}>{t("清理")}</button>
          </div>
        )}
      </div>
    </>
  );
}

function About() {
  const [version, setVersion] = useState("0.1.0");
  const uiBuild = useStore((s) => s.uiBuild);
  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);
  const links: [string, string][] = [["qiaomu.ai", "https://qiaomu.ai"], [t("博客"), "https://blog.qiaomu.ai"], [t("乔木推荐"), "https://tuijian.qiaomu.ai"], ["X", "https://x.com/vista8"], ["GitHub", "https://github.com/joeseesun"]];
  return (
    <div className="about">
      <div className="about-top">
        <img src={logoUrl} alt="" />
        <div className="about-meta">
          <p className="about-name">SubCast <span className="about-ver">{t("版本 {version}", { version })}{uiBuild ? ` · ${t("界面更新 {n}", { n: uiBuild })}` : ""}</span></p>
          <p className="muted small">{t("海外好播客，配上中文字幕、精读与 AI 问答。")}</p>
          <UpdateStatus />
        </div>
      </div>
      <div className="row-actions">
        <UpdateButton />
        <button className="btn sm" onClick={() => openUrl(`${REPO}/issues/new`)}><MessageCircle size={13} /> {t("反馈问题")}</button>
        <button className="btn sm" onClick={() => openUrl(`${REPO}#readme`)}><BookOpen size={13} /> {t("使用说明")}</button>
        <button className="btn sm" onClick={() => openUrl(REPO)}><Github size={13} /> {t("源代码")}</button>
      </div>
      <HomeShowCard />
      <div className="about-qr">
        <div className="qr-card"><img src={wechatQr} alt={t("公众号二维码")} /><div><p className="qr-title">{t("关注公众号")}</p><p className="muted small">{t("微信搜索「向阳乔木推荐看」")}</p></div></div>
        <div className="qr-card"><img src={rewardQr} alt={t("赞赏码")} /><div><p className="qr-title">{t("请我喝杯咖啡")}</p><p className="muted small">{t("微信扫码赞赏")}</p></div></div>
      </div>
      <div className="about-foot">
        {links.map(([label, u]) => <button key={u} className="link-btn" onClick={() => openUrl(u)}>{label}</button>)}
        <span className="spacer" />
        <span className="muted small">{t("© {year} 向阳乔木 · AGPL-3.0", { year: new Date().getFullYear() })}</span>
      </div>
    </div>
  );
}
