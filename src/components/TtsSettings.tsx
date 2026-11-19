import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, Cloud, ExternalLink, Globe, Laptop, Square, Trash2, Volume2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type SystemVoice } from "../lib/api";
import { TTS_CLOUD_MAIN, TTS_SERVICES, type TtsService } from "../lib/settings";
import { currentTtsService, previewVoice, stopSpeaking, useTtsPreview } from "../lib/tts";
import { useStore } from "../store";
import { IS_MAC, t, tk, tr } from "../lib/i18n";
import { bytes } from "../lib/offline";
import { ask } from "../lib/confirm";
import {
  cancelLocalTts, deleteLocalTts, installLocalTts, localInstalled, refreshLocalTts, useLocalTts, type LocalModelId,
} from "../lib/localTts";
import { KeyField, NO_AUTO } from "./SettingsDialog";

const TTS_RATES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];

/** One preview button for the active engine + voice. */
export function PreviewButton({ engine, voice }: { engine: string; voice: string }) {
  const active = useTtsPreview((s) => s.active);
  const notify = useStore((s) => s.notify);
  const key = `${engine}:${voice}`;
  const playing = active === key;
  return (
    <button
      className="btn ghost sm"
      onClick={() => void previewVoice(engine, voice, (m) => notify(tr(m)))}
    >
      {playing ? <Square size={11} /> : <Volume2 size={13} />}
      {playing ? t("停止试听") : t("试听")}
    </button>
  );
}

/** Shared hook to load installed OS voices once per mount. */
export function useSystemVoices(enabled: boolean): SystemVoice[] {
  const [voices, setVoices] = useState<SystemVoice[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void api.ttsSystemVoices().then((v) => { if (alive) setVoices(v); }).catch(() => {});
    return () => { alive = false; };
  }, [enabled]);
  return voices;
}

function CloudTtsEditor({
  svc,
  onChange,
}: {
  svc: TtsService;
  onChange: (next: TtsService, quiet?: boolean) => void;
}) {
  const [customVoice, setCustomVoice] = useState(
    svc.voices.length === 0 || !svc.voices.some((v) => v.id === svc.voice),
  );
  const [advanced, setAdvanced] = useState(svc.id === "custom");

  return (
    <div className="provider-form">
      <p className="muted small">
        {t("{note}。朗读时文字会发送到 {name}。", { note: t(svc.note), name: t(svc.name) })}
      </p>

      <div className="setup-head">
        <p className="setup-title">{t("音色")}</p>
        <div className="row-actions">
          {svc.voices.length > 0 && (
            <button className="link-btn small" onClick={() => setCustomVoice(!customVoice)}>
              {t("自定义音色")}
            </button>
          )}
          <PreviewButton engine={svc.id} voice={svc.voice} />
        </div>
      </div>

      {svc.voices.length > 0 && (
        <div className="model-chips">
          {svc.voices.map((v) => (
            <button
              key={v.id}
              className={`chip sm ${svc.voice === v.id ? "on" : ""}`}
              onClick={() => {
                setCustomVoice(false);
                onChange({
                  ...svc,
                  voice: v.id,
                  ...(svc.protocol === "doubao" ? { resource: "seed-tts-2.0" } : {}),
                });
              }}
            >
              {t(v.name)}
            </button>
          ))}
        </div>
      )}

      {customVoice && (
        <>
          <input
            {...NO_AUTO}
            value={svc.voice}
            onChange={(e) => onChange({ ...svc, voice: e.target.value.trim() }, true)}
            placeholder={svc.protocol === "doubao" ? t("复刻音色或其他音色的 ID") : t("输入音色 ID")}
          />
          {svc.protocol === "doubao" && (
            <label className="check">
              <input
                type="checkbox"
                checked={svc.resource === "seed-icl-2.0"}
                onChange={(e) => onChange({ ...svc, resource: e.target.checked ? "seed-icl-2.0" : "seed-tts-2.0" })}
              />{" "}
              {t("这是我复刻的声音")}
            </label>
          )}
        </>
      )}

      {(svc.needsKey || svc.id === "custom") && (
        <div className="setup-block">
          <div className="setup-head">
            <p className="setup-title">API Key</p>
            {svc.keyUrl && (
              <button className="link-btn small" onClick={() => openUrl(svc.keyUrl!)}>
                <ExternalLink size={11} /> {t("获取 Key")}
              </button>
            )}
          </div>
          <KeyField
            account={`tts.${svc.id}`}
            placeholder={
              svc.sharedKeyHint
                ? t(svc.sharedKeyHint)
                : svc.needsKey
                  ? undefined
                  : t("可选，本地服务可留空")
            }
          />
        </div>
      )}

      <div className="row-actions">
        <span className="spacer" />
        <button className="adv-toggle" onClick={() => setAdvanced(!advanced)}>
          <ChevronDown size={12} className={advanced ? "flip" : ""} /> {t("高级设置")}
        </button>
      </div>

      {advanced && (
        <div className="adv-body">
          <label>
            <span>{t("接口地址")}</span>
            <input
              {...NO_AUTO}
              value={svc.baseUrl}
              onChange={(e) => onChange({ ...svc, baseUrl: e.target.value }, true)}
              placeholder="https://…/v1"
            />
          </label>
          {svc.protocol !== "doubao" && (
            <>
              <label>
                <span>{t("模型")}</span>
                <input
                  {...NO_AUTO}
                  value={svc.model}
                  list={`tts-model-${svc.id}`}
                  onChange={(e) => onChange({ ...svc, model: e.target.value }, true)}
                  placeholder={t("模型名")}
                />
                <datalist id={`tts-model-${svc.id}`}>
                  {svc.models.map((m) => <option key={m} value={m} />)}
                </datalist>
              </label>
              {svc.models.length > 1 && (
                <div className="model-chips">
                  {svc.models.map((m) => (
                    <button
                      key={m}
                      className={`chip sm ${svc.model === m ? "on" : ""}`}
                      onClick={() => onChange({ ...svc, model: m })}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The three offline choices: Melo and Kokoro (downloaded on first use) and the Mac's own Tingting. */
const LOCAL_MODELS: { id: LocalModelId; name: string; note: string }[] = [
  { id: "melo", name: "Melo", note: tk("中英混读，一个女声，最快") },
  { id: "kokoro", name: "Kokoro", note: tk("8 种中文男女声，英文也能读") },
];

/** Whether this engine id is one of the offline voices shown under 「本地语音」. */
export const isLocalEngine = (id: string) => id === "local" || id === "system";

function LocalTtsEditor({ onPick }: { onPick: (engine: "local" | "system", model?: LocalModelId) => void }) {
  const { settings, saveSettings } = useStore(
    useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings })),
  );
  const { status, downloading } = useLocalTts(useShallow((s) => ({ status: s.status, downloading: s.downloading })));
  const notify = useStore((s) => s.notify);
  const [moreSysVoices, setMoreSysVoices] = useState(false);
  const active = currentTtsService(settings);
  const local = settings.ttsServices.local;
  const sysVoices = useSystemVoices(true);
  const onSystem = active.id === "system";
  const model = (local.model === "kokoro" ? "kokoro" : "melo") as LocalModelId;
  const supported = status?.supported ?? true;

  useEffect(() => { void refreshLocalTts(); }, []);

  const setLocal = (patch: Partial<typeof local>) =>
    void saveSettings({ ttsServices: { ...settings.ttsServices, local: { ...local, ...patch } } });
  const setSystemVoice = (voice: string) =>
    void saveSettings({ ttsServices: { ...settings.ttsServices, system: { ...settings.ttsServices.system, voice } } });

  const hasTingting = sysVoices.some((v) => v.id === "Tingting");
  const zhSysVoices = sysVoices.filter((v) => v.lang.toLowerCase().startsWith("zh"));
  const otherSysVoices = sysVoices.filter((v) => !v.lang.toLowerCase().startsWith("zh"));
  const shownSysVoices = moreSysVoices || zhSysVoices.length === 0 ? sysVoices : zhSysVoices;

  const remove = async (id: LocalModelId) => {
    if (!(await ask({ title: t("删除这个本地语音模型？"), message: t("以后再用需要重新下载。"), ok: t("删除"), danger: true }))) return;
    await deleteLocalTts(id);
  };

  const modelState = status?.models.find((m) => m.id === model);
  const installed = localInstalled(status, model);
  const dl = downloading?.id === model ? downloading : null;

  return (
    <div className="provider-form">
      <div className="setup-head">
        <p className="setup-title">{t("模型")}</p>
        <PreviewButton engine={active.id} voice={active.voice} />
      </div>
      <div className="model-chips">
        {supported && LOCAL_MODELS.map((m) => (
          <button
            key={m.id}
            className={`chip sm ${active.id === "local" && model === m.id ? "on" : ""}`}
            onClick={() => onPick("local", m.id)}
          >
            {m.name}
          </button>
        ))}
        <button className={`chip sm ${onSystem ? "on" : ""}`} onClick={() => onPick("system")}>
          {IS_MAC ? t("婷婷（系统自带）") : t("系统语音")}
        </button>
      </div>

      {active.id === "local" && (
        <>
          <p className="muted small">{t(LOCAL_MODELS.find((m) => m.id === model)!.note)}</p>
          <div className="storage-row">
            <div className="storage-row-text">
              <p className="storage-row-name">{installed ? t("已下载") : t("首次使用需要下载")}</p>
              <p className="muted small">
                {dl
                  ? `${bytes(dl.received)}${dl.total ? ` / ${bytes(dl.total)}` : ""}`
                  : modelState ? t("约 {size}", { size: bytes(modelState.bytes + (status?.runtime ? 0 : 22 * 1024 * 1024)) }) : ""}
              </p>
            </div>
            {dl ? (
              <div className="dl">
                <span className="small num">{dl.total ? Math.round((dl.received / dl.total) * 100) : 0}%</span>
                <button className="btn ghost sm" onClick={() => void cancelLocalTts(model)}>{t("取消")}</button>
              </div>
            ) : installed ? (
              <button className="icon-btn" title={t("删除")} onClick={() => void remove(model)}><Trash2 size={14} /></button>
            ) : (
              <button
                className="btn sm"
                disabled={downloading != null}
                onClick={() => void installLocalTts(model).then((ok) => ok && notify(t("本地语音已就绪")))}
              >
                {t("下载")}
              </button>
            )}
          </div>
          {model === "kokoro" && (
            <>
              <p className="setup-title">{t("音色")}</p>
              <div className="model-chips">
                {local.voices.map((v) => (
                  <button
                    key={v.id}
                    className={`chip sm ${local.voice === v.id ? "on" : ""}`}
                    onClick={() => setLocal({ voice: v.id })}
                  >
                    {t(v.name)}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {onSystem && IS_MAC && !hasTingting && sysVoices.length > 0 && (
        <p className="muted small">{t("这台 Mac 还没有婷婷的声音：到 系统设置 › 辅助功能 › 朗读内容 › 系统声音 › 管理声音 里下载「中文（中国大陆）› 婷婷」。")}</p>
      )}

      {onSystem && !IS_MAC && (
        <>
          <div className="model-chips">
            <button className={`chip sm ${!active.voice ? "on" : ""}`} onClick={() => setSystemVoice("")}>
              {t("系统默认")}
            </button>
            {shownSysVoices.map((v) => (
              <button
                key={v.id}
                className={`chip sm ${active.voice === v.id ? "on" : ""}`}
                onClick={() => setSystemVoice(v.id)}
              >
                {v.name} <span className="muted">({v.lang})</span>
              </button>
            ))}
          </div>
          {otherSysVoices.length > 0 && zhSysVoices.length > 0 && (
            <button className="adv-toggle" onClick={() => setMoreSysVoices(!moreSysVoices)}>
              <ChevronDown size={12} className={moreSysVoices ? "flip" : ""} />{" "}
              {moreSysVoices ? t("收起其他语言音色") : t("其他语言音色（{n}）", { n: otherSysVoices.length })}
            </button>
          )}
        </>
      )}

      <p className="muted small">{t("完全在本机离线合成，文字不会离开你的电脑。")}</p>
    </div>
  );
}

export function TtsSettings() {
  const { settings, saveSettings } = useStore(
    useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings })),
  );
  const [moreCloud, setMoreCloud] = useState(false);
  const active = currentTtsService(settings);
  const isCloud = active.group === "cloud";
  const lastCloudId = isCloud ? active.id : "doubao";

  useEffect(() => () => stopSpeaking(), []);

  const updateService = (next: TtsService, quiet = false) => {
    const patch: Partial<typeof settings> = {
      ttsServices: { ...settings.ttsServices, [next.id]: next },
    };
    if (next.id === "doubao") {
      patch.ttsVoice = next.voice;
      patch.ttsResource = next.resource ?? "seed-tts-2.0";
    }
    void saveSettings(patch, quiet);
  };

  /** Melo / Kokoro become the active engine; picking one also downloads it when it is missing. */
  const pickLocal = (engine: "local" | "system", model?: LocalModelId) => {
    const st = useLocalTts.getState();
    if (engine === "local" && model) {
      const local = settings.ttsServices.local;
      void saveSettings({ ttsEngine: "local", ttsServices: { ...settings.ttsServices, local: { ...local, model } } });
      if (st.status?.supported && !localInstalled(st.status, model) && !st.downloading) void installLocalTts(model);
    } else {
      void saveSettings({ ttsEngine: engine });
    }
  };
  const localOn = isLocalEngine(active.id);
  const lastLocal = settings.ttsEngine === "system" ? "system" : "local";

  const cloudServices = TTS_SERVICES.filter((s) => s.group === "cloud");

  return (
    <>
      <section className="setup-block">
        <p className="setup-title">{t("朗读引擎")}</p>
        <p className="muted small">{t("用于精读、导读和字幕面板里的中文朗读。")}</p>
        <div className="engine-switch tts-engine-switch">
          <button
            className={`engine ${active.id === "edge" ? "on" : ""}`}
            onClick={() => void saveSettings({ ttsEngine: "edge" })}
          >
            <Globe size={18} />
            <div>
              <p>{t("免费在线")}</p>
              <p className="muted small">{t("Edge 语音，免 Key，中文自然")}</p>
            </div>
          </button>
          <button
            className={`engine ${localOn ? "on" : ""}`}
            onClick={() => void saveSettings({ ttsEngine: localOn ? active.id : lastLocal })}
          >
            <Laptop size={18} />
            <div>
              <p>{t("本地语音")}</p>
              <p className="muted small">{IS_MAC ? t("Melo、Kokoro、婷婷，不联网") : t("Melo、Kokoro，不联网")}</p>
            </div>
          </button>
          <button
            className={`engine ${isCloud ? "on" : ""}`}
            onClick={() => void saveSettings({ ttsEngine: lastCloudId })}
          >
            <Cloud size={18} />
            <div>
              <p>{t("云端服务")}</p>
              <p className="muted small">{t("豆包、MiMo、通义等，需 Key")}</p>
            </div>
          </button>
        </div>

        {active.id === "edge" && (
          <div className="provider-form">
            <div className="setup-head">
              <p className="setup-title">{t("音色")}</p>
              <PreviewButton engine="edge" voice={active.voice} />
            </div>
            <div className="model-chips">
              {active.voices.map((v) => (
                <button
                  key={v.id}
                  className={`chip sm ${active.voice === v.id ? "on" : ""}`}
                  onClick={() => updateService({ ...active, voice: v.id })}
                >
                  {t(v.name)}
                </button>
              ))}
            </div>
            <p className="muted small">{t("使用微软 Edge 朗读接口，免费无需 Key；朗读时文字会发送到微软服务，高峰期可能偶尔限流。")}</p>
          </div>
        )}

        {localOn && <LocalTtsEditor onPick={pickLocal} />}

        {isCloud && (
          <>
            <div className="provider-tabs">
              {cloudServices
                .filter((s) => moreCloud || TTS_CLOUD_MAIN.includes(s.id) || active.id === s.id)
                .map((s) => (
                  <button
                    key={s.id}
                    className={`chip ${active.id === s.id ? "on" : ""}`}
                    onClick={() => void saveSettings({ ttsEngine: s.id })}
                  >
                    {t(s.name)}
                  </button>
                ))}
              {!moreCloud && (
                <button className="chip" onClick={() => setMoreCloud(true)}>
                  {t("更多")}
                </button>
              )}
            </div>
            <CloudTtsEditor key={active.id} svc={active} onChange={updateService} />
          </>
        )}
      </section>

      <section className="setup-block">
        <p className="setup-title">{t("朗读语速")}</p>
        <div className="model-chips">
          {TTS_RATES.map((r) => (
            <button
              key={r}
              className={`chip sm ${(settings.ttsRate ?? 1) === r ? "on" : ""}`}
              onClick={() => void saveSettings({ ttsRate: r })}
            >
              {r}×
            </button>
          ))}
        </div>
        <p className="muted small">{t("字幕面板朗读中文时还会叠乘当前播放倍速。")}</p>
      </section>
    </>
  );
}
