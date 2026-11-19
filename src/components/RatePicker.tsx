// 语速 for read-aloud: a segmented control (Settings, the read-aloud popover) and a small "1.25×" button that opens it
// beside a read-aloud button. A change applies to what is being read right away; the video's own speed doesn't stack.
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { t } from "../lib/i18n";

export const TTS_RATES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];

export function RateControl() {
  const rate = useStore((s) => s.settings.ttsRate ?? 1);
  const saveSettings = useStore((s) => s.saveSettings);
  return (
    <div className="seg-control tts-rate-seg" role="radiogroup" aria-label={t("朗读语速")}>
      {TTS_RATES.map((r) => (
        <button
          key={r}
          role="radio"
          aria-checked={rate === r}
          className={rate === r ? "on" : ""}
          onClick={() => void saveSettings({ ttsRate: r }, true)}
        >
          {r}×
        </button>
      ))}
    </div>
  );
}

export function RatePicker() {
  const rate = useStore((s) => s.settings.ttsRate ?? 1);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", h);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("pointerdown", h); document.removeEventListener("keydown", k); };
  }, [open]);
  return (
    <div className="tts-rate" ref={box}>
      <button
        className={`tts-rate-btn ${open ? "on" : ""}`}
        title={t("朗读语速")}
        aria-label={t("朗读语速")}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {rate}×
      </button>
      {open && (
        <div className="tts-rate-pop" role="dialog" aria-label={t("朗读语速")}>
          <p className="setup-title">{t("朗读语速")}</p>
          <RateControl />
        </div>
      )}
    </div>
  );
}
