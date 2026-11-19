// Offline Melo / Kokoro voices (sherpa-onnx): what is downloaded, and the one download that may be running.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api, errorText, rawErrorText, type LocalTtsStatus } from "./api";
import { useStore } from "../store";
import { t } from "./i18n";

export type LocalModelId = "melo" | "kokoro";
interface Progress { id: string; received: number; total?: number }

export const useLocalTts = create<{ status: LocalTtsStatus | null; downloading: Progress | null }>(() => ({
  status: null,
  downloading: null,
}));

export async function refreshLocalTts() {
  try { useLocalTts.setState({ status: await api.localTtsStatus() }); } catch { /* not in the app shell */ }
}

export function localInstalled(status: LocalTtsStatus | null, id: string): boolean {
  return !!status?.models.find((m) => m.id === id)?.installed;
}

let listening: Promise<unknown> | null = null;

/** Downloads a model (and the runtime the first time). Returns whether it is ready. */
export async function installLocalTts(id: LocalModelId): Promise<boolean> {
  listening ??= listen<Progress>("local-tts-download", (e) => useLocalTts.setState({ downloading: e.payload }));
  useLocalTts.setState({ downloading: { id, received: 0 } });
  try {
    await api.localTtsInstall(id, true);
    return true;
  } catch (e) {
    if (!rawErrorText(e).includes("取消")) useStore.getState().notify(t("本地语音下载失败：{error}", { error: errorText(e) })); // i18n-ignore (matches the backend's cancel message)
    return false;
  } finally {
    useLocalTts.setState({ downloading: null });
    await refreshLocalTts();
  }
}

export const cancelLocalTts = (id: string) => api.cancelJob(`local-tts:${id}`);

export async function deleteLocalTts(id: LocalModelId) {
  try { await api.localTtsDelete(id); } catch (e) { useStore.getState().notify(errorText(e)); }
  await refreshLocalTts();
}
