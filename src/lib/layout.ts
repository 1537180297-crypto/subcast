import { create } from "zustand";

/** Column widths the viewer sets by dragging. Kept in localStorage: a per-device convenience, not data. */
export const SIDEBAR = { min: 180, max: 320, def: 220, snap: 130 };
export const PANEL = { min: 340, max: 760, def: 460, snap: 260 };

/** transcriptBelow: the 字幕 list sits under the player instead of in the right column (精读/导读/问答 stay there). */
interface Layout { sidebar: number; sideOpen: boolean; panel: number; panelOpen: boolean; transcriptBelow: boolean }
const KEY = "subcast-layout";
const read = (): Layout => {
  try { return { sidebar: SIDEBAR.def, sideOpen: true, panel: PANEL.def, panelOpen: true, transcriptBelow: false, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; }
  catch { return { sidebar: SIDEBAR.def, sideOpen: true, panel: PANEL.def, panelOpen: true, transcriptBelow: false }; }
};

let saveTimer = 0;
export const useLayout = create<Layout & { put: (p: Partial<Layout>) => void }>((set, get) => ({
  ...read(),
  put: (p) => {
    set(p);
    // Written once dragging pauses, not on every pointer move.
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const { sidebar, sideOpen, panel, panelOpen, transcriptBelow } = get();
      try { localStorage.setItem(KEY, JSON.stringify({ sidebar, sideOpen, panel, panelOpen, transcriptBelow })); } catch { /* private mode */ }
    }, 300);
  },
}));
