// Quote posters, after elon.qiaomu.ai's kit.js: a 1080px-wide canvas with the quote (Chinese first, original
// below), where it came from, and a QR code back to the episode.
import qrcode from "qrcode-generator";
import { t } from "./i18n";

const SERIF = '"Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", serif';
const LATIN = 'Georgia, "Times New Roman", serif';
const SANS = '-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const NO_START = /^[，。、：；！？）」』》”’,.;:!?)\]…—]/;
export const CJK = /[一-鿿]/;

export interface PosterInput { zh: string; en: string; title: string; show: string; meta: string; url?: string }

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const toks = text.match(/[A-Za-z0-9'’\-.,;:!?%$]+\s*|\s+|./gu) || [];
  const lines: string[] = [];
  let line = "";
  for (const t of toks) {
    if (!line && /^\s+$/.test(t)) continue;
    const test = line + t;
    if (g.measureText(test.trimEnd()).width > maxW && line) {
      if (NO_START.test(t) && line.length > 1) { lines.push(line.slice(0, -1).trimEnd()); line = line.slice(-1) + t; }
      else { lines.push(line.trimEnd()); line = /^\s+$/.test(t) ? "" : t; }
      if (lines.length === maxLines) break;
    } else line = test;
  }
  if (lines.length < maxLines && line.trim()) lines.push(line.trimEnd());
  const used = lines.join("").replace(/\s/g, "").length;
  if (used < text.replace(/\s/g, "").length - 1 && lines.length) {
    let last = lines[lines.length - 1];
    while (last.length && g.measureText(last + "……").width > maxW) last = last.slice(0, -1);
    lines[lines.length - 1] = last + "……";
  }
  return lines;
}

export async function drawPoster(o: PosterInput, logo?: HTMLImageElement): Promise<HTMLCanvasElement> {
  const W = 1080, P = 92, CW = W - P * 2;
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  const zh = o.zh, en = o.en && o.en !== zh ? o.en : "";
  g.font = `500 ${zh.length > 120 ? 42 : 50}px ${SERIF}`;
  const zhFont = g.font, zhLines = zh ? wrap(g, zh, CW, 13) : [], zhLH = zh.length > 120 ? 74 : 86;
  g.font = `italic ${zh ? 30 : 46}px ${LATIN}`;
  const enFont = g.font, enLines = en ? wrap(g, en, CW, zh ? 7 : 14) : [], enLH = zh ? 46 : 70;
  g.font = `400 28px ${SERIF}`;
  const srcFont = g.font, srcLines = o.title ? wrap(g, o.title, CW, 2) : [];
  const markY = 324;
  let h = markY - 58 + zhLines.length * zhLH + (zhLines.length && enLines.length ? 34 : 0) + enLines.length * enLH;
  h += 70 + 44 + srcLines.length * 42 + 60 + 290 + P;
  c.width = W; c.height = Math.max(h, 1080);
  g.fillStyle = "#faf9f6"; g.fillRect(0, 0, W, c.height);
  // masthead
  if (logo) g.drawImage(logo, P, 76, 44, 44);
  g.fillStyle = "#16171a"; g.font = `700 32px ${SANS}`; g.textBaseline = "alphabetic";
  g.fillText("SubCast", P + (logo ? 56 : 0), 110);
  g.font = `400 22px ${SANS}`; g.fillStyle = "#6b6e76";
  const kick = o.show || t("播客摘句");
  g.fillText(kick, W - P - g.measureText(kick).width, 108);
  g.fillStyle = "#16171a"; g.fillRect(P, 140, CW, 3); g.fillRect(P, 148, CW, 1);
  // quote mark in the brand orange
  g.fillStyle = "#e8582a"; g.font = `700 150px ${LATIN}`; g.fillText("“", P - 8, markY);
  let y = markY - 58;
  g.fillStyle = "#16171a"; g.font = zhFont;
  zhLines.forEach((ln) => { y += zhLH; g.fillText(ln, P, y - 18); });
  if (zhLines.length && enLines.length) y += 34;
  g.fillStyle = zh ? "#55585f" : "#16171a"; g.font = enFont;
  enLines.forEach((ln) => { y += enLH; g.fillText(ln, P, y - 14); });
  // source
  y += 70;
  g.fillStyle = "#16171a"; g.font = `600 30px ${SERIF}`;
  g.fillText(`—— ${o.show || t("播客")}`, P, y);
  y += 44; g.fillStyle = "#55585f"; g.font = srcFont;
  srcLines.forEach((ln) => { g.fillText(ln, P, y); y += 42; });
  if (o.meta) { g.font = `400 24px ${SANS}`; g.fillStyle = "#8b8f98"; g.fillText(o.meta, P, y); }
  // footer + QR
  const fy = c.height - P - 220;
  g.fillStyle = "#dcdde2"; g.fillRect(P, fy - 30, CW, 1);
  g.fillStyle = "#16171a"; g.font = `700 38px ${SANS}`; g.fillText("SubCast", P, fy + 52);
  g.font = `400 26px ${SANS}`; g.fillStyle = "#55585f"; g.fillText(t("海外好播客 · 中文字幕 · 精读与 AI 问答"), P, fy + 104);
  g.fillStyle = "#3a6df0"; g.font = `600 26px ${SANS}`; g.fillText(t("扫码收听原节目这一段"), P, fy + 152);
  if (o.url) {
    try {
      const qr = qrcode(0, "M"); qr.addData(o.url); qr.make();
      const n = qr.getModuleCount(), S = 220, q = 10, cell = (S - q * 2) / n, qx = W - P - S, qy = fy - 4;
      g.fillStyle = "#fff"; g.fillRect(qx, qy, S, S); g.fillStyle = "#16171a";
      for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) g.fillRect(qx + q + k * cell, qy + q + r * cell, Math.ceil(cell), Math.ceil(cell));
    } catch { /* URL only */ }
  }
  return c;
}
