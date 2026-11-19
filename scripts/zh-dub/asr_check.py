"""Prototype check: how intelligible is each engine's Chinese? Recognise every clip with local SenseVoice and
compare with the text it was asked to say (character error rate, punctuation and spaces ignored).

    python -I asr_check.py <manifest.json> [<manifest.json> ...]
"""
import json
import os
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

SV = Path.home() / "Library/Application Support/qiaomu-audio/speech/models/sensevoice/7d1efa2138a65b0b"


def norm(s):
    return re.sub(r"[\W_]+", "", s.lower())


def cer(ref, hyp):
    ref, hyp = norm(ref), norm(hyp)
    d = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, d[0] = d[0], i
        for j, h in enumerate(hyp, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r != h))
    return d[-1] / max(1, len(ref))


def main():
    import sherpa_onnx as sherpa
    rec = sherpa.OfflineRecognizer.from_sense_voice(model=str(SV / "model.int8.onnx"), tokens=str(SV / "tokens.txt"),
                                                    num_threads=min(4, os.cpu_count() or 1), use_itn=True, language="zh")
    for manifest in sys.argv[1:]:
        m = json.loads(Path(manifest).read_text())
        errs, worst = [], []
        for l in m["lines"]:
            x, sr = sf.read(l["clip"], dtype="float32")
            s = rec.create_stream(); s.accept_waveform(sr, x); rec.decode_stream(s)
            hyp = re.sub(r"<\|[^|>]*\|>", "", s.result.text)
            e = cer(l["text"], hyp); errs.append(e); worst.append((e, l["i"]))
        worst.sort(reverse=True)
        print(f"{m['engine']}/{m['voice']}: CER mean {np.mean(errs):.3f}, median {np.median(errs):.3f}, "
              f"lines >15%: {sum(e > .15 for e in errs)}/{len(errs)}, worst {[(round(e, 2), i) for e, i in worst[:3]]}")


if __name__ == "__main__":
    main()
