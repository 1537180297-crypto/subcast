import { useEffect, useMemo, useState } from "react";
import { BookOpen, ExternalLink, Square, Volume2 } from "lucide-react";
import { SkeletonArticle } from "./Skeleton";
import { speak, stopSpeaking } from "../lib/tts";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type Episode } from "../lib/api";
import { useStore } from "../store";
import { t, tr } from "../lib/i18n";

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
  const speaking = useStore((s) => s.speaking);
  const read = () => {
    const doc = new DOMParser().parseFromString(clean, "text/html");
    doc.querySelectorAll("[data-t]").forEach((n) => n.remove());
    const text = Array.from(doc.body.querySelectorAll("p, h2, h3, h4, li, blockquote")).map((n) => n.textContent?.trim()).filter(Boolean).join("\n");
    void speak(text, (m) => useStore.getState().notify(m.includes("Key") ? t("{message}（设置 › 朗读）", { message: tr(m) }) : tr(m)));
  };
  if (html === undefined) return <SkeletonArticle />;
  if (!html) return <>{children}</>;
  return (
    <div className="deep-read">
      <div className="deep-head">
        <span className="deep-badge" title={t("AI 基于完整访谈改写的中文长文，不是逐字翻译")}><BookOpen size={13} /> {t("乔木精读")}</span>
        <span className="spacer" />
        {speaking
          ? <button className="btn sm" onClick={stopSpeaking}><Square size={11} /> {t("停止朗读")}</button>
          : <button className="btn sm" title={t("用豆包语音朗读精读全文")} onClick={read}><Volume2 size={13} /> {t("朗读")}</button>}
        {ep.link && <button className="icon-btn" title={t("在网页中打开")} onClick={() => openUrl(ep.link!)}><ExternalLink size={14} /></button>}
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
