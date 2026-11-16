import { useEffect, useRef, useState } from "react";
import { Copy, Image as ImageIcon, Languages, Loader2, X } from "lucide-react";
import { api, type Episode } from "../lib/api";
import { CJK, drawPoster } from "../lib/poster";
import { showName } from "../lib/picks";
import { useStore } from "../store";
import { Modal } from "./Chrome";
import logoUrl from "../assets/logo.png";

const ZONES = ".deep-body, .lines, .notes-body, .chat-scroll, .summary";

interface Sel { text: string; x: number; y: number; below: boolean; ts?: string }

const toSeconds = (t?: string) => (t ? t.split(":").reduce((n, p) => n * 60 + Number(p), 0) : 0);

/** A small toolbar over selected text in transcripts, 精读 and notes: copy with source, translate, make a poster. */
export function SelectionTools() {
  const [sel, setSel] = useState<Sel | null>(null);
  const [tr, setTr] = useState<string | null>(null);
  const [poster, setPoster] = useState<{ text: string; ts?: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const read = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount) { setSel(null); setTr(null); return; }
      const text = s.toString().replace(/\s+/g, " ").trim();
      const r = s.getRangeAt(0);
      const host = (r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement) as HTMLElement | null;
      if (text.length < 4 || !host?.closest(ZONES) || host.closest(".sel-bar")) { setSel(null); return; }
      const rect = r.getBoundingClientRect();
      const ts = (r.startContainer.parentElement?.closest(".line")?.querySelector(".line-time")?.textContent ?? undefined) || undefined;
      const below = rect.top < 70;
      setTr(null);
      setSel({ text, x: Math.max(8, Math.min(rect.left + rect.width / 2, innerWidth - 8)), y: below ? rect.bottom + 10 : rect.top - 10, below, ts });
    };
    const onChange = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(read, 220); };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  const episode = async (): Promise<Episode | null> => {
    const { view, current } = useStore.getState();
    if (view.kind === "episode") return (await api.getEpisode(view.id)) ?? current;
    return current;
  };
  const copy = async () => {
    if (!sel) return;
    const ep = await episode();
    const src = ep ? `——《${ep.title}》${ep.showTitle ? ` · ${showName(ep.showTitle)}` : ""}${sel.ts ? ` · ${sel.ts}` : ""}${ep.link ? `\n${ep.link}` : ""}` : "";
    try { await navigator.clipboard.writeText(`“${sel.text}”\n${src}`); useStore.getState().notify("已复制，带出处"); } catch { useStore.getState().notify("复制失败"); }
  };
  const translate = async () => {
    if (!sel) return;
    setTr("…");
    try { setTr((await api.translateTexts([sel.text], CJK.test(sel.text) && !/[a-z]{4}/i.test(sel.text) ? "en" : "zh-CN"))[0] || "没有翻译结果"); }
    catch { setTr("翻译服务暂时连不上，稍后再试"); }
  };

  return (
    <>
      {sel && (
        <div className={`sel-bar ${sel.below ? "below" : ""}`} style={{ left: sel.x, top: sel.y }} role="toolbar" aria-label="选中文字操作" onMouseDown={(e) => e.preventDefault()}>
          <div className="sel-actions">
            <button onClick={copy}><Copy size={13} /> 复制</button>
            <button onClick={translate}><Languages size={13} /> 翻译</button>
            <button onClick={() => { setPoster({ text: sel.text, ts: sel.ts }); setSel(null); }}><ImageIcon size={13} /> 生成海报</button>
          </div>
          {tr && <div className="sel-tr">{tr === "…" ? <Loader2 size={13} className="spin" /> : tr}</div>}
        </div>
      )}
      {poster && <PosterDialog text={poster.text} ts={poster.ts} getEpisode={episode} onClose={() => setPoster(null)} />}
    </>
  );
}

function PosterDialog({ text, ts, getEpisode, onClose }: { text: string; ts?: string; getEpisode: () => Promise<Episode | null>; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [name, setName] = useState("SubCast 摘句");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const ep = await getEpisode();
        const cjk = CJK.test(text) && !/[a-z]{6}/i.test(text);
        let zh = cjk ? text : "";
        if (!cjk) { try { zh = (await api.translateTexts([text], "zh-CN"))[0] ?? ""; } catch { zh = ""; } }
        const titleZh = ep ? (await api.translateTexts([ep.title], "zh-CN").catch(() => [ep.title]))[0] || ep.title : "";
        const secs = toSeconds(ts);
        const link = ep?.videoId ? `https://www.youtube.com/watch?v=${ep.videoId}${secs ? `&t=${Math.floor(secs)}s` : ""}` : ep?.link;
        const logo = new Image(); logo.src = logoUrl; await logo.decode().catch(() => {});
        if (document.fonts?.ready) await document.fonts.ready;
        const c = await drawPoster({
          zh, en: cjk ? "" : text,
          title: titleZh,
          show: ep?.showTitle ? showName(ep.showTitle) : "",
          meta: [ep?.published ? new Date(ep.published).toLocaleDateString("zh-CN") : "", ts ? `第 ${ts}` : ""].filter(Boolean).join(" · "),
          url: link,
        }, logo);
        setName(`SubCast 摘句 ${(titleZh || "").slice(0, 20)}`);
        setUrl(c.toDataURL("image/png"));
      } catch (e) { setError(String((e as any)?.message ?? e)); }
    })();
  }, []);
  const save = async () => { if (!url) return; try { const p = await api.saveImage(name, url); useStore.getState().notify(`已保存到 ${p.replace(/^.*\/(Downloads|下载)\//, "下载/")}`); } catch (e) { useStore.getState().notify(String(e)); } };
  const copyImg = async () => {
    if (!url) return;
    try { const blob = await (await fetch(url)).blob(); await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); useStore.getState().notify("图片已复制"); }
    catch { useStore.getState().notify("复制失败，请用「保存图片」"); }
  };
  return (
    <Modal title="分享海报" onClose={onClose}>
      <div className="poster-pv">{url ? <img src={url} alt="分享海报" /> : error ? <p className="error-text">{error}</p> : <div className="poster-wait"><Loader2 className="spin" size={18} /> 正在生成海报…</div>}</div>
      <div className="modal-foot">
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}><X size={14} /> 关闭</button>
        <button className="btn" onClick={copyImg} disabled={!url}><Copy size={14} /> 复制图片</button>
        <button className="btn primary" onClick={save} disabled={!url}>保存图片</button>
      </div>
    </Modal>
  );
}
