// WYSIWYG Canvas renderer for video clip static overlays (hook title + attribution) and timed bilingual subtitle bands.
import type { Segment } from "./api";
import { t } from "./i18n";
import { buildCues, type Cue, type SubContent } from "./subexport";

export type ClipLayout = "landscape" | "portrait_card" | "portrait_fill";
export type CardBg = "blur" | "night" | "paper";
export type SubStyleId = "cinema" | "amber" | "pill";

export interface ClipVisualConfig {
  layout: ClipLayout;
  cardBg: CardBg;
  subStyle: SubStyleId;
  subLang: SubContent;
  showTitle: boolean;
  title: string;
  showSource: boolean;
  showName: string;
  episodeTitle: string;
  liftForBurnedSub: boolean;
}

export interface RenderedCueBand {
  canvas: HTMLCanvasElement;
  y: number;
}

const SANS = '-apple-system, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", sans-serif';
const SERIF = '"Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", Georgia, serif';
const NO_START = /^[，。、：；！？）」』》”’,.;:!?)\]…—]/;

export function canvasDimensions(layout: ClipLayout): { width: number; height: number } {
  return layout === "landscape" ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
}

/** Builds normalized, flicker-free subtitle cues relative to `clipStart` (0-based). */
export function buildClipCues(
  segments: Segment[],
  zhOverrides: (string | null | undefined)[],
  startIdx: number,
  endIdx: number,
  clipStart: number,
  clipEnd: number,
  content: SubContent,
): Cue[] {
  const segSlice = segments.slice(startIdx, endIdx + 1);
  const zhSlice = zhOverrides.slice(startIdx, endIdx + 1);
  const raw = buildCues(segSlice, zhSlice, content);
  const dur = Math.max(0.5, clipEnd - clipStart);
  const out: Cue[] = [];

  for (const c of raw) {
    const start = Math.max(0, c.start - clipStart);
    const end = Math.min(dur, c.end - clipStart);
    const orig = c.orig.trim();
    const zh = c.zh?.trim();
    if (end - start < 0.08 || (!orig && !zh)) continue;
    const prev = out[out.length - 1];
    if (prev) {
      if (prev.end > start) prev.end = Math.max(prev.start + 0.08, start);
      else if (start - prev.end < 0.08) prev.end = start;
    }
    out.push({ start, end, orig, zh });
  }
  return out;
}

function wrapText(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const toks = clean.match(/[A-Za-z0-9'’\-.,;:!?%$]+\s*|\s+|./gu) || [];
  const lines: string[] = [];
  let line = "";
  for (const tok of toks) {
    if (!line && /^\s+$/.test(tok)) continue;
    const test = line + tok;
    if (g.measureText(test.trimEnd()).width > maxW && line) {
      if (NO_START.test(tok) && line.length > 1) {
        lines.push(line.slice(0, -1).trimEnd());
        line = line.slice(-1) + tok;
      } else {
        lines.push(line.trimEnd());
        line = /^\s+$/.test(tok) ? "" : tok;
      }
      if (lines.length === maxLines) break;
    } else {
      line = test;
    }
  }
  if (lines.length < maxLines && line.trim()) lines.push(line.trimEnd());
  const used = lines.join("").replace(/\s/g, "").length;
  if (used < clean.replace(/\s/g, "").length - 1 && lines.length) {
    let last = lines[lines.length - 1];
    while (last.length > 1 && g.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

function roundRectPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

/** Renders the static title & attribution transparent overlay canvas, or null when both are off. */
export function renderStaticOverlay(config: ClipVisualConfig): HTMLCanvasElement | null {
  const hasTitle = config.showTitle && !!config.title.trim();
  const hasSource = config.showSource && !!(config.showName.trim() || config.episodeTitle.trim());
  if (!hasTitle && !hasSource) return null;

  const { width: W, height: H } = canvasDimensions(config.layout);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const isPaper = config.layout === "portrait_card" && config.cardBg === "paper";
  const ink = isPaper ? "#18181b" : "#ffffff";
  const subInk = isPaper ? "rgba(24,24,27,0.62)" : "rgba(255,255,255,0.72)";
  const accent = isPaper ? "#c2410c" : "#ff8a50";

  if (config.layout === "portrait_card") {
    if (hasTitle) {
      const padX = 88;
      const maxW = W - padX * 2;
      const titleText = config.title.trim();
      const size = titleText.length > 18 ? 50 : 58;
      g.font = `700 ${size}px ${SANS}`;
      const lines = wrapText(g, titleText, maxW, 2);
      const lineH = Math.round(size * 1.32);
      const blockH = lines.length * lineH;
      const bottomAnchor = 492;
      const firstLineY = bottomAnchor - blockH + size * 0.85;

      if (config.showName.trim()) {
        g.font = `600 24px ${SANS}`;
        const kicker = `✦  ${config.showName.trim()}`;
        const kw = g.measureText(kicker).width;
        g.fillStyle = accent;
        g.fillText(kicker, (W - kw) / 2, firstLineY - lineH * 0.85 - 24);
      }

      g.font = `700 ${size}px ${SANS}`;
      g.fillStyle = ink;
      if (!isPaper) {
        g.shadowColor = "rgba(0,0,0,0.45)";
        g.shadowBlur = 16;
        g.shadowOffsetY = 3;
      }
      lines.forEach((ln, idx) => {
        const w = g.measureText(ln).width;
        g.fillText(ln, (W - w) / 2, firstLineY + idx * lineH);
      });
      g.shadowColor = "transparent";
      g.shadowBlur = 0;
      g.shadowOffsetY = 0;
    }

    if (hasSource) {
      const ruleW = 120;
      const yBase = 1742;
      g.fillStyle = isPaper ? "rgba(24,24,27,0.14)" : "rgba(255,255,255,0.18)";
      g.fillRect((W - ruleW) / 2, yBase - 48, ruleW, 2);

      const src = [config.showName.trim(), config.episodeTitle.trim()].filter(Boolean).join(" · ");
      g.font = `500 24px ${SANS}`;
      const clipped = wrapText(g, src, W - 180, 1)[0] ?? "";
      if (clipped) {
        g.fillStyle = subInk;
        const sw = g.measureText(clipped).width;
        g.fillText(clipped, (W - sw) / 2, yBase);
      }
      g.font = `500 21px ${SERIF}`;
      const brand = `SubCast · ${t("双语播客切片")}`;
      const bw = g.measureText(brand).width;
      g.fillStyle = isPaper ? "rgba(24,24,27,0.45)" : "rgba(255,255,255,0.46)";
      g.fillText(brand, (W - bw) / 2, yBase + 42);
    }
    return c;
  }

  if (config.layout === "portrait_fill") {
    if (hasTitle) {
      const grad = g.createLinearGradient(0, 0, 0, 440);
      grad.addColorStop(0, "rgba(0,0,0,0.58)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, W, 440);

      const maxW = W - 144;
      const titleText = config.title.trim();
      const size = titleText.length > 18 ? 48 : 54;
      g.font = `700 ${size}px ${SANS}`;
      const lines = wrapText(g, titleText, maxW, 2);
      const lineH = Math.round(size * 1.32);

      if (config.showName.trim()) {
        g.font = `600 23px ${SANS}`;
        const kicker = config.showName.trim();
        const kw = g.measureText(kicker).width;
        g.fillStyle = "rgba(255,216,102,0.94)";
        g.shadowColor = "rgba(0,0,0,0.6)";
        g.shadowBlur = 10;
        g.fillText(kicker, (W - kw) / 2, 184);
      }

      g.font = `700 ${size}px ${SANS}`;
      g.fillStyle = "#ffffff";
      g.shadowColor = "rgba(0,0,0,0.72)";
      g.shadowBlur = 18;
      g.shadowOffsetY = 3;
      lines.forEach((ln, idx) => {
        const w = g.measureText(ln).width;
        g.fillText(ln, (W - w) / 2, 248 + idx * lineH);
      });
      g.shadowColor = "transparent";
      g.shadowBlur = 0;
      g.shadowOffsetY = 0;
    }

    if (hasSource) {
      const src = [config.showName.trim(), "SubCast"].filter(Boolean).join(" · ");
      g.font = `500 22px ${SANS}`;
      g.fillStyle = "rgba(255,255,255,0.68)";
      g.shadowColor = "rgba(0,0,0,0.7)";
      g.shadowBlur = 8;
      const sw = g.measureText(src).width;
      g.fillText(src, (W - sw) / 2, H - 96);
    }
    return c;
  }

  // landscape (1920 x 1080)
  if (hasTitle) {
    g.font = `600 28px ${SANS}`;
    const label = wrapText(g, config.title.trim(), 920, 1)[0] ?? "";
    if (label) {
      const tw = g.measureText(label).width;
      const px = 22;
      const boxW = tw + px * 2;
      const boxH = 54;
      g.fillStyle = "rgba(16,16,18,0.64)";
      roundRectPath(g, 56, 44, boxW, boxH, 14);
      g.fill();
      g.fillStyle = "#ffffff";
      g.fillText(label, 56 + px, 44 + 36);
    }
  }
  if (hasSource) {
    const src = [config.showName.trim(), "SubCast"].filter(Boolean).join(" · ");
    g.font = `500 22px ${SANS}`;
    const sw = g.measureText(src).width;
    g.fillStyle = "rgba(16,16,18,0.52)";
    roundRectPath(g, W - 56 - sw - 28, 48, sw + 28, 42, 12);
    g.fill();
    g.fillStyle = "rgba(255,255,255,0.88)";
    g.fillText(src, W - 56 - sw - 14, 76);
  }
  return c;
}

/** Renders a compact transparent horizontal band for one timed bilingual cue, plus its Y offset on target frame. */
export function renderCueBand(
  cue: Pick<Cue, "orig" | "zh">,
  config: ClipVisualConfig,
): RenderedCueBand {
  const { width: W, height: H } = canvasDimensions(config.layout);
  const isPortrait = config.layout !== "landscape";
  const padX = isPortrait ? 68 : 136;
  const maxTextW = W - padX * 2;

  const zhSize = config.layout === "portrait_card" ? 50 : isPortrait ? 46 : 48;
  const origSize = config.layout === "portrait_card" ? 31 : isPortrait ? 29 : 32;
  const zhLH = Math.round(zhSize * 1.36);
  const origLH = Math.round(origSize * 1.38);

  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = `700 ${zhSize}px ${SANS}`;
  const zhLines = config.subLang !== "original" && cue.zh ? wrapText(probe, cue.zh, maxTextW - 48, 3) : [];
  probe.font = `500 ${origSize}px ${SANS}`;
  const origLines =
    config.subLang !== "translation" || !zhLines.length
      ? cue.orig
        ? wrapText(probe, cue.orig, maxTextW - 48, 3)
        : []
      : [];

  const gapBetween = zhLines.length && origLines.length ? 10 : 0;
  const textH = zhLines.length * zhLH + gapBetween + origLines.length * origLH;
  const padY = config.subStyle === "pill" ? 22 : 16;
  const bandH = Math.max(80, textH + padY * 2 + 12);

  const c = document.createElement("canvas");
  c.width = W;
  c.height = bandH;
  const g = c.getContext("2d")!;
  g.textBaseline = "alphabetic";

  // Measure widest rendered line for tight pill framing.
  let maxLineW = 0;
  g.font = `700 ${zhSize}px ${SANS}`;
  for (const ln of zhLines) maxLineW = Math.max(maxLineW, g.measureText(ln).width);
  g.font = `500 ${origSize}px ${SANS}`;
  for (const ln of origLines) maxLineW = Math.max(maxLineW, g.measureText(ln).width);

  const isPaper = config.layout === "portrait_card" && config.cardBg === "paper";
  const boxTop = Math.round((bandH - textH) / 2);

  if (config.subStyle === "pill" && maxLineW > 0) {
    const pillPadX = 32;
    const pillPadY = 18;
    const pw = Math.min(W - padX, maxLineW + pillPadX * 2);
    const ph = textH + pillPadY * 2;
    const px = (W - pw) / 2;
    const py = boxTop - pillPadY;
    g.fillStyle = isPaper ? "rgba(255,255,255,0.92)" : "rgba(16,16,20,0.80)";
    roundRectPath(g, px, py, pw, ph, 20);
    g.fill();
    if (isPaper) {
      g.strokeStyle = "rgba(24,24,27,0.12)";
      g.lineWidth = 2;
      g.stroke();
    }
  }

  const zhColor = isPaper
    ? config.subStyle === "amber"
      ? "#b45309"
      : "#18181b"
    : config.subStyle === "amber"
      ? "#ffd866"
      : "#ffffff";
  const origColor = isPaper ? "#52525b" : config.subStyle === "amber" ? "#ffffff" : "#e4e4e7";
  const needOutline = config.subStyle !== "pill" && !isPaper;

  let curY = boxTop;
  g.font = `700 ${zhSize}px ${SANS}`;
  for (const ln of zhLines) {
    const lw = g.measureText(ln).width;
    const x = (W - lw) / 2;
    const baseline = curY + zhSize * 0.9;
    if (needOutline) {
      g.lineJoin = "round";
      g.lineWidth = 7;
      g.strokeStyle = "rgba(0,0,0,0.88)";
      g.strokeText(ln, x, baseline);
    }
    g.fillStyle = zhColor;
    g.fillText(ln, x, baseline);
    curY += zhLH;
  }

  if (zhLines.length && origLines.length) curY += gapBetween;

  g.font = `500 ${origSize}px ${SANS}`;
  for (const ln of origLines) {
    const lw = g.measureText(ln).width;
    const x = (W - lw) / 2;
    const baseline = curY + origSize * 0.9;
    if (needOutline) {
      g.lineJoin = "round";
      g.lineWidth = 5;
      g.strokeStyle = "rgba(0,0,0,0.88)";
      g.strokeText(ln, x, baseline);
    }
    g.fillStyle = origColor;
    g.fillText(ln, x, baseline);
    curY += origLH;
  }

  let y = 0;
  if (config.layout === "landscape") {
    y = Math.max(40, H - bandH - (config.liftForBurnedSub ? 156 : 52));
  } else if (config.layout === "portrait_card") {
    y = 1236 + Math.max(0, Math.round((390 - bandH) / 2));
  } else {
    y = Math.max(80, H - bandH - 210);
  }
  return { canvas: c, y };
}

export function canvasToPngBase64(canvas: HTMLCanvasElement): string {
  const url = canvas.toDataURL("image/png");
  return url.replace(/^data:image\/png;base64,/, "");
}
