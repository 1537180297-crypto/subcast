// Settings › 阅读与字幕 take effect as CSS variables on the root, so every subtitle (video, audio, full screen)
// and the Q&A follow one set of values. Web fonts load only when chosen.
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { POSTER_FONTS, loadCss } from "./poster";
import { t } from "./i18n";
import type { Settings } from "./settings";

export const SUB_SCALE = { s: 0.86, m: 1, l: 1.18, xl: 1.38 } as const;
/** Subtitle fonts: the system's, or the poster's open-source ones (loaded from a CDN when picked). */
export const SUB_FONTS = { system: "", serif: "serif", kai: "kai", sans: "sans" } as const;

export const SCALE_MIN = 0.7, SCALE_MAX = 2;

/** The subtitle size multiplier in use: the one picked on the video, else the size picked in settings. */
export function subScale(s: Pick<Settings, "subtitleScale" | "subtitleSize">): number {
  return s.subtitleScale ?? SUB_SCALE[s.subtitleSize ?? "m"];
}

export function setSubScale(v: number) {
  const scale = Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, v)) * 20) / 20;
  void useStore.getState().saveSettings({ subtitleScale: scale }, true);
  return scale;
}

/** ⌘= / ⌘-: one step bigger or smaller, said in a toast. */
export function stepSubScale(dir: 1 | -1) {
  const n = setSubScale(subScale(useStore.getState().settings) + dir * 0.1);
  useStore.getState().notify(t("字幕大小 {n}%", { n: Math.round(n * 100) }));
}

/** Where dragging left the video subtitles, kept within the picture. */
export function setSubLift(v: number) {
  void useStore.getState().saveSettings({ subtitleLift: Math.round(Math.min(70, Math.max(-4, v)) * 10) / 10 }, true);
}

export function useReadingSettings() {
  // Only these fields: subscribing to all settings re-rendered the whole app on any change.
  const s = useStore(useShallow((x) => ({ subtitleSize: x.settings.subtitleSize, subtitleScale: x.settings.subtitleScale, subtitleLift: x.settings.subtitleLift, subtitleFont: x.settings.subtitleFont, subtitleLook: x.settings.subtitleLook, chatSize: x.settings.chatSize, audioNextLine: x.settings.audioNextLine })));
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--sub-scale", String(subScale(s)));
    root.setProperty("--sub-lift", `${s.subtitleLift ?? 0}cqh`);
    root.setProperty("--chat-scale", s.chatSize === "l" ? "1.12" : "1");
    const f = POSTER_FONTS.find((x) => x.id === SUB_FONTS[s.subtitleFont ?? "sans"]);
    if (f?.css) void loadCss(f.css).catch(() => {});
    root.setProperty("--sub-font", f ? `${f.family}, var(--font, system-ui)` : "inherit");
    document.documentElement.dataset.subLook = s.subtitleLook ?? "outline";
    document.documentElement.dataset.nextLine = s.audioNextLine ? "on" : "off";
  }, [s.subtitleSize, s.subtitleScale, s.subtitleLift, s.subtitleFont, s.subtitleLook, s.chatSize, s.audioNextLine]);
}
