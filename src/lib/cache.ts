// Lightweight in-memory SWR cache and scroll restoration across page switches.
import { api, type Episode } from "./api";

const MAX_BY_ID = 2000;

let homeCache: Episode[] | null = null;
let recentCache: Episode[] | null = null;
const showCache = new Map<string, Episode[]>();
const byId = new Map<string, Episode>();
const scrollPos = new Map<string, number>();

/** Stores episodes in the bounded by-id lookup cache so list views avoid N+1 getEpisode IPC calls. */
export function rememberEpisodes(list: Episode[]) {
  for (const ep of list) {
    if (byId.has(ep.id)) byId.delete(ep.id);
    byId.set(ep.id, ep);
  }
  while (byId.size > MAX_BY_ID) {
    const oldest = byId.keys().next().value;
    if (oldest === undefined) break;
    byId.delete(oldest);
  }
}

/** Reads a cached episode by id if available. */
export function getCachedEpisode(id: string): Episode | undefined {
  return byId.get(id);
}

/** Updates cached playback progress across cached lists so back navigation reflects recent listening immediately. */
export function updateCachedProgress(id: string, progress: number) {
  const cur = byId.get(id);
  if (cur && Math.abs(cur.progress - progress) > 1) byId.set(id, { ...cur, progress });
  const patch = (list: Episode[] | null) =>
    list?.map((e) => (e.id === id && Math.abs(e.progress - progress) > 1 ? { ...e, progress } : e)) ?? null;
  homeCache = patch(homeCache);
  recentCache = patch(recentCache);
  for (const [k, list] of showCache) {
    const next = patch(list);
    if (next) showCache.set(k, next);
  }
}

/** Returns cached home episodes for instant initial render. */
export function getHomeEpisodes(): Episode[] | null {
  return homeCache;
}

/** Saves latest home episodes and warms the by-id map. */
export function setHomeEpisodes(list: Episode[]) {
  homeCache = list;
  rememberEpisodes(list);
}

/** Returns cached recent episodes for instant initial render. */
export function getRecentEpisodes(): Episode[] | null {
  return recentCache;
}

/** Saves latest recent episodes and warms the by-id map. */
export function setRecentEpisodes(list: Episode[]) {
  recentCache = list;
  rememberEpisodes(list);
}

/** Returns cached episodes for a show page if present. */
export function getShowEpisodes(showId: string): Episode[] | null {
  return showCache.get(showId) ?? null;
}

/** Saves episodes for a show page and warms the by-id map. */
export function setShowEpisodes(showId: string, list: Episode[]) {
  showCache.set(showId, list);
  rememberEpisodes(list);
}

/** Clears cached episode lists (all or for a specific show) after subscription/refresh mutations. */
export function invalidateEpisodes(showId?: string) {
  if (showId) {
    showCache.delete(showId);
  } else {
    showCache.clear();
  }
  homeCache = null;
  recentCache = null;
}

/** Resolves episodes by id using memory cache first, fetching only missing ids from Rust in parallel. */
export async function getEpisodesCached(ids: string[]): Promise<Episode[]> {
  if (!ids.length) return [];
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    const fetched = await Promise.all(missing.map((id) => api.getEpisode(id).catch(() => null)));
    rememberEpisodes(fetched.filter((x): x is Episode => !!x));
  }
  return ids.map((id) => byId.get(id)).filter((x): x is Episode => !!x);
}

/** Saves a page's vertical scroll offset for restoration when navigating back. */
export function saveScroll(key: string, top: number) {
  scrollPos.set(key, Math.max(0, top));
}

/** Reads the previously saved scroll offset for a page key (0 if none). */
export function readScroll(key: string): number {
  return scrollPos.get(key) ?? 0;
}
