import { useEffect, useMemo, useState } from "react";
import { BookOpen, ExternalLink, Loader2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type Episode } from "../lib/api";
import { useStore } from "../store";

const KEEP = new Set(["P", "H2", "H3", "H4", "BLOCKQUOTE", "UL", "OL", "LI", "STRONG", "EM", "B", "I", "A", "BR", "HR", "SPAN", "ASIDE", "FIGURE", "FIGCAPTION", "CODE", "PRE"]);

/** Keeps the deep-read's structure and nothing executable: unknown elements are unwrapped, attributes dropped
 *  except link targets and the site's timestamp markers (data-t="0:47:55"). */
function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      walk(c);
      if (["SCRIPT", "STYLE", "IFRAME", "BUTTON", "FORM", "INPUT", "SVG", "IMG", "VIDEO", "AUDIO"].includes(c.tagName)) { c.remove(); continue; }
      if (!KEEP.has(c.tagName)) { c.replaceWith(...Array.from(c.childNodes)); continue; }
      const href = c.getAttribute("href");
      const t = c.getAttribute("data-t");
      for (const a of Array.from(c.attributes)) c.removeAttribute(a.name);
      if (c.tagName === "A" && href && /^https?:/.test(href)) c.setAttribute("href", href);
      if (t && /^[\d:]+$/.test(t)) { c.setAttribute("data-t", t); c.setAttribute("class", "ts"); }
    }
  };
  walk(doc.body.firstElementChild!);
  return doc.body.firstElementChild!.innerHTML;
}

const seconds = (t: string) => t.split(":").reduce((n, p) => n * 60 + Number(p), 0);

/** The 乔木精读 article for an episode, cached after the first fetch. */
export function DeepRead({ ep, children }: { ep: Episode; children?: React.ReactNode }) {
  const [html, setHtml] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setHtml(undefined);
    api.getBlob(ep.id, "deep-read").then(async (cached) => {
      if (cached) { if (live) setHtml(cached); return; }
      try { const d = await api.qiaomuDetail(ep.id); if (live) setHtml(d.deepRead ?? null); } catch { if (live) setHtml(null); }
    });
    return () => { live = false; };
  }, [ep.id]);
  const clean = useMemo(() => (html ? sanitize(html) : ""), [html]);
  if (html === undefined) return <div className="panel-empty"><Loader2 className="spin" size={20} /><p className="muted small">正在载入精读…</p></div>;
  if (!html) return <>{children}</>;
  return (
    <div className="deep-read">
      <div className="deep-head">
        <span className="deep-badge"><BookOpen size={13} /> 乔木精读</span>
        <span className="muted small">AI 基于完整访谈改写的中文长文，不是逐字翻译</span>
        {ep.link && <button className="icon-btn" title="在网页中打开" onClick={() => openUrl(ep.link!)}><ExternalLink size={14} /></button>}
      </div>
      <article
        className="deep-body"
        dangerouslySetInnerHTML={{ __html: clean }}
        onClick={(e) => {
          const el = e.target as HTMLElement;
          const ts = el.closest<HTMLElement>("[data-t]");
          if (ts) { useStore.getState().player?.seek(seconds(ts.dataset.t!)); return; }
          const a = el.closest("a");
          if (a?.href) { e.preventDefault(); void openUrl(a.href); }
        }}
      />
    </div>
  );
}
