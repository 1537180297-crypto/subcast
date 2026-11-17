// In-app updates: the signed manifest is checked a little after launch and every few hours. With
// "autoUpdate" on (the default) a new version downloads quietly in the background and waits for a restart;
// otherwise the user starts it. Tauri's updater downloads the whole package (about 7 MB on macOS), verifies
// its signature, installs it and restarts the app.
import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { api, errorText } from "./api";
import { useStore } from "../store";

export const DOWNLOAD_PAGE = "https://subcast.qiaomu.ai/download/";

/** "ready": downloaded and verified, installs on restart. */
type Phase = "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "installing" | "error";
interface UpdateState {
  phase: Phase;
  version?: string;
  notes?: string;
  /** 0–1 while downloading, null when the size is unknown. */
  progress: number | null;
  /** A background download the user didn't start: no banner until it is ready. */
  quiet?: boolean;
  error?: string;
  /** The user closed the banner for this version. */
  dismissed?: string;
}

export const useUpdate = create<UpdateState>(() => ({ phase: "idle", progress: null }));
/** A version is waiting for the user: shown as a dot on the settings button. */
export const hasUpdate = (s: UpdateState) => s.phase === "available" || s.phase === "ready";
let pending: Update | null = null;

export async function checkForUpdate(manual = false) {
  // Interface fixes come as hot updates (ota.rs), on their own schedule: independent of whether the app
  // update check works or finds anything. Used from the next launch.
  if (useStore.getState().settings.autoUpdate || manual) void api.uiCheck().catch((e) => console.warn("ui update", e));
  void api.refreshConfig().catch(() => { /* offline, or no config published: the saved one stays */ });
  const { phase } = useUpdate.getState();
  if (phase === "checking" || phase === "downloading" || phase === "installing" || phase === "ready") return;
  useUpdate.setState({ phase: "checking", error: undefined });
  try {
    const u = await check({ timeout: 20000 });
    pending = u;
    if (!u) { useUpdate.setState({ phase: manual ? "latest" : "idle" }); return; }
    useUpdate.setState({ phase: "available", version: u.version, notes: u.body });
    if (useStore.getState().settings.autoUpdate) void downloadUpdate(!manual);
  } catch (e) {
    // Background checks fail quietly (offline, server down); only a manual check reports it.
    useUpdate.setState({ phase: manual ? "error" : "idle", error: errorText(e) });
  }
}

/** Downloads and verifies the new version without installing it. */
export async function downloadUpdate(quiet = false) {
  if (!pending) return;
  let total = 0, got = 0;
  useUpdate.setState({ phase: "downloading", progress: null, quiet, error: undefined });
  try {
    await pending.download((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") { got += ev.data.chunkLength; useUpdate.setState({ progress: total ? Math.min(1, got / total) : null }); }
    });
    useUpdate.setState({ phase: "ready", quiet: false });
  } catch (e) {
    // A failed background download goes back to "available" so the user can try it by hand.
    useUpdate.setState(quiet ? { phase: "available", quiet: false } : { phase: "error", error: errorText(e) });
  }
}

/** Installs the downloaded version and restarts (downloading first when needed). */
export async function installUpdate() {
  if (!pending) return;
  try {
    if (useUpdate.getState().phase !== "ready") await downloadUpdate();
    if (useUpdate.getState().phase !== "ready") return;
    useUpdate.setState({ phase: "installing" });
    await pending.install();
    await relaunch();
  } catch (e) {
    useUpdate.setState({ phase: "error", error: errorText(e) });
  }
}

export const dismissUpdate = () => useUpdate.setState((s) => ({ dismissed: s.version }));

let started = false;
export function startUpdateChecks() {
  if (started || import.meta.env.DEV) return;
  started = true;
  window.setTimeout(() => void checkForUpdate(), 10_000);
  window.setInterval(() => void checkForUpdate(), 6 * 3600_000);
}
