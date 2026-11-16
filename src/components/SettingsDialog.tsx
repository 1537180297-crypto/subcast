import { useEffect, useState } from "react";
import { Check, ExternalLink, Loader2, Trash2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorText, llmChat, type ModelInfo, type Provider } from "../lib/api";
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
  useEffect(() => { setKey(""); api.hasApiKey(p.id).then(setHasKey); }, [p.id]);
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
        <datalist id={`models-${p.id}`}>{p.models?.map((m) => <option key={m} value={m} />)}</datalist>
      </label>
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
        <button className="btn sm" onClick={test} disabled={testing === "…"}>{testing === "…" ? <Loader2 size={13} className="spin" /> : null} 测试连接</button>
        {testing && testing !== "…" && <span className={testing.startsWith("可用") ? "ok-text small" : "error-text small"}>{testing}</span>}
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const { settings, saveSettings, set, notify, settingsSection } = useStore();
  const [section, setSection] = useState<"overview" | "model" | "asr" | "general">(settingsSection ?? "overview");
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

  return (
    <Modal title="设置" onClose={() => set({ settingsOpen: false })} wide>
      <div className="settings">
        <nav className="settings-nav">
          <button className={section === "overview" ? "on" : ""} onClick={() => setSection("overview")}>概览</button>
          <button className={section === "model" ? "on" : ""} onClick={() => setSection("model")}>AI 模型</button>
          <button className={section === "asr" ? "on" : ""} onClick={() => setSection("asr")}>本机识别</button>
          <button className={section === "general" ? "on" : ""} onClick={() => setSection("general")}>网络</button>
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
                <div className="ov-head"><p className="ov-title">本机识别</p><span className={`pill ${models.find((m) => m.id === settings.asrModel)?.installed ? "ok" : ""}`}>{models.find((m) => m.id === settings.asrModel)?.installed ? "已下载" : "未下载"}</span></div>
                <p className="muted small">没有字幕的节目用本机模型生成，音频不出本机。当前：{models.find((m) => m.id === settings.asrModel)?.name ?? "—"}</p>
                <button className="btn sm" onClick={() => setSection("asr")}>管理</button>
              </div>
            </div>
          )}
          {section === "model" && (
            <>
              <p className="muted small">问答、导读（以及可选的字幕翻译）使用你自己的模型服务，Key 只保存在本机钥匙串。</p>
              <p className="usage">问答与导读：<b>{settings.providers[settings.chatProvider]?.name}</b>　·　字幕翻译：<b>{settings.providers[settings.translateProvider]?.name}</b></p>
              <div className="provider-tabs">
                {providers.map((x) => <button key={x.id} className={`chip ${editing === x.id ? "on" : ""}`} onClick={() => setEditing(x.id)}>{x.name}{x.id === settings.chatProvider || x.id === settings.translateProvider ? " •" : ""}</button>)}
              </div>
              {p && <ProviderEditor key={p.id} p={p} onChange={update} />}
            </>
          )}
          {section === "asr" && (
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
          )}
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
        </div>
      </div>
    </Modal>
  );
}
