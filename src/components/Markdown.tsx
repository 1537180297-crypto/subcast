import { Fragment, type ReactNode } from "react";
import { parseClock } from "../lib/format";

// A small Markdown renderer for model answers: headings, lists, bold, inline code, and [mm:ss] timestamps that seek.
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[\d{1,2}:\d{2}(?::\d{2})?\](?:\s*[-–~至]\s*\[\d{1,2}:\d{2}(?::\d{2})?\])?)/g;

function inline(text: string, onSeek: (t: number) => void, key: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const k = `${key}-${i}`;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={k}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={k}>{part.slice(1, -1)}</code>;
    const stamp = part.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]/);
    if (stamp) {
      const seconds = parseClock(stamp[1]);
      return seconds == null ? part : (
        <button key={k} className="stamp" onClick={() => onSeek(seconds)} title="跳到这里播放">{stamp[1]}</button>
      );
    }
    return <Fragment key={k}>{part}</Fragment>;
  });
}

export function Markdown({ text, onSeek }: { text: string; onSeek: (t: number) => void }) {
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  let ordered = false;
  const flush = () => {
    if (list.length) blocks.push(ordered ? <ol key={`l${blocks.length}`}>{list}</ol> : <ul key={`l${blocks.length}`}>{list}</ul>);
    list = [];
  };
  text.split("\n").forEach((raw, i) => {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*(?:[-*•]|(\d+)[.)、])\s+(.*)$/);
    if (bullet) {
      const isOrdered = Boolean(bullet[1]);
      if (list.length && isOrdered !== ordered) flush();
      ordered = isOrdered;
      list.push(<li key={i}>{inline(bullet[2], onSeek, `b${i}`)}</li>);
      return;
    }
    flush();
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) blocks.push(heading[1].length <= 2 ? <h3 key={i}>{inline(heading[2], onSeek, `h${i}`)}</h3> : <h4 key={i}>{inline(heading[2], onSeek, `h${i}`)}</h4>);
    else if (line.trim() === "---") blocks.push(<hr key={i} />);
    else if (line.trim()) blocks.push(<p key={i}>{inline(line, onSeek, `p${i}`)}</p>);
  });
  flush();
  return <div className="markdown">{blocks}</div>;
}
