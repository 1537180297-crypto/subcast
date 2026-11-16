// Chinese translations of titles and show notes, fetched lazily as they appear on screen. Requests made within
// a short window are sent together; results are cached in memory here and on disk by the Rust side.
import { create } from "zustand";
import { api } from "./api";

const CJK = /[㐀-鿿]/;
/** True when the text is mostly Chinese already (no translation needed). */
export const isZh = (text: string) => {
  const cjk = (text.match(/[㐀-鿿]/g) ?? []).length;
  return cjk > 0 && cjk >= text.replace(/\s/g, "").length * 0.25;
};

const useZhStore = create<{ map: Record<string, string> }>(() => ({ map: {} }));
const queued = new Set<string>();
const inFlight = new Set<string>();
let timer: number | undefined;

async function flush() {
  timer = undefined;
  const texts = [...queued].slice(0, 60);
  texts.forEach((t) => { queued.delete(t); inFlight.add(t); });
  if (queued.size) timer = window.setTimeout(flush, 60);
  try {
    const out = await api.translateTexts(texts);
    useZhStore.setState((s) => {
      const map = { ...s.map };
      texts.forEach((t, i) => { if (out[i]) map[t] = out[i]; });
      return { map };
    });
  } catch {
    /* offline: titles simply stay in the original language */
  } finally {
    texts.forEach((t) => inFlight.delete(t));
  }
}

function request(text: string) {
  if (useZhStore.getState().map[text] || queued.has(text) || inFlight.has(text)) return;
  queued.add(text);
  if (!timer) timer = window.setTimeout(flush, 50);
}

/** The Chinese version of `text`, or undefined while loading / when the text is already Chinese. */
export function useZh(text: string | undefined | null): string | undefined {
  const clean = (text ?? "").trim();
  const need = clean.length > 0 && !isZh(clean);
  const value = useZhStore((s) => (need ? s.map[clean] : undefined));
  if (need && !value) request(clean);
  return value;
}

/** Long text (show notes): split into paragraphs so each is translated and cached on its own. */
export function useZhParagraphs(text: string | undefined, enabled: boolean): string[] | undefined {
  const paras = enabled && text ? text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).slice(0, 40).map((p) => p.slice(0, 3000)) : [];
  const map = useZhStore((s) => s.map);
  if (!paras.length || isZh(text ?? "")) return undefined;
  const missing = paras.filter((p) => !map[p]);
  missing.forEach(request);
  if (missing.length) return undefined;
  return paras.map((p) => map[p] ?? p);
}

export { CJK };
