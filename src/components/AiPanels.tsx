import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, RefreshCw, Settings2, Sparkles, Square, Trash2 } from "lucide-react";
import { api, errorText, type ChatMessage, type Episode } from "../lib/api";
import { askEpisode, SUMMARY_PROMPT, transcriptForModel } from "../lib/ai";
import { quickPrompts } from "../lib/settings";
import { ChatPrefsDialog, ModelPicker, PromptMenu, promptIcon, shortModel } from "./ChatTools";
import { llmReady, useJobs } from "../lib/jobs";
import { providerFor, useStore } from "../store";
import { Markdown } from "./Markdown";

/** Whether a model is connected for Q&A; re-checked whenever settings change or the settings window closes. */
function useConnected() {
  const settings = useStore((s) => s.settings);
  const open = useStore((s) => s.settingsOpen);
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => { if (!open) void llmReady("chat").then(setOk); }, [settings, open]);
  return ok;
}

function ConnectCard({ what }: { what: string }) {
  const [later, setLater] = useState(false);
  if (later) return null;
  return (
    <div className="connect-card">
      <Sparkles size={22} className="accent" />
      <p className="lead">{what}需要连接一个 AI 模型</p>
      <p className="muted">推荐 DeepSeek，国内直连，一集约 ¥0.1。Key 只保存在本机。</p>
      <div className="row-actions center">
        <button className="btn primary" onClick={() => { const s = useStore.getState(); void s.saveSettings({ chatProvider: s.settings.chatProvider || "deepseek" }); s.openSettings("model"); }}>连接模型</button>
        <button className="btn ghost" onClick={() => setLater(true)}>稍后</button>
      </div>
    </div>
  );
}

function useReady(ep: Episode) {
  const transcript = useJobs((s) => s.transcripts[ep.id]);
  const translation = useJobs((s) => s.translations[ep.id]);
  const settings = useStore((s) => s.settings);
  const provider = providerFor(settings, "chat");
  const context = () => transcriptForModel(transcript!.segments, translation?.items);
  const check = async () => {
    if (!transcript) throw new Error("需要先有字幕才能提问");
    if (!provider?.model) throw new Error("请先在设置里选择模型");
    if (provider.needsKey && !(await api.hasApiKey(provider.id))) throw new Error(`请先在设置里填写「${provider.name}」的 API Key`);
  };
  return { transcript, provider, context, check };
}

function useSeek(ep: Episode) {
  const { current, player, load } = useStore();
  return (t: number) => {
    if (current?.id === ep.id) player?.seek(t);
    else { load({ ...ep, progress: t }); setTimeout(() => useStore.getState().player?.seek(t), 600); }
  };
}

export function ChatPanel({ ep }: { ep: Episode }) {
  const { transcript, provider, context, check } = useReady(ep);
  const connected = useConnected();
  const settings = useStore((s) => s.settings);
  const seek = useSeek(ep);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const prompts = quickPrompts(settings).filter((p) => p.enabled);

  useEffect(() => {
    setMessages([]);
    api.getBlob(ep.id, "chat").then((raw) => { if (raw) try { setMessages(JSON.parse(raw)); } catch { /* ignore */ } });
  }, [ep.id]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages.length, streaming]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || streaming != null) return;
    try { await check(); } catch (e) { setSetupError(errorText(e)); return; }
    setSetupError(null);
    const history: ChatMessage[] = [...messages, { role: "user", content: q }];
    const model = `${provider!.name} · ${shortModel(provider!.model)}`;
    setMessages(history);
    setInput("");
    setStreaming("");
    abort.current = new AbortController();
    try {
      const answer = await askEpisode({ provider: provider!, title: ep.title, show: ep.showTitle ?? "", transcript: context(), history, instruction: settings.chatPromptOn ? settings.chatPrompt : "", onDelta: setStreaming, signal: abort.current.signal });
      const next = [...history, { role: "assistant" as const, content: answer, model }];
      setMessages(next);
      void api.setBlob(ep.id, "chat", JSON.stringify(next));
    } catch (e) {
      const partial = abort.current?.signal.aborted ? "（已停止）" : `出错了：${errorText(e)}`;
      setMessages([...history, { role: "assistant", content: partial, model }]);
    } finally {
      setStreaming(null);
    }
  };

  const clear = () => { setMessages([]); void api.setBlob(ep.id, "chat", "[]"); };
  const blocked = !transcript || connected === false;
  const empty = !messages.length && streaming == null;

  return (
    <div className="chat">
      <div className="chat-scroll">
        {empty && connected === false && <ConnectCard what="问答" />}
        {empty && connected !== false && (
          <div className="chat-intro">
            <div className="intro-head">
              <span className="intro-icon"><Sparkles size={18} /></span>
              <div>
                <p className="lead">问问这期节目</p>
                <p className="muted small">回答依据整期文字稿，引用处带时间戳，点一下就跳过去听。</p>
              </div>
            </div>
            {!transcript && <p className="setup-note"><span>字幕准备好后就可以提问。</span></p>}
            <div className="prompt-list">
              {prompts.map((p) => {
                const Icon = promptIcon(p.id);
                return (
                  <button key={p.id} type="button" className="prompt-row" title={p.body} disabled={blocked} onClick={() => send(p.body)}>
                    <Icon size={15} className="pr-icon" />
                    <span className="pr-text"><span className="pr-title">{p.title}</span><span className="pr-sub">{p.body}</span></span>
                  </button>
                );
              })}
            </div>
            <button type="button" className="link-btn" onClick={() => setPrefsOpen(true)}><Settings2 size={13} /> 自定义提示词和回答偏好</button>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === "user" ? <p>{m.content}</p> : <><Markdown text={m.content} onSeek={seek} />{m.model && <p className="msg-model">{m.model}</p>}</>}
          </div>
        ))}
        {streaming != null && (
          <div className="msg assistant">
            {streaming ? <Markdown text={streaming} onSeek={seek} /> : <p className="muted"><Loader2 size={14} className="spin" /> 正在阅读文字稿…</p>}
          </div>
        )}
        {setupError && (
          <div className="setup-note"><span>{setupError}</span><button className="btn primary sm" onClick={() => useStore.getState().openSettings("model")}>去设置</button></div>
        )}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(input); }} onClick={(e) => { if (e.target === e.currentTarget) box.current?.focus(); }}>
        <textarea
          ref={box}
          value={input}
          rows={1}
          placeholder={connected === false ? "连接模型后可以提问" : transcript ? "问点什么，Enter 发送，Shift+Enter 换行" : "字幕准备好后可以提问"}
          disabled={blocked}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input); } }}
        />
        <div className="composer-bar">
          <ModelPicker disabled={connected === false} />
          <PromptMenu onPick={(b) => void send(b)} onManage={() => setPrefsOpen(true)} disabled={blocked || streaming != null} />
          <span className="spacer" />
          {messages.length > 0 && streaming == null && <button type="button" className="icon-btn sm" title="清空对话" onClick={clear}><Trash2 size={15} /></button>}
          {streaming != null
            ? <button type="button" className="send" title="停止" onClick={() => abort.current?.abort()}><Square size={13} fill="currentColor" /></button>
            : <button type="submit" className="send" title="发送" disabled={!input.trim() || blocked}><ArrowUp size={16} /></button>}
        </div>
      </form>
      <p className="model-note">回答由 AI 生成，可能有误，重要信息请回到原文核对</p>
      {prefsOpen && <ChatPrefsDialog onClose={() => setPrefsOpen(false)} />}
    </div>
  );
}
export function SummaryPanel({ ep }: { ep: Episode }) {
  const { transcript, provider, context, check } = useReady(ep);
  const connected = useConnected();
  const seek = useSeek(ep);
  const [summary, setSummary] = useState<string | null>(null);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSummary(null); setError(null);
    api.getBlob(ep.id, "summary").then(setSummary);
  }, [ep.id, transcript]);

  const run = async () => {
    setError(null);
    try {
      await check();
      setStreaming("");
      const text = await askEpisode({ provider: provider!, title: ep.title, show: ep.showTitle ?? "", transcript: context(), history: [{ role: "user", content: SUMMARY_PROMPT }], onDelta: setStreaming });
      setSummary(text);
      void api.setBlob(ep.id, "summary", text);
    } catch (e) { setError(errorText(e)); }
    finally { setStreaming(null); }
  };

  const text = streaming ?? summary;
  if (!text && connected === false) return <div className="panel-empty"><ConnectCard what="导读" /></div>;
  if (!text) {
    return (
      <div className="panel-empty">
        <Sparkles size={26} className="accent" />
        <p className="lead">一键中文导读</p>
        <p className="muted">一句话总结、核心观点、章节和值得记住的原话，全部带时间戳。</p>
        {error && <p className="error-text">{error}</p>}
        {error && /设置|API Key/.test(error) && <button className="btn" onClick={() => useStore.getState().openSettings("model")}>去设置</button>}
        <button className="btn primary" onClick={run} disabled={!transcript || streaming != null}>{streaming != null ? "正在生成…" : "生成导读"}</button>
        {!transcript && <p className="muted small">字幕准备好后可以生成。</p>}
      </div>
    );
  }
  return (
    <div className="summary">
      <Markdown text={text} onSeek={seek} />
      {streaming == null && (
        <div className="summary-foot">
          <span className="muted small">{provider?.name} · {provider?.model}</span>
          <button className="btn ghost sm" onClick={run}><RefreshCw size={13} /> 重新生成</button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
