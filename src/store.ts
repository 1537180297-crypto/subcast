import { create } from "zustand";
import { api, type Episode, type Show } from "./lib/api";
import { DEFAULTS, loadSettings, type Settings } from "./lib/settings";

export type View =
  | { kind: "latest" }
  | { kind: "recent" }
  | { kind: "discover" }
  | { kind: "show"; id: string }
  | { kind: "episode"; id: string };

export interface PlayerHandle {
  seek(seconds: number): void;
  toggle(): void;
  play(): void;
  setRate(rate: number): void;
}

interface State {
  ready: boolean;
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
  settingsSection?: "model" | "asr" | "general";
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
  openSettings(section?: "model" | "asr" | "general"): void;
  set(patch: Partial<State>): void;
}

let toastTimer: number | undefined;

export const useStore = create<State>((set, get) => ({
  ready: false,
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
    set({ settings, shows, ready: true });
    if (shows.length) api.refreshAll().then(() => get().reloadShows()).catch(() => {});
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

export const providerFor = (settings: Settings, use: "chat" | "translate") => settings.providers[use === "chat" ? settings.chatProvider : settings.translateProvider];
