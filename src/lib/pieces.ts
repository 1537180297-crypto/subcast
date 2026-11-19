// Long subtitle blocks shown (and exported) a sentence-sized piece at a time.

/** Splits a subtitle block into reading-sized pieces: at the end of each sentence, at a comma once a piece is
 *  long enough, and between words only when a sentence runs on too long. */
export function pieces(text: string, cjk: boolean): string[] {
  const soft = cjk ? 14 : 38, hard = cjk ? 30 : 80;
  // A "." inside a number ("1.5") doesn't end anything.
  const units = cjk ? text.split(/(?<=[，。！？；：、,!?;]|\.(?!\d))/) : text.split(/(?<=\s)/);
  const out: string[] = [];
  let cur = "";
  for (let n = 0; n < units.length; n++) {
    const u = units[n];
    // A sentence only ends at "." when what follows starts a new one (a capital, a digit-free quote, CJK), so
    // "raised to 1. point five" or "e.g. this" stay together.
    const nextStart = (units[n + 1] ?? "").trimStart()[0] ?? "";
    const continues = !cjk && /\.$/.test(u.trim()) && /[a-z0-9]/.test(nextStart);
    if (cur && (cur + u).trim().length > hard) { out.push(cur.trim()); cur = ""; }
    cur += u;
    const t = cur.trim();
    // Initials and titles end in a full stop without ending the sentence ("J.P.", "Mr.", "U.S.").
    const last = u.trim();
    const abbrev = !cjk && /^(?:[A-Z]\.)+(?:[A-Z]\.?)?$|^(?:Mr|Mrs|Ms|Dr|St|vs|etc|Inc|Co|Jr|Sr|No|Vol)\.$/.test(last);
    if ((!abbrev && !continues && /[。！？.!?]["”')）]*$/.test(t)) || (t.length >= soft && /[，；：,;:]$/.test(t))) { out.push(t); cur = ""; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [text];
}

/** The piece being spoken now, assuming speech is spread evenly over the block. */
export function pieceAt(text: string, cjk: boolean, progress: number): string {
  const ps = pieces(text, cjk);
  const total = ps.reduce((n, p) => n + p.length, 0);
  let acc = 0;
  for (const p of ps) { acc += p.length; if (acc / total >= progress) return p; }
  return ps[ps.length - 1];
}
