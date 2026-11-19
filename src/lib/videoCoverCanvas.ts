// Viral cover renderer (4 templates × 9:16 / 16:9 / 3:4) with `【keyword】` highlight tokens.
import { clock } from "./format";
import { t } from "./i18n";

export type CoverTemplateId = "impact" | "magazine" | "marker" | "cinema";
export type CoverAspect = "9:16" | "16:9" | "3:4";

export interface CoverConfig {
  template: CoverTemplateId;
  aspect: CoverAspect;
  hookTitle: string;
  subTitle: string;
  kicker: string;
  showName: string;
  durationSec: number;
  backdropUrl?: string | null;
}

const SANS = '-apple-system, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", sans-serif';
const SERIF = '"Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", Georgia, serif';
const NO_START = /^[，。、：；！？）」』》”’,.;:!?)\]…—]/;

export function coverDimensions(aspect: CoverAspect): { width: number; height: number } {
  if (aspect === "16:9") return { width: 1920, height: 1080 };
  if (aspect === "3:4") return { width: 1080, height: 1440 };
  return { width: 1080, height: 1920 };
}

interface RichToken {
  text: string;
  hi: boolean;
}

/** Parses `未来三年，【会提问的人】将淘汰写代码的人` into wrapping-ready highlighted tokens. */
export function parseHighlightTokens(input: string): RichToken[] {
  const clean = input.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const tokens: RichToken[] = [];
  const re = /【([^】]+)】/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushUnits = (str: string, hi: boolean) => {
    const units = str.match(/[A-Za-z0-9'’\-.,;:!?%$]+\s*|\s+|./gu) || [];
    for (const u of units) tokens.push({ text: u, hi });
  };
  while ((m = re.exec(clean)) !== null) {
    if (m.index > last) pushUnits(clean.slice(last, m.index), false);
    pushUnits(m[1], true);
    last = re.lastIndex;
  }
  if (last < clean.length) pushUnits(clean.slice(last), false);
  return tokens;
}

function wrapRichLines(
  g: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  maxLines: number,
): RichToken[][] {
  const toks = parseHighlightTokens(text);
  if (!toks.length) return [];
  const lines: RichToken[][] = [];
  let cur: RichToken[] = [];
  let curW = 0;

  for (const tok of toks) {
    if (!cur.length && /^\s+$/.test(tok.text)) continue;
    const w = g.measureText(tok.text).width;
    if (curW + w > maxW && cur.length) {
      if (NO_START.test(tok.text) && cur.length > 1) {
        const popped = cur.pop()!;
        lines.push(cur);
        cur = [popped, tok];
        curW = g.measureText(popped.text).width + w;
      } else {
        lines.push(cur);
        cur = /^\s+$/.test(tok.text) ? [] : [tok];
        curW = cur.length ? w : 0;
      }
      if (lines.length === maxLines) {
        cur = [];
        break;
      }
    } else {
      cur.push(tok);
      curW += w;
    }
  }
  if (cur.length && lines.length < maxLines) lines.push(cur);
  // Trim trailing whitespace on each line
  return lines.map((ln) => {
    const out = [...ln];
    while (out.length && /^\s+$/.test(out[out.length - 1].text)) out.pop();
    return out;
  });
}

function wrapPlain(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  return wrapRichLines(g, text.replace(/[【】]/g, ""), maxW, maxLines).map((ln) => ln.map((t) => t.text).join(""));
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

/** Draws `img` scaled to cover `(dx, dy, dw, dh)` cleanly from the center (slightly higher on portraits for faces). */
function drawCoverImage(
  g: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  focusY = 0.42,
) {
  const sw = img.naturalWidth || 1280;
  const sh = img.naturalHeight || 720;
  const scale = Math.max(dw / sw, dh / sh);
  const rw = sw * scale;
  const rh = sh * scale;
  const ox = dx + (dw - rw) / 2;
  const oy = dy + (dh - rh) * focusY;
  g.save();
  g.beginPath();
  g.rect(dx, dy, dw, dh);
  g.clip();
  g.drawImage(img, ox, oy, rw, rh);
  g.restore();
}

function drawRichLine(
  g: CanvasRenderingContext2D,
  tokens: RichToken[],
  x: number,
  y: number,
  fontSize: number,
  baseColor: string,
  hiColor: string,
  markerBg?: string,
  markerText?: string,
) {
  let cx = x;
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].hi && markerBg) {
      let j = i;
      let run = "";
      while (j < tokens.length && tokens[j].hi) { run += tokens[j].text; j++; }
      const rw = g.measureText(run).width;
      const padX = Math.round(fontSize * 0.16);
      const padY = Math.round(fontSize * 0.10);
      g.save();
      g.shadowColor = "transparent";
      g.shadowBlur = 0;
      g.fillStyle = markerBg;
      roundRect(g, cx + 2, y - fontSize * 0.88 - padY * 0.3, rw + padX * 2 - 4, fontSize * 1.14 + padY, 14);
      g.fill();
      g.fillStyle = markerText ?? "#141416";
      g.fillText(run, cx + padX, y);
      g.restore();
      cx += rw + padX * 2;
      i = j;
    } else {
      const tok = tokens[i];
      g.fillStyle = tok.hi ? hiColor : baseColor;
      g.fillText(tok.text, cx, y);
      cx += g.measureText(tok.text).width;
      i++;
    }
  }
}

function measureRichLine(g: CanvasRenderingContext2D, tokens: RichToken[], fontSize: number, hasMarkerBg: boolean): number {
  let w = 0;
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].hi && hasMarkerBg) {
      let run = "";
      while (i < tokens.length && tokens[i].hi) { run += tokens[i].text; i++; }
      w += g.measureText(run).width + Math.round(fontSize * 0.16) * 2;
    } else {
      w += g.measureText(tokens[i].text).width;
      i++;
    }
  }
  return w;
}

async function loadImageSafe(url?: string | null): Promise<HTMLImageElement | null> {
  if (!url) return null;
  return new Promise((resolve) => {
    const img = new Image();
    if (!url.startsWith("data:") && !url.startsWith("blob:")) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function drawFallbackBackdrop(g: CanvasRenderingContext2D, W: number, H: number) {
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#1c1b20");
  grad.addColorStop(0.55, "#131317");
  grad.addColorStop(1, "#0b0b0e");
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  const glow = g.createRadialGradient(W * 0.25, H * 0.25, 20, W * 0.25, H * 0.25, W * 0.7);
  glow.addColorStop(0, "rgba(232, 88, 42, 0.16)");
  glow.addColorStop(1, "rgba(232, 88, 42, 0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);
}

/** Renders a share-ready viral cover canvas for the configured template and aspect ratio. */
export async function renderCoverCanvas(config: CoverConfig): Promise<HTMLCanvasElement> {
  const { width: W, height: H } = coverDimensions(config.aspect);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const img = await loadImageSafe(config.backdropUrl);
  const isLand = config.aspect === "16:9";
  const durText = `▶ ${clock(config.durationSec)}`;
  const kickerText = (config.kicker || config.showName || t("播客高光切片")).trim();
  const titleText = (config.hookTitle || t("精彩片段")).trim();
  const subText = config.subTitle.trim();

  if (config.template === "magazine") {
    // Editorial Magazine: crisp top still + clean warm paper card bottom
    const photoH = isLand ? Math.round(H * 0.56) : Math.round(H * 0.50);
    g.fillStyle = "#faf7f2";
    g.fillRect(0, 0, W, H);
    if (img) drawCoverImage(g, img, 0, 0, W, photoH, 0.36);
    else drawFallbackBackdrop(g, W, photoH);

    // Subtle dark top pill for duration + SubCast mark
    g.font = `600 ${isLand ? 24 : 26}px ${SANS}`;
    const dw = g.measureText(durText).width + 32;
    g.fillStyle = "rgba(18, 18, 22, 0.72)";
    roundRect(g, W - 56 - dw, 48, dw, 46, 23);
    g.fill();
    g.fillStyle = "#ffffff";
    g.fillText(durText, W - 56 - dw + 16, 48 + 31);

    // Soft transition edge
    const fade = g.createLinearGradient(0, photoH - 80, 0, photoH);
    fade.addColorStop(0, "rgba(250,247,242,0)");
    fade.addColorStop(1, "#faf7f2");
    g.fillStyle = fade;
    g.fillRect(0, photoH - 80, W, 80);

    const padX = isLand ? 120 : 84;
    const maxW = W - padX * 2;
    let y = photoH + (isLand ? 58 : 74);

    // Kicker badge (no vertical side bar!)
    g.font = `700 ${isLand ? 24 : 28}px ${SANS}`;
    g.fillStyle = "#d9481a";
    g.fillText(kickerText.toUpperCase(), padX, y);
    y += isLand ? 34 : 44;

    const titleSize = isLand ? (titleText.length > 20 ? 58 : 68) : (titleText.length > 20 ? 64 : 76);
    g.font = `800 ${titleSize}px ${SANS}`;
    const lines = wrapRichLines(g, titleText, maxW, isLand ? 2 : 3);
    const lineH = Math.round(titleSize * 1.26);
    lines.forEach((ln) => {
      y += lineH;
      drawRichLine(g, ln, padX, y - lineH * 0.16, titleSize, "#18181b", "#d9481a");
    });

    if (subText) {
      y += isLand ? 24 : 34;
      const subSize = isLand ? 30 : 34;
      g.font = `500 ${subSize}px ${SANS}`;
      g.fillStyle = "#57534e";
      wrapPlain(g, subText, maxW, 2).forEach((ln) => {
        y += Math.round(subSize * 1.4);
        g.fillText(ln, padX, y - subSize * 0.25);
      });
    }

    // Bottom footer rule & SubCast attribution
    const fy = H - (isLand ? 48 : 68);
    g.fillStyle = "#e6e0d6";
    g.fillRect(padX, fy - 48, maxW, 2);
    g.font = `600 ${isLand ? 22 : 25}px ${SERIF}`;
    g.fillStyle = "#78716c";
    const footLeft = [config.showName, "SubCast"].filter(Boolean).join(" · ");
    g.fillText(footLeft, padX, fy);
    return c;
  }

  if (config.template === "cinema") {
    // Cinema Poster: dark letterbox frame, centered sharp still, editorial gold highlight below
    g.fillStyle = "#141315";
    g.fillRect(0, 0, W, H);
    const padX = isLand ? 120 : 72;
    const frameW = W - padX * 2;
    const frameTop = isLand ? 92 : Math.round(H * 0.14);
    const frameH = isLand ? Math.round(H * 0.50) : Math.round(frameW * 9 / 16);

    // Top masthead
    g.font = `600 ${isLand ? 22 : 25}px ${SANS}`;
    g.fillStyle = "rgba(255,255,255,0.68)";
    g.fillText(kickerText, padX, frameTop - 26);
    const dw = g.measureText(durText).width;
    g.fillStyle = "#f59e0b";
    g.fillText(durText, W - padX - dw, frameTop - 26);

    if (img) drawCoverImage(g, img, padX, frameTop, frameW, frameH, 0.42);
    else drawFallbackBackdrop(g, frameW, frameH);
    g.strokeStyle = "rgba(255,255,255,0.12)";
    g.lineWidth = 2;
    g.strokeRect(padX, frameTop, frameW, frameH);

    let y = frameTop + frameH + (isLand ? 42 : 76);
    const titleSize = isLand ? (titleText.length > 20 ? 52 : 60) : (titleText.length > 20 ? 60 : 70);
    g.font = `700 ${titleSize}px ${SERIF}`;
    const lines = wrapRichLines(g, titleText, frameW, isLand ? 2 : 3);
    const lineH = Math.round(titleSize * 1.32);
    lines.forEach((ln) => {
      y += lineH;
      const lw = measureRichLine(g, ln, titleSize, false);
      drawRichLine(g, ln, (W - lw) / 2, y - lineH * 0.16, titleSize, "#f5f2eb", "#fbbf24");
    });

    if (subText) {
      y += isLand ? 16 : 28;
      const subSize = isLand ? 26 : 32;
      g.font = `400 ${subSize}px ${SANS}`;
      g.fillStyle = "rgba(245,242,235,0.72)";
      wrapPlain(g, subText, frameW, 2).forEach((ln) => {
        y += Math.round(subSize * 1.45);
        const lw = g.measureText(ln).width;
        g.fillText(ln, (W - lw) / 2, y - subSize * 0.25);
      });
    }

    g.font = `500 ${isLand ? 20 : 23}px ${SANS}`;
    const brand = [config.showName, "SubCast · " + t("双语播客切片")].filter(Boolean).join(" · ");
    const bw = g.measureText(brand).width;
    g.fillStyle = "rgba(255,255,255,0.42)";
    g.fillText(brand, (W - bw) / 2, H - (isLand ? 36 : 72));
    return c;
  }

  // `impact` or `marker`: full-bleed still + dramatic gradient scrim + big centered/anchored headline
  if (img) drawCoverImage(g, img, 0, 0, W, H, 0.38);
  else drawFallbackBackdrop(g, W, H);

  const isMarker = config.template === "marker";
  const scrim = g.createLinearGradient(0, 0, 0, H);
  scrim.addColorStop(0, "rgba(10,10,14,0.62)");
  scrim.addColorStop(0.32, isMarker ? "rgba(10,10,14,0.34)" : "rgba(10,10,14,0.16)");
  scrim.addColorStop(0.62, isMarker ? "rgba(10,10,14,0.58)" : "rgba(10,10,14,0.72)");
  scrim.addColorStop(1, "rgba(10,10,14,0.94)");
  g.fillStyle = scrim;
  g.fillRect(0, 0, W, H);

  const padX = isLand ? 130 : 78;
  const maxW = W - padX * 2;

  // Top bar: kicker pill on left + duration pill on right
  const topY = isLand ? 52 : 76;
  g.font = `600 ${isLand ? 24 : 26}px ${SANS}`;
  if (kickerText) {
    const kw = Math.min(maxW - 180, g.measureText(kickerText).width);
    g.fillStyle = "rgba(20,20,24,0.72)";
    roundRect(g, padX, topY, kw + 36, 48, 24);
    g.fill();
    g.strokeStyle = "rgba(255,255,255,0.18)";
    g.lineWidth = 1.5;
    g.stroke();
    g.fillStyle = "#ffd866";
    g.fillText(kickerText, padX + 18, topY + 32, kw);
  }
  const dw = g.measureText(durText).width + 32;
  g.fillStyle = "rgba(20,20,24,0.72)";
  roundRect(g, W - padX - dw, topY, dw, 48, 24);
  g.fill();
  g.fillStyle = "#ffffff";
  g.fillText(durText, W - padX - dw + 16, topY + 32);

  // Main title + subtitle anchored in lower third (impact) or slightly higher visual center (marker)
  const titleSize = isLand ? (titleText.length > 20 ? 64 : 74) : (titleText.length > 18 ? 68 : 78);
  g.font = `800 ${titleSize}px ${SANS}`;
  const lines = wrapRichLines(g, titleText, maxW, isLand ? 2 : 3);
  const lineH = Math.round(titleSize * 1.30);

  const subSize = isLand ? 30 : 34;
  g.font = `500 ${subSize}px ${SANS}`;
  const subLines = subText ? wrapPlain(g, subText, maxW, 2) : [];
  const subH = subLines.length ? Math.round(subSize * 1.45) * subLines.length + 24 : 0;

  const blockH = lines.length * lineH + subH;
  const anchorBottom = H - (isLand ? 112 : isMarker ? 280 : 190);
  let y = anchorBottom - blockH;

  g.font = `800 ${titleSize}px ${SANS}`;
  g.shadowColor = "rgba(0,0,0,0.65)";
  g.shadowBlur = 22;
  g.shadowOffsetY = 4;
  lines.forEach((ln) => {
    y += lineH;
    const lw = measureRichLine(g, ln, titleSize, isMarker);
    const x = (W - lw) / 2;
    drawRichLine(
      g,
      ln,
      x,
      y - lineH * 0.16,
      titleSize,
      "#ffffff",
      "#ffd866",
      isMarker ? "#facc15" : undefined,
      isMarker ? "#141416" : undefined,
    );
  });

  if (subLines.length) {
    y += 20;
    g.font = `500 ${subSize}px ${SANS}`;
    g.fillStyle = "rgba(255,255,255,0.84)";
    subLines.forEach((ln) => {
      y += Math.round(subSize * 1.42);
      const lw = g.measureText(ln).width;
      g.fillText(ln, (W - lw) / 2, y - subSize * 0.2);
    });
  }

  g.shadowColor = "transparent";
  g.shadowBlur = 0;
  g.shadowOffsetY = 0;

  // Footer micro-attribution
  g.font = `500 ${isLand ? 21 : 24}px ${SANS}`;
  const foot = [config.showName, "SubCast · " + t("双语字幕")].filter(Boolean).join(" · ");
  const fw = g.measureText(foot).width;
  g.fillStyle = "rgba(255,255,255,0.58)";
  g.fillText(foot, (W - fw) / 2, H - (isLand ? 44 : 78));

  return c;
}
