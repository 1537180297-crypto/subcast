import { create } from "zustand";

/** Column widths the viewer sets by dragging. Kept in localStorage: a per-device convenience, not data. */
export const SIDEBAR = { min: 180, max: 320, def: 220, snap: 130 };
export const PANEL = { min: 340, max: 760, def: 460, snap: 260 };

/** subsOpen / curatedOpen: the sidebar's 订阅 and 乔木精读 groups, folded by their headers. subsAll: a long
 *  subscription list shown in full instead of its first SUBS_SHORT. */
interface Layout { sidebar: number; sideOpen: boolean; panel: number; panelOpen: boolean; subsOpen: boolean; curatedOpen: boolean; subsAll: boolean }
const DEFAULTS = { subsOpen: true, curatedOpen: true, subsAll: false };
const KEY = "subcast-layout";
const read = (): Layout => {
  try { return { sidebar: SIDEBAR.def, sideOpen: true, panel: PANEL.def, panelOpen: true, ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; }
  catch { return { sidebar: SIDEBAR.def, sideOpen: true, panel: PANEL.def, panelOpen: true, ...DEFAULTS }; }
};

let saveTimer = 0;
export const useLayout = create<Layout & { put: (p: Partial<Layout>) => void }>((set, get) => ({
  ...read(),
  put: (p) => {
    set(p);
    // Written once dragging pauses, not on every pointer move.
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const { sidebar, sideOpen, panel, panelOpen, subsOpen, curatedOpen, subsAll } = get();
      try { localStorage.setItem(KEY, JSON.stringify({ sidebar, sideOpen, panel, panelOpen, subsOpen, curatedOpen, subsAll })); } catch { /* private mode */ }
    }, 300);
  },
}));
