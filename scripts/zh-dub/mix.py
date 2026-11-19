"""Prototype: three ways to play a Chinese dub against the original, from a synth.py manifest.

    python -I mix.py <head.wav> <manifest.json> <out-dir> <name> [max-speed]

A  静音等待  original muted while a line is spoken; gaps (music, laughs) keep the original. When Chinese
            runs past the next line, the original holds (pauses) until it ends, so lines never drift.
B  压低等待  same timing, original ducked to -15 dB under Chinese (simultaneous-interpretation feel).
C  重排     Chinese only, one line after another, short pauses, longer where the original had a gap.

Every line first tries its natural take; if it overruns its slot, the faster native take (<= max-speed).
Writes <name>-A.m4a, -B.m4a, -C.m4a and <name>-stats.json.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

RATE = 24000
RAMP = int(0.15 * RATE)


def load(path):
    x, sr = sf.read(path, dtype="float32", always_2d=False)
    if x.ndim > 1:
        x = x.mean(axis=1)
    assert sr == RATE, (path, sr)
    return x


def loudness(x):
    return float(np.sqrt(np.mean(np.square(x)))) if len(x) else 0.0


def envelope(n, spans, low):
    """Gain 1 outside spans, `low` inside, with linear ramps."""
    g = np.ones(n, dtype=np.float32)
    for a, b in spans:
        a, b = max(0, a), min(n, b)
        if b <= a:
            continue
        g[a:b] = np.minimum(g[a:b], low)
        ra = np.linspace(1, low, RAMP, dtype=np.float32)
        lo = max(0, a - RAMP)
        g[lo:a] = np.minimum(g[lo:a], ra[RAMP - (a - lo):])
        hi = min(n, b + RAMP)
        g[b:hi] = np.minimum(g[b:hi], ra[::-1][: hi - b])
    return g


def pick(line, max_speed):
    if line["dur"] <= line["slot"] * 1.03 or "fastClip" not in line or line["speed"] > max_speed + 1e-6:
        return line["clip"], line["dur"], 1.0
    return line["fastClip"], line["fastDur"], line["speed"]


def timeline(orig, lines, max_speed, duck, voice_gain):
    """A/B: walk the original, holding it whenever the Chinese line is still speaking at the next line's start."""
    out, spans, cursor, t_out = [], [], 0, 0
    stats = []
    for k, line in enumerate(lines):
        path, dur, speed = pick(line, max_speed)
        start = int(line["start"] * RATE)
        if start > cursor:
            out.append(orig[cursor:start]); t_out += start - cursor; cursor = start
        clip = load(path) * voice_gain
        nxt = int(lines[k + 1]["start"] * RATE) if k + 1 < len(lines) else min(len(orig), int((line["start"] + line["slot"]) * RATE))
        span_orig = max(0, nxt - cursor)
        hold = max(0, len(clip) - span_orig)
        seg = orig[cursor:cursor + span_orig]
        if hold:
            # The original pauses: silence for A; for B, the ducked bed simply stops (a frozen bed sounds wrong).
            seg = np.concatenate([seg, np.zeros(hold, dtype=np.float32)])
        # Keep the original down for the whole English line too, or its tail leaks out after a short Chinese line.
        english = min(span_orig, int((line["end"] - line["start"]) * RATE))
        spans.append((t_out, t_out + max(len(clip), english)))
        bed = seg.copy()
        out.append(bed)
        stats.append({"i": line["i"], "dur": dur, "slot": line["slot"], "speed": speed, "hold": hold / RATE,
                      "natural": line["dur"]})
        cursor += span_orig; t_out += len(bed)
        out_clip_at = spans[-1][0]
        line["_at"], line["_clip"] = out_clip_at, clip
    out.append(orig[cursor:])
    bed = np.concatenate(out)
    bed *= envelope(len(bed), spans, duck)
    mix = bed.copy()
    for line in lines:
        a = line.pop("_at"); c = line.pop("_clip")
        mix[a:a + len(c)] += c[: len(mix) - a]
    return mix, stats


def retimed(lines, voice_gain):
    out = []
    for k, line in enumerate(lines):
        out.append(load(line["clip"]) * voice_gain)
        if k + 1 < len(lines):
            gap = lines[k + 1]["start"] - line["end"]
            out.append(np.zeros(int((0.7 if gap > 1.5 else 0.28) * RATE), dtype=np.float32))
    return np.concatenate(out)


def write(x, path):
    peak = float(np.max(np.abs(x))) or 1.0
    x = x / max(1.0, peak / 0.97)
    wav = path.with_suffix(".wav")
    sf.write(wav, x, RATE, subtype="PCM_16")
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(wav), "-c:a", "aac", "-b:a", "96k", str(path)], check=True)
    wav.unlink()


def main():
    head, manifest, out_dir, name = sys.argv[1:5]
    max_speed = float(sys.argv[5]) if len(sys.argv) > 5 else 1.25
    orig = load(head)
    m = json.loads(Path(manifest).read_text())
    lines = [l for l in m["lines"] if l["start"] * RATE < len(orig)]
    # Match the voice to the original's speech loudness so A/B/C compare fairly.
    speech = np.concatenate([orig[int(l["start"] * RATE):int(l["end"] * RATE)] for l in lines])
    voices = np.concatenate([load(l["clip"]) for l in lines])
    voice_gain = loudness(speech) / max(1e-4, loudness(voices))
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    a, stats = timeline(orig, [dict(l) for l in lines], max_speed, 0.0, voice_gain)
    b, _ = timeline(orig, [dict(l) for l in lines], max_speed, 10 ** (-15 / 20), voice_gain)
    c = retimed(lines, voice_gain)
    for tag, x in (("A", a), ("B", b), ("C", c)):
        write(x, out / f"{name}-{tag}.m4a")
    n = len(stats)
    fits_natural = sum(s["natural"] <= s["slot"] * 1.03 for s in stats)
    fits_fast = sum(s["dur"] <= s["slot"] * 1.03 for s in stats)
    held = [s["hold"] for s in stats if s["hold"] > 0.05]
    span = lines[-1]["start"] + lines[-1]["slot"] - lines[0]["start"]
    summary = {
        "engine": m["engine"], "voice": m["voice"], "lines": n, "maxSpeed": max_speed,
        "originalSeconds": round(len(orig) / RATE, 1),
        "fitNatural": f"{fits_natural}/{n}", "fitAfterSpeedup": f"{fits_fast}/{n}",
        "spedUp": sum(s["speed"] > 1 for s in stats),
        "holds": len(held), "holdSeconds": round(sum(held), 1), "longestHold": round(max(held, default=0), 1),
        "chineseSpeechSeconds": round(sum(l["dur"] for l in lines), 1), "originalSpanSeconds": round(span, 1),
        "A_seconds": round(len(a) / RATE, 1), "B_seconds": round(len(b) / RATE, 1), "C_seconds": round(len(c) / RATE, 1),
        "chars": sum(len(l["text"]) for l in lines),
    }
    (out / f"{name}-stats.json").write_text(json.dumps({"summary": summary, "lines": stats}, ensure_ascii=False, indent=1))
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
