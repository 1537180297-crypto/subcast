// 朗读: one button for reading text aloud (精读, 导读, 字幕中文) with a quick popover for switching engine, voice,
// previewing, or filling the active engine's key; full configuration lives in Settings › 朗读.
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, ExternalLink, Settings, Square, Volume2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { currentTtsService, isKeyError, speak, stopSpeaking } from "../lib/tts";
import { useStore } from "../store";
import { t, tr } from "../lib/i18n";
import { KeyField, NO_AUTO } from "./SettingsDialog";
import { PreviewButton, useSystemVoices } from "./TtsSettings";

export function ReadAloud({ text, title }: { text: () => string; title?: string }) {
  const speaking = useStore((s) => s.speaking);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, [open]);
  const read = () => void speak(text(), (m) => {
    useStore.getState().notify(tr(m));
    if (isKeyError(m)) setOpen(true);
  });
  return (
    <div className="read-aloud" ref={box}>
      {speaking
        ? <button className="btn sm" onClick={stopSpeaking}><Square size={11} /> {t("停止朗读")}</button>
        : <button className="btn sm" title={title ?? t("朗读")} onClick={read}><Volume2 size={13} /> {t("朗读")}</button>}
      <button className="icon-btn sm" aria-label={t("朗读设置")} title={t("朗读设置")} aria-expanded={open} onClick={() => setOpen(!open)}><ChevronDown size={13} /></button>
      {open && <ReadAloudSettings onClose={() => setOpen(false)} />}
    </div>
  );
}

export function ReadAloudSettings({ onClose }: { onClose?: () => void }) {
  const { settings, saveSettings, openSettings } = useStore(
    useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings, openSettings: s.openSettings })),
  );
  const svc = currentTtsService(settings);
  const [custom, setCustom] = useState(false);
  const sysVoices = useSystemVoices(svc.id === "system");

  useEffect(() => {
    setCustom(svc.group === "cloud" && svc.voices.length > 0 && !svc.voices.some((v) => v.id === svc.voice));
  }, [svc.id]);

  // Quick-switch row: free engines + Doubao + currently selected cloud engine (if another one).
  const quickIds = ["edge", "system", "doubao"];
  if (!quickIds.includes(svc.id)) quickIds.push(svc.id);

  const setVoice = (voice: string, extra?: Partial<typeof svc>, quiet = false) => {
    const next = { ...svc, voice, ...extra };
    const patch: Partial<typeof settings> = {
      ttsServices: { ...settings.ttsServices, [svc.id]: next },
    };
    if (svc.id === "doubao") {
      patch.ttsVoice = next.voice;
      patch.ttsResource = next.resource ?? "seed-tts-2.0";
    }
    void saveSettings(patch, quiet);
  };

  const zhSysVoices = sysVoices.filter((v) => v.lang.toLowerCase().startsWith("zh")).slice(0, 8);
  const popSysVoices = zhSysVoices.length > 0 ? zhSysVoices : sysVoices.slice(0, 8);

  return (
    <div className="read-aloud-pop" role="dialog" aria-label={t("朗读设置")}>
      <div className="setup-head">
        <p className="setup-title">{t("朗读引擎")}</p>
        <button
          className="link-btn small"
          onClick={() => { onClose?.(); openSettings("tts"); }}
        >
          <Settings size={11} /> {t("更多引擎")}
        </button>
      </div>
      <div className="model-chips">
        {quickIds.map((id) => {
          const item = settings.ttsServices[id];
          if (!item) return null;
          return (
            <button
              key={id}
              className={`chip sm ${svc.id === id ? "on" : ""}`}
              onClick={() => void saveSettings({ ttsEngine: id })}
            >
              {t(item.name)}
            </button>
          );
        })}
      </div>

      <div className="setup-head">
        <p className="setup-title">{t("音色")}</p>
        <PreviewButton engine={svc.id} voice={svc.voice} />
      </div>

      {svc.id === "system" ? (
        <div className="model-chips">
          <button className={`chip sm ${!svc.voice ? "on" : ""}`} onClick={() => setVoice("")}>
            {t("系统默认")}
          </button>
          {popSysVoices.map((v) => (
            <button key={v.id} className={`chip sm ${svc.voice === v.id ? "on" : ""}`} onClick={() => setVoice(v.id)}>
              {v.name}
            </button>
          ))}
        </div>
      ) : svc.voices.length > 0 ? (
        <div className="model-chips">
          {svc.voices.map((v) => (
            <button
              key={v.id}
              className={`chip sm ${svc.voice === v.id ? "on" : ""}`}
              onClick={() => {
                setCustom(false);
                setVoice(v.id, svc.protocol === "doubao" ? { resource: "seed-tts-2.0" } : undefined);
              }}
            >
              {t(v.name)}
            </button>
          ))}
        </div>
      ) : (
        <input
          {...NO_AUTO}
          value={svc.voice}
          onChange={(e) => setVoice(e.target.value.trim(), undefined, true)}
          placeholder={t("输入音色 ID")}
        />
      )}

      {svc.needsKey && (
        <>
          <p className="setup-title">{t("{name} Key", { name: t(svc.name) })}</p>
          <KeyField account={`tts.${svc.id}`} placeholder={svc.sharedKeyHint ? t(svc.sharedKeyHint) : undefined} />
          <div className="row-actions">
            {svc.keyUrl && (
              <button className="link-btn small" onClick={() => openUrl(svc.keyUrl!)}>
                <ExternalLink size={12} /> {t("获取 Key")}
              </button>
            )}
            <span className="spacer" />
            {svc.voices.length > 0 && (
              <button className="link-btn small" onClick={() => setCustom(!custom)}>
                {t("自定义音色")}
              </button>
            )}
          </div>
        </>
      )}

      {custom && svc.voices.length > 0 && (
        <>
          <input
            {...NO_AUTO}
            value={svc.voice}
            onChange={(e) => setVoice(e.target.value.trim(), undefined, true)}
            placeholder={svc.protocol === "doubao" ? t("复刻音色或其他音色的 ID") : t("输入音色 ID")}
          />
          {svc.protocol === "doubao" && (
            <label className="check">
              <input
                type="checkbox"
                checked={svc.resource === "seed-icl-2.0"}
                onChange={(e) => setVoice(svc.voice, { resource: e.target.checked ? "seed-icl-2.0" : "seed-tts-2.0" })}
              />{" "}
              {t("这是我复刻的声音")}
            </label>
          )}
        </>
      )}

      <p className="muted small">
        {svc.id === "system"
          ? t("完全在本机离线合成，文字不会离开你的电脑。")
          : t("朗读时文字会发送到 {name}。", { name: t(svc.name) })}
      </p>
    </div>
  );
}
