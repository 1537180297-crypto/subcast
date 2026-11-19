"""Prototype: the same first lines read by each engine, for a quick voice comparison.

    python -I voices.py <out-dir> <name> <n-lines> <manifest.json> [<manifest.json> ...]

Writes <name>-voice-<engine>.m4a (natural speed, 0.5 s between lines) and prints chars/second per engine.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

RATE = 24000


def main():
    out, name, n = Path(sys.argv[1]), sys.argv[2], int(sys.argv[3])
    for manifest in sys.argv[4:]:
        m = json.loads(Path(manifest).read_text())
        lines = m["lines"][:n]
        parts = []
        for l in lines:
            x, _ = sf.read(l["clip"], dtype="float32")
            parts += [x, np.zeros(int(0.5 * RATE), dtype=np.float32)]
        x = np.concatenate(parts)
        x = x / max(1e-4, float(np.sqrt(np.mean(np.square(x))))) * 0.08  # same loudness for every engine
        x = np.clip(x, -0.99, 0.99)
        wav = out / f"{name}-voice-{m['engine']}.wav"
        sf.write(wav, x, RATE, subtype="PCM_16")
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(wav), "-c:a", "aac", "-b:a", "96k",
                        str(wav.with_suffix(".m4a"))], check=True)
        wav.unlink()
        chars = sum(len(l["text"]) for l in lines)
        print(f"{m['engine']}\t{m['voice']}\t{chars / sum(l['dur'] for l in lines):.2f} chars/s")


if __name__ == "__main__":
    main()
