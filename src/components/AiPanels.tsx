import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, RefreshCw, Sparkles, Square, Trash2 } from "lucide-react";
import { api, errorText, type ChatMessage, type Episode } from "../lib/api";
import { askEpisode, QUICK_QUESTIONS, SUMMARY_PROMPT, transcriptForModel } from "../lib/ai";
import { useJobs } from "../lib/jobs";
import { providerFor, useStore } from "../store";
import { Markdown } from "./Markdown";

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
  const seek = useSeek(ep);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

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
    setMessages(history);
    setInput("");
    setStreaming("");
    abort.current = new AbortController();
    try {
      const answer = await askEpisode({ provider: provider!, title: ep.title, show: ep.showTitle ?? "", transcript: context(), history, onDelta: setStreaming, signal: abort.current.signal });
      const next = [...history, { role: "assistant" as const, content: answer }];
      setMessages(next);
      void api.setBlob(ep.id, "chat", JSON.stringify(next));
    } catch (e) {
      const partial = abort.current?.signal.aborted ? "（已停止）" : `出错了：${errorText(e)}`;
      setMessages([...history, { role: "assistant", content: partial }]);
    } finally {
      setStreaming(null);
    }
  };

  const clear = () => { setMessages([]); void api.setBlob(ep.id, "chat", "[]"); };

  return (
    <div className="chat">
      <div className="chat-scroll">
        {!messages.length && streaming == null && (
          <div className="chat-intro">
            <Sparkles size={22} className="accent" />
            <p className="lead">问问这期节目</p>
            <p className="muted">回答基于整期文字稿，带时间戳，点一下就能跳过去听原话。</p>
            <div className="chips">
              {QUICK_QUESTIONS.map((q) => <button key={q} className="chip" onClick={() => send(q)} disabled={!transcript}>{q}</button>)}
            </div>
            {!transcript && <p className="muted small">字幕准备好后就可以提问。</p>}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === "user" ? <p>{m.content}</p> : <Markdown text={m.content} onSeek={seek} />}
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
      <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        {messages.length > 0 && streaming == null && <button type="button" className="icon-btn" title="清空对话" onClick={clear}><Trash2 size={16} /></button>}
        <textarea
          value={input}
          rows={1}
          placeholder={transcript ? "问点什么，比如：他们怎么看 AGI 的时间线？" : "字幕准备好后可以提问"}
          disabled={!transcript}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input); } }}
        />
        {streaming != null
          ? <button type="button" className="send" title="停止" onClick={() => abort.current?.abort()}><Square size={14} fill="currentColor" /></button>
          : <button type="submit" className="send" title="发送" disabled={!input.trim()}><ArrowUp size={16} /></button>}
      </form>
      <p className="model-note">{provider ? `${provider.name} · ${provider.model}` : "未选择模型"}</p>
    </div>
  );
}

export function SummaryPanel({ ep }: { ep: Episode }) {
  const { transcript, provider, context, check } = useReady(ep);
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
  if (!text) {
    return (
      <div className="panel-empty">
        <Sparkles size={26} className="accent" />
        <p className="lead">中文导读</p>
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
