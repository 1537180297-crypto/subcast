import { Download, Loader2, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { DOWNLOAD_PAGE, dismissUpdate, installUpdate, useUpdate } from "../lib/updater";
import { t } from "../lib/i18n";

/** A quiet card in the corner when a new version is ready to install. */
export function UpdateBanner() {
  const { phase, version, progress, error, dismissed, quiet } = useUpdate();
  const show = (phase === "downloading" && !quiet) || phase === "installing" || ((phase === "available" || phase === "ready") && dismissed !== version) || (phase === "error" && !!version && dismissed !== version);
  if (!show) return null;
  return (
    <div className="update-card" role="status">
      <Download size={16} className="update-icon" />
      <div className="update-text">
        {phase === "ready" || phase === "installing" ? (
          <>
            <p className="update-title">{t("SubCast {version} 已下载好", { version: version ?? "" })}</p>
            <p className="muted small">{t("重启即可完成更新，播放进度会保留")}</p>
          </>
        ) : phase === "downloading" ? (
          <>
            <p className="update-title">{progress == null ? t("正在下载新版本…") : t("正在下载新版本 {pct}%", { pct: Math.round(progress * 100) })}</p>
            <div className="update-bar"><span style={{ width: `${Math.round((progress ?? 0.08) * 100)}%` }} /></div>
          </>
        ) : phase === "error" ? (
          <>
            <p className="update-title">{t("更新没有完成")}</p>
            <p className="muted small">{error}</p>
          </>
        ) : (
          <>
            <p className="update-title">{t("SubCast {version} 可以更新了", { version: version ?? "" })}</p>
            <p className="muted small">{t("更新后会自动重启，播放进度会保留")}</p>
          </>
        )}
      </div>
      {phase === "available" && <button className="btn primary sm" onClick={() => void installUpdate()}>{t("更新并重启")}</button>}
      {phase === "ready" && <button className="btn primary sm" onClick={() => void installUpdate()}>{t("立即重启")}</button>}
      {phase === "error" && <button className="btn sm" onClick={() => void openUrl(DOWNLOAD_PAGE)}>{t("去官网下载")}</button>}
      {phase === "downloading" || phase === "installing" ? <Loader2 size={14} className="spin muted" /> : <button className="icon-btn" title={t("稍后")} onClick={dismissUpdate}><X size={14} /></button>}
    </div>
  );
}
