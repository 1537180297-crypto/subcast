import { useEffect, useState } from "react";
import { BookOpen, Check, Cloud, Cpu, ExternalLink, Github, Loader2, MessageCircle, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { ASR_SERVICES, GROUPS, VOICES } from "../lib/settings";
import { speak, stopSpeaking } from "../lib/tts";
import logoUrl from "../assets/logo.png";
import wechatQr from "../assets/about-wechat-qr.jpg";
import rewardQr from "../assets/about-reward-qr.png";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorText, llmChat, type CloudAsr, type ModelInfo, type Provider } from "../lib/api";
import { llmReady } from "../lib/jobs";
import { useStore } from "../store";
import { Modal } from "./Chrome";
import { useModelDownload } from "./TranscriptPanel";

const NO_AUTO = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

function ProviderEditor({ p, onChange }: { p: Provider; onChange: (p: Provider) => void }) {
  const { settings, saveSettings } = useStore();
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [live, setLive] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  useEffect(() => { setKey(""); setLive(null); api.hasApiKey(p.id).then(setHasKey); }, [p.id]);
  const fetchModels = async () => {
    setFetching(true); setTesting(null);
    try { if (key.trim()) await saveKey(); const ids = await api.listModels(p); setLive(ids); if (!ids.length) setTesting("这个服务没有返回模型列表，请手动填写"); }
    catch (e) { setTesting(errorText(e)); } finally { setFetching(false); }
  };
  const saveKey = async () => { await api.setApiKey(p.id, key); setHasKey(!!key.trim()); setKey(""); };
  const test = async () => {
    setTesting("…");
    try {
      if (key.trim()) await saveKey();
      const r = await llmChat({ provider: p, system: "Reply with one short word.", messages: [{ role: "user", content: "ping" }], maxTokens: 400 });
      setTesting(`可用 ✓ ${r.slice(0, 20)}`);
    } catch (e) { setTesting(errorText(e)); }
  };
  return (
    <div className="provider-form">
      <label><span>接口类型</span>
        <select value={p.protocol} onChange={(e) => onChange({ ...p, protocol: e.target.value as Provider["protocol"] })}>
          <option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option>
        </select>
      </label>
      <label><span>接口地址</span><input {...NO_AUTO} value={p.baseUrl} onChange={(e) => onChange({ ...p, baseUrl: e.target.value })} placeholder="https://…/v1" /></label>
      <label><span>模型</span>
        <input {...NO_AUTO} value={p.model} list={`models-${p.id}`} onChange={(e) => onChange({ ...p, model: e.target.value })} placeholder="模型名" />
        <datalist id={`models-${p.id}`}>{[...new Set([...(live ?? []), ...(p.models ?? [])])].map((m) => <option key={m} value={m} />)}</datalist>
      </label>
      {(p.models?.length || live?.length) ? (
        <div className="model-chips">
          {[...new Set([...(p.models ?? []), ...(live ?? []).slice(0, 40)])].map((m) => <button key={m} className={`chip sm ${p.model === m ? "on" : ""}`} onClick={() => onChange({ ...p, model: m })}>{m}</button>)}
        </div>
      ) : null}
      {p.needsKey && (
        <label><span>API Key</span>
          <div className="key-row">
            <input {...NO_AUTO} type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? "已保存（存于系统钥匙串）" : "粘贴 API Key"} />
            <button className="btn sm" onClick={saveKey} disabled={!key.trim()}>保存</button>
            {hasKey && <button className="icon-btn" title="删除 Key" onClick={async () => { await api.setApiKey(p.id, ""); setHasKey(false); }}><Trash2 size={14} /></button>}
          </div>
        </label>
      )}
      <div className="row-actions">
        <button className={`btn sm ${settings.chatProvider === p.id ? "primary" : ""}`} onClick={() => saveSettings({ chatProvider: p.id })}>{settings.chatProvider === p.id ? "✓ 用于问答" : "用于问答"}</button>
        <button className={`btn sm ${settings.translateProvider === p.id ? "primary" : ""}`} onClick={() => saveSettings({ translateProvider: p.id })}>{settings.translateProvider === p.id ? "✓ 用于翻译" : "用于翻译"}</button>
        <span className="spacer" />
        {p.keyUrl && <button className="btn ghost sm" onClick={() => openUrl(p.keyUrl!)}><ExternalLink size={13} /> 获取 Key</button>}
        <button className="btn ghost sm" onClick={fetchModels} disabled={fetching}>{fetching ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} 获取模型列表</button>
        <button className="btn sm" onClick={test} disabled={testing === "…"}>{testing === "…" ? <Loader2 size={13} className="spin" /> : null} 测试连接</button>
        {testing && testing !== "…" && <span className={testing.startsWith("可用") ? "ok-text small" : "error-text small"}>{testing}</span>}
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const { settings, saveSettings, set, notify, settingsSection } = useStore();
  type Section = "overview" | "model" | "asr" | "tts" | "general" | "about";
  const [section, setSection] = useState<Section>((settingsSection as Section) ?? "overview");
  const [chatOk, setChatOk] = useState<boolean | null>(null);
  const [trOk, setTrOk] = useState<boolean | null>(null);
  useEffect(() => { void llmReady("chat").then(setChatOk); void llmReady("translate").then(setTrOk); }, [settings, section]);
  const [editing, setEditing] = useState(settings.chatProvider);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [proxy, setProxy] = useState(settings.proxy);
  const refresh = () => api.asrModels().then(setModels);
  const { downloading, start, cancel } = useModelDownload(refresh);
  useEffect(() => { void refresh(); }, []);
  const providers = Object.values(settings.providers);
  const p = settings.providers[editing];
  const update = (np: Provider) => void saveSettings({ providers: { ...settings.providers, [np.id]: np } });
  const NAV: [Section, string][] = [["overview", "概览"], ["model", "AI 模型"], ["asr", "语音识别"], ["tts", "朗读"], ["general", "网络"], ["about", "关于"]];

  return (
    <Modal title="设置" onClose={() => { stopSpeaking(); set({ settingsOpen: false }); }} wide>
      <div className="settings">
        <nav className="settings-nav">
          {NAV.map(([k, label]) => <button key={k} className={section === k ? "on" : ""} onClick={() => setSection(k)}>{label}</button>)}
        </nav>
        <div className="settings-body">
          {section === "overview" && (
            <div className="overview">
              <div className="ov-card">
                <div className="ov-head"><p className="ov-title">字幕翻译</p><span className={`pill ok`}>{trOk ? `${settings.providers[settings.translateProvider]?.name}` : "谷歌翻译 · 免费"}</span></div>
                <p className="muted small">{trOk ? "用你的模型翻译，译文更通顺、术语更准。" : "无需设置即可使用；连接自己的模型可获得更好的译文。"}</p>
                <div className="seg-control">
                  {([["auto", "自动"], ["google", "谷歌翻译"], ["llm", "我的模型"]] as const).map(([k, label]) => (
                    <button key={k} className={settings.translateMode === k ? "on" : ""} onClick={() => saveSettings({ translateMode: k })}>{label}</button>
                  ))}
                </div>
                <label className="check"><input type="checkbox" checked={settings.autoTranslate} onChange={(e) => saveSettings({ autoTranslate: e.target.checked })} /> 打开外语节目时自动翻译字幕</label>
                </div>
              <div className="ov-card">
                <div className="ov-head"><p className="ov-title">AI 问答与导读</p><span className={`pill ${chatOk ? "ok" : ""}`}>{chatOk ? settings.providers[settings.chatProvider]?.name : "未连接"}</span></div>
                <p className="muted small">基于整期文字稿回答问题、生成中文导读。推荐 DeepSeek，国内直连，一集约 ¥0.1。</p>
                <button className="btn sm primary" onClick={() => setSection("model")}>{chatOk ? "管理模型" : "连接模型"}</button>
              </div>
              <div className="ov-card">
                <div className="ov-head"><p className="ov-title">语音识别</p><span className={`pill ${settings.asrEngine !== "local" || models.find((m) => m.id === settings.asrModel)?.installed ? "ok" : ""}`}>{settings.asrEngine !== "local" ? settings.cloudAsr[settings.asrEngine]?.name : models.find((m) => m.id === settings.asrModel)?.installed ? "本机 · 已下载" : "本机 · 未下载"}</span></div>
                <p className="muted small">没有字幕的节目用它生成。本机模型音频不出本机；云端服务更快，适合长节目。</p>
                <button className="btn sm" onClick={() => setSection("asr")}>管理</button>
              </div>
            </div>
          )}
          {section === "model" && (
            <>
              <p className="muted small">问答、导读（以及可选的字幕翻译）使用你自己的模型服务，Key 只保存在本机钥匙串。</p>
              <p className="usage">问答与导读：<b>{settings.providers[settings.chatProvider]?.name}</b>　·　字幕翻译：<b>{settings.providers[settings.translateProvider]?.name}</b></p>
              <div className="provider-split">
                <div className="provider-list">
                  {GROUPS.map((g) => (
                    <div key={g.id} className="provider-group">
                      <p className="provider-group-h">{g.name}<span>{g.note}</span></p>
                      {providers.filter((x) => (x.group ?? "provider") === g.id).map((x) => (
                        <button key={x.id} className={`provider-item ${editing === x.id ? "on" : ""}`} onClick={() => setEditing(x.id)}>
                          <span>{x.name}</span>
                          {(x.id === settings.chatProvider || x.id === settings.translateProvider) && <span className="dot-on" title="正在使用" />}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
                <div className="provider-detail">
                  {p && <><p className="provider-title">{p.name}</p><ProviderEditor key={p.id} p={p} onChange={update} /></>}
                </div>
              </div>
            </>
          )}
          {section === "asr" && (
            <>
              <div className="engine-switch">
                <button className={`engine ${settings.asrEngine === "local" ? "on" : ""}`} onClick={() => saveSettings({ asrEngine: "local" })}>
                  <Cpu size={18} /><div><p>本机模型</p><p className="muted small">免费、离线，音频不出本机</p></div>
                </button>
                <button className={`engine ${settings.asrEngine !== "local" ? "on" : ""}`} onClick={() => saveSettings({ asrEngine: settings.asrEngine !== "local" ? settings.asrEngine : "doubao" })}>
                  <Cloud size={18} /><div><p>云端服务</p><p className="muted small">更快，适合长节目，需要 Key</p></div>
                </button>
              </div>
              {settings.asrEngine === "local" ? (
                <>
<p className="muted small">没有官方字幕时，用本机模型识别。音频只在本机处理，识别完即删除。</p>
              <div className="model-list">
                {models.map((m) => (
                  <div key={m.id} className={`model-item ${settings.asrModel === m.id ? "on" : ""}`}>
                    <div role="button" tabIndex={0} className="model-pick" onClick={() => saveSettings({ asrModel: m.id })}>
                      <span className={`radio ${settings.asrModel === m.id ? "on" : ""}`} />
                      <div><p>{m.name}</p><p className="muted small">{m.note} · {m.sizeMb} MB</p></div>
                    </div>
                    {downloading?.id === m.id ? (
                      <div className="dl"><span className="small">{downloading.total ? Math.round((downloading.received / downloading.total) * 100) : 0}%</span><button className="btn ghost sm" onClick={() => cancel(m.id)}>取消</button></div>
                    ) : m.installed ? (
                      <div className="dl"><span className="ok-text small"><Check size={13} /> 已下载</span><button className="icon-btn" title="删除模型" onClick={async () => { await api.deleteModel(m.id); void refresh(); }}><Trash2 size={14} /></button></div>
                    ) : (
                      <button className="btn sm" onClick={() => start(m.id, settings.mirrorFirst)} disabled={downloading != null}>下载</button>
                    )}
                  </div>
                ))}
              </div>
              <label className="check"><input type="checkbox" checked={settings.mirrorFirst} onChange={(e) => saveSettings({ mirrorFirst: e.target.checked })} /> 优先从国内镜像（hf-mirror.com）下载模型</label>
              <label><span>默认说话语言</span>
                <select value={settings.asrLanguage} onChange={(e) => saveSettings({ asrLanguage: e.target.value })}>
                  <option value="auto">自动识别</option><option value="en">英语</option><option value="zh">中文</option><option value="ja">日语</option>
                </select>
              </label>
                            </>
              ) : (
                <>
                  <div className="provider-tabs">
                    {ASR_SERVICES.map((a) => <button key={a.id} className={`chip ${settings.asrEngine === a.id ? "on" : ""}`} onClick={() => saveSettings({ asrEngine: a.id })}>{a.name}</button>)}
                  </div>
                  {settings.cloudAsr[settings.asrEngine] && <CloudAsrEditor key={settings.asrEngine} a={settings.cloudAsr[settings.asrEngine]} onChange={(na) => saveSettings({ cloudAsr: { ...settings.cloudAsr, [na.id]: na } })} />}
                </>
              )}
            </>
          )}
          {section === "tts" && <TtsSettings />}
          {section === "general" && (
            <>
              <label><span>网络代理</span>
                <div className="key-row">
                  <input {...NO_AUTO} value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="留空使用系统代理，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:7890" />
                  <button className="btn sm" onClick={async () => { try { await saveSettings({ proxy }); notify("代理已保存"); } catch (e) { notify(errorText(e)); } }}>保存</button>
                </div>
              </label>
              <p className="muted small">在国内访问 YouTube 需要代理。视频画面由系统浏览器内核播放，使用系统代理设置。谷歌翻译连不上时会自动改走国内中转。</p>
            </>
          )}
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
      <input {...NO_AUTO} type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={has ? "已保存（存于系统钥匙串）" : placeholder ?? "粘贴 API Key"} />
      <button className="btn sm" onClick={async () => { await api.setApiKey(account, key); setHas(!!key.trim()); setKey(""); }} disabled={!key.trim()}>保存</button>
      {has && <button className="icon-btn" title="删除 Key" onClick={async () => { await api.setApiKey(account, ""); setHas(false); }}><Trash2 size={14} /></button>}
    </div>
  );
}

function CloudAsrEditor({ a, onChange }: { a: CloudAsr; onChange: (a: CloudAsr) => void }) {
  return (
    <div className="provider-form">
      <p className="muted small">{a.note}。识别时音频会发送到 {a.name}。</p>
      <label><span>接口地址</span><input {...NO_AUTO} value={a.baseUrl} onChange={(e) => onChange({ ...a, baseUrl: e.target.value })} /></label>
      <label><span>模型</span>
        <input {...NO_AUTO} value={a.model} list={`asr-${a.id}`} onChange={(e) => onChange({ ...a, model: e.target.value })} />
        <datalist id={`asr-${a.id}`}>{a.models.map((m) => <option key={m} value={m} />)}</datalist>
      </label>
      {a.models.length > 1 && <div className="model-chips">{a.models.map((m) => <button key={m} className={`chip sm ${a.model === m ? "on" : ""}`} onClick={() => onChange({ ...a, model: m })}>{m}</button>)}</div>}
      {a.needsKey && <label><span>API Key</span><KeyField account={`asr.${a.id}`} /></label>}
      <div className="row-actions">
        <span className="spacer" />
        {a.keyUrl && <button className="btn ghost sm" onClick={() => openUrl(a.keyUrl!)}><ExternalLink size={13} /> 获取 Key</button>}
      </div>
    </div>
  );
}

function TtsSettings() {
  const { settings, saveSettings, speaking } = useStore();
  const [error, setError] = useState<string | null>(null);
  const known = VOICES.some(([id]) => id === settings.ttsVoice);
  return (
    <>
      <p className="muted small">用豆包语音（seed-tts-2.0）把精读、导读朗读出来，适合通勤时「听中文版」。Key 与豆包语音识别共用，填一个即可。</p>
      <div className="provider-form">
        <label><span>API Key</span><KeyField account="tts.doubao" placeholder="粘贴火山引擎语音 API Key（留空则用语音识别的 Key）" /></label>
        <label><span>音色</span>
          <div className="model-chips">
            {VOICES.map(([id, name]) => <button key={id} className={`chip sm ${settings.ttsVoice === id ? "on" : ""}`} onClick={() => saveSettings({ ttsVoice: id })}>{name}</button>)}
          </div>
        </label>
        <label><span>音色 ID</span><input {...NO_AUTO} value={settings.ttsVoice} onChange={(e) => saveSettings({ ttsVoice: e.target.value.trim() })} placeholder="可填复刻音色或其他音色 ID" /></label>
        <label><span>模型</span>
          <div className="seg-control">
            {(["seed-tts-2.0", "seed-icl-2.0"] as const).map((r) => <button key={r} className={settings.ttsResource === r ? "on" : ""} onClick={() => saveSettings({ ttsResource: r })}>{r === "seed-tts-2.0" ? "标准音色" : "声音复刻"}</button>)}
          </div>
        </label>
        <div className="row-actions">
          {speaking
            ? <button className="btn sm" onClick={stopSpeaking}><Square size={12} /> 停止</button>
            : <button className="btn primary sm" onClick={() => { setError(null); void speak(settings.ttsVoice.startsWith("en_") ? "Hi, this is SubCast. Your podcasts, now with subtitles and AI notes." : "你好，这里是 SubCast。海外好播客，配上中文字幕和精读，也可以听。", setError); }}><Play size={12} /> 试听{known ? "" : "（自定义音色）"}</button>}
          {error && <span className="error-text small">{error}</span>}
          <span className="spacer" />
          <button className="btn ghost sm" onClick={() => openUrl("https://console.volcengine.com/speech/new/setting/apikeys?projectName=default")}><ExternalLink size={13} /> 获取 Key</button>
          <button className="btn ghost sm" onClick={() => openUrl("https://docs.volcengine.com/docs/doubao-voice/tone-list-3?lang=zh")}><ExternalLink size={13} /> 全部音色</button>
        </div>
      </div>
    </>
  );
}

const REPO = "https://github.com/joeseesun/subcast";
function About() {
  const [version, setVersion] = useState("0.1.0");
  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);
  const links: [string, string][] = [["qiaomu.ai", "https://qiaomu.ai"], ["博客", "https://blog.qiaomu.ai"], ["乔木推荐", "https://tuijian.qiaomu.ai"], ["X", "https://x.com/vista8"], ["GitHub", "https://github.com/joeseesun"]];
  return (
    <div className="about">
      <div className="about-id">
        <img src={logoUrl} alt="" />
        <p className="about-name">SubCast</p>
        <p className="about-ver">版本 {version}</p>
        <p className="muted">海外好播客，配上中文字幕、精读与 AI 问答。</p>
        <div className="row-actions center">
          <button className="btn sm" onClick={() => openUrl(`${REPO}/releases`)}><RefreshCw size={13} /> 检查更新</button>
          <button className="btn sm" onClick={() => openUrl(`${REPO}/issues/new`)}><MessageCircle size={13} /> 反馈问题</button>
          <button className="btn sm" onClick={() => openUrl(`${REPO}#readme`)}><BookOpen size={13} /> 使用说明</button>
          <button className="btn sm" onClick={() => openUrl(REPO)}><Github size={13} /> 源代码</button>
        </div>
      </div>
      <div className="about-qr">
        <div className="qr-card"><img src={wechatQr} alt="公众号二维码" /><p className="qr-title">关注公众号</p><p className="muted small">微信搜索「向阳乔木推荐看」</p></div>
        <div className="qr-card"><img src={rewardQr} alt="赞赏码" /><p className="qr-title">请我喝杯咖啡</p><p className="muted small">微信扫码赞赏</p></div>
      </div>
      <div className="about-links">{links.map(([t, u]) => <button key={u} className="link-btn" onClick={() => openUrl(u)}>{t}</button>)}</div>
      <p className="muted small center">订阅数据、字幕和 Key 都保存在本机。使用云端识别、翻译或 AI 功能时，相关内容会发送到你选择的服务。</p>
      <p className="muted small center">© {new Date().getFullYear()} 向阳乔木 · MIT</p>
    </div>
  );
}
