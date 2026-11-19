import { useEffect, useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { useStore } from "../store";

export const NO_AUTO = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

/** One default model for translation and the guide; Q&A starts with it and can switch in the chat box. */
export function DefaultButton({ id, isDefault }: { id: string; isDefault: boolean }) {
  const saveSettings = useStore((s) => s.saveSettings);
  const mode = useStore((s) => s.settings.translateMode);
  return isDefault
    ? <p className="default-on small"><Check size={13} /> {t("当前默认模型")}</p>
    : <button className="btn primary sm" onClick={() => void saveSettings({ translateProvider: id, chatProvider: id, chatModel: "", modelChosen: true, ...(mode === "google" ? { translateMode: "auto" } : {}) })}>{t("设为默认模型")}</button>;
}

export function KeyField({ account, placeholder }: { account: string; placeholder?: string }) {
  const [key, setKey] = useState("");
  const [has, setHas] = useState(false);
  useEffect(() => { setKey(""); api.hasApiKey(account).then(setHas); }, [account]);
  return <KeyRow key={account} has={has} value={key} onValue={setKey} placeholder={placeholder}
    onSave={async () => { await api.setApiKey(account, key); setHas(!!key.trim()); setKey(""); }}
    onDelete={async () => { await api.setApiKey(account, ""); setHas(false); }} />;
}

/** A saved key reads as saved (a tinted row with a check and masked dots), not as an empty field;
 *  「更换」 opens the field again. */
export function KeyRow({ has, value, onValue, onSave, onDelete, placeholder }: { has: boolean; value: string; onValue: (v: string) => void; onSave: () => Promise<void>; onDelete: () => Promise<void>; placeholder?: string }) {
  const [editing, setEditing] = useState(false);
  if (has && !editing) {
    return (
      <div className="key-row key-saved" title={t("存于系统钥匙串")}>
        <span className="key-state"><Check size={14} /><span>{t("已保存")}</span><span className="key-dots" aria-hidden>••••••••</span></span>
        <button className="btn sm" onClick={() => setEditing(true)}>{t("更换")}</button>
        <button className="icon-btn" title={t("删除 Key")} aria-label={t("删除 Key")} onClick={() => void onDelete()}><Trash2 size={14} /></button>
      </div>
    );
  }
  return (
    <div className="key-row">
      <input {...NO_AUTO} type="password" autoFocus={editing} value={value} onChange={(e) => onValue(e.target.value)} placeholder={placeholder ?? t("粘贴 API Key")} />
      <button className="btn sm" onClick={async () => { await onSave(); setEditing(false); }} disabled={!value.trim()}>{t("保存")}</button>
      {has && <button className="btn ghost sm" onClick={() => { onValue(""); setEditing(false); }}>{t("取消")}</button>}
    </div>
  );
}
