import { playSoon } from "../components/Players";
// Saved episodes (favorites) and the play queue. Favorites live in the library database (blob "_app"/"favorites"),
// so they survive restarts like subscriptions do; the queue is for this session only.
import { create } from "zustand";
import { api, type Episode } from "./api";
import { t } from "./i18n";
import { useStore } from "../store";

interface Fav { id: string; at: number }
interface Library {
  favorites: Fav[];
  /** Episodes still to play after the current one, in order. */
  queue: Episode[];
}

export const useLibrary = create<Library>(() => ({ favorites: [], queue: [] }));
const KEY = ["_app", "favorites"] as const;

export async function loadFavorites() {
  try { const raw = await api.getBlob(...KEY); if (raw) useLibrary.setState({ favorites: JSON.parse(raw) }); } catch { /* none yet */ }
}

export const isFavorite = (id: string) => useLibrary.getState().favorites.some((f) => f.id === id);

export function toggleFavorite(ep: Episode) {
  const { favorites } = useLibrary.getState();
  const on = favorites.some((f) => f.id === ep.id);
  const next = on ? favorites.filter((f) => f.id !== ep.id) : [{ id: ep.id, at: Date.now() }, ...favorites];
  useLibrary.setState({ favorites: next });
  void api.setBlob(...KEY, JSON.stringify(next));
  useStore.getState().notify(on ? t("已取消收藏") : t("已收藏，在「继续收听」里能找到"));
}

/** Opens an episode and starts it (video episodes need their page open to play). */
function start(ep: Episode) {
  const s = useStore.getState();
  s.load(ep);
  s.openEpisode(ep);
  playSoon(ep.id);
}

/** Plays the list in order, starting with the first. */
export function playAll(eps: Episode[]) {
  if (!eps.length) return;
  useLibrary.setState({ queue: eps.slice(1) });
  start(eps[0]);
}

/** Called when an episode ends: moves on to the next one in the queue, if any. */
export function playNext() {
  const { queue } = useLibrary.getState();
  if (!queue.length) return;
  const [next, ...rest] = queue;
  useLibrary.setState({ queue: rest });
  useStore.getState().notify(t("接着播放：{title}", { title: next.title.slice(0, 40) }));
  start(next);
}

export const clearQueue = () => useLibrary.setState({ queue: [] });
