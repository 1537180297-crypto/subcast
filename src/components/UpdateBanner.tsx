import { Download, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { DOWNLOAD_PAGE, dismissUpdate, useUpdate } from "../lib/updater";
import { t } from "../lib/i18n";

/** A waiting update is the upgrade button next to Settings; this card only appears when an update failed. */
export function UpdateBanner() {
  const { phase, version, error, dismissed } = useUpdate();
  if (phase !== "error" || !version || dismissed === version) return null;
  return (
    <div className="update-card" role="status">
      <Download size={16} className="update-icon" />
      <div className="update-text">
        <p className="update-title">{t("更新没有完成")}</p>
        <p className="muted small">{error}</p>
      </div>
      <button className="btn sm" onClick={() => void openUrl(DOWNLOAD_PAGE)}>{t("去官网下载")}</button>
      <button className="icon-btn" title={t("稍后")} onClick={dismissUpdate}><X size={14} /></button>
    </div>
  );
}
