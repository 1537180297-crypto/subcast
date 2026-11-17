import { create } from "zustand";
import { api, type Episode, type Show } from "./lib/api";
import { DEFAULTS, loadSettings, type Settings } from "./lib/settings";
import { setLang, t } from "./lib/i18n";

export type View =
  | { kind: "latest" }
  | { kind: "recent" }
  | { kind: "discover" }
  | { kind: "downloads" }
  | { kind: "show"; id: string }
  | { kind: "channel"; input: string }
  | { kind: "episode"; id: string };

export interface PlayerHandle {
  seek(seconds: number): void;
  toggle(): void;
  play(): void;
  setRate(rate: number): void;
}

interface State {
  speaking: boolean;
  ready: boolean;
  /** The hot update of the interface in use (ota.rs), null when it is the one built into the app. */
  uiBuild?: number | null;
  settings: Settings;
  shows: Show[];
  view: View;
  history: View[];
  /** The episode loaded in the player (may differ from the one being viewed). */
  current: Episode | null;
  time: number;
  length: number;
  playing: boolean;
  player: PlayerHandle | null;
  toast: string | null;
  settingsOpen: boolean;
  settingsSection?: "model" | "asr" | "tts" | "general" | "storage" | "about";
  addOpen: boolean;
  init(): Promise<void>;
  go(view: View): void;
  back(): void;
  reloadShows(): Promise<void>;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  openEpisode(ep: Episode): void;
  /** Loads an episode into the player without navigating. */
  load(ep: Episode): void;
  notify(text: string): void;
  openSettings(section?: "model" | "asr" | "tts" | "general" | "storage" | "about"): void;
  /** Checks every subscription for new episodes; tells the user when there are some. */
  checkUpdates(): Promise<void>;
  lastChecked: number;
  set(patch: Partial<State>): void;
}

const CHECK_EVERY = 30 * 60_000;

let toastTimer: number | undefined;

export const useStore = create<State>((set, get) => ({
  ready: false,
  speaking: false,
  settings: DEFAULTS,
  shows: [],
  view: { kind: "latest" },
  history: [],
  current: null,
  time: 0,
  length: 0,
  playing: false,
  player: null,
  toast: null,
  settingsOpen: false,
  addOpen: false,
  async init() {
    const [settings, shows] = await Promise.all([loadSettings(), api.listShows()]);
    setLang(settings.uiLang);
    void api.setMenuLabels([t("设置…")]).catch(() => {});
    set({ settings, shows, ready: true });
    void get().checkUpdates();
    // Periodically, and when the window comes back after a while (the app may sit in the background for hours).
    window.setInterval(() => void get().checkUpdates(), CHECK_EVERY);
    window.addEventListener("focus", () => { if (Date.now() - get().lastChecked > 10 * 60_000) void get().checkUpdates(); });
  },
  lastChecked: 0,
  async checkUpdates() {
    if (!get().shows.some((s) => s.kind !== "single")) return;
    set({ lastChecked: Date.now() });
    try {
      const r = await api.refreshAll();
      if (r.skipped) return;
      await get().reloadShows();
      if (r.newEpisodes > 0) get().notify(t("订阅有 {n} 期新节目", { n: r.newEpisodes }));
    } catch { /* offline: try again next time */ }
  },
  go(view) {
    set((s) => ({ view, history: [...s.history.slice(-30), s.view] }));
  },
  back() {
    const h = get().history;
    if (h.length) set({ view: h[h.length - 1], history: h.slice(0, -1) });
    else set({ view: { kind: "latest" } });
  },
  async reloadShows() {
    set({ shows: await api.listShows() });
  },
  async saveSettings(patch) {
    const settings = { ...get().settings, ...patch };
    if (patch.uiLang) { setLang(patch.uiLang); void api.setMenuLabels([t("设置…")]).catch(() => {}); }
    set({ settings });
    await api.setSettings(settings);
  },
  openEpisode(ep) {
    // The episode page decides whether to load it into the player (it leaves a playing episode alone).
    get().go({ kind: "episode", id: ep.id });
  },
  load(ep) {
    if (get().current?.id !== ep.id) set({ current: ep, time: ep.progress || 0, length: ep.duration || 0, playing: false, player: null });
  },
  notify(text) {
    set({ toast: text });
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => set({ toast: null }), 4200);
  },
  openSettings: (section) => set({ settingsOpen: true, settingsSection: section }),
  set: (patch) => set(patch),
}));

export function providerFor(settings: Settings, use: "chat" | "translate") {
  if (use === "translate") return settings.providers[settings.translateProvider];
  const p = settings.providers[settings.chatProvider];
  return p && settings.chatModel ? { ...p, model: settings.chatModel } : p;
}
