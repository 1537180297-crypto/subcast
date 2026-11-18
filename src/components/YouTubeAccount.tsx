// Signing in to YouTube inside SubCast (ytlogin.rs), for videos YouTube only plays after its "not a bot" check.
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorText } from "../lib/api";
import { useStore } from "../store";
import { t } from "../lib/i18n";

/** Opens the sign-in window and calls `onDone` once the listener is signed in. */
export function useYouTubeSignIn(onDone: () => void) {
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const off = listen("youtube-signed-in", () => { setWaiting(false); onDone(); });
    return () => { void off.then((f) => f()); };
  }, [waiting]);
  const start = async () => {
    try { await api.youtubeSignIn(); setWaiting(true); }
    catch (e) { useStore.getState().notify(errorText(e)); }
  };
  return { start, waiting };
}

/** Settings › 通用: whether SubCast is signed in to YouTube, with sign-in and sign-out. */
export function YouTubeAccount() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const check = () => void api.youtubeSignedIn().then(setSignedIn).catch(() => setSignedIn(false));
  useEffect(check, []);
  const { start, waiting } = useYouTubeSignIn(() => { setSignedIn(true); useStore.getState().notify(t("已登录 YouTube")); });
  const signOut = async () => {
    try { await api.youtubeSignOut(); setSignedIn(false); useStore.getState().notify(t("已退出 YouTube")); }
    catch (e) { useStore.getState().notify(errorText(e)); }
  };
  return (
    <div className="field"><span>{t("YouTube 账号")}</span>
      <div className="key-row">
        <span className="small yt-account-state">{signedIn == null ? "" : signedIn ? t("已在 SubCast 里登录") : waiting ? t("在弹出的窗口里登录…") : t("未登录")}</span>
        {signedIn
          ? <button className="btn sm" onClick={() => void signOut()}>{t("退出")}</button>
          : <button className="btn sm" onClick={() => void start()}>{t("登录 YouTube")}</button>}
      </div>
    </div>
  );
}
