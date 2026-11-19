"""Prototype: synthesise one Chinese clip per subtitle line, cached by sha256(engine|voice|speed|text).

Run with a Python that has sherpa_onnx, numpy and soundfile (qiaomu-audio's local runtime has them):
    python -I synth.py <episode.json> <until-seconds> <engine> <voice> <cache-dir> <out-manifest.json>

engine: kokoro | melo | say  (cloud engines are tried from the app, not here)
The manifest lists, per line: index, start, end, slot, text, clip path, natural duration.
`fit(...)` re-synthesises at a faster native speed when a clip overruns its slot.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

RATE = 24000
READER = Path.home() / "Library/Application Support/qiaomu-reader/tts/models"
KOKORO = READER / "kokoro/a3f4c73d043860e3"
MELO = READER / "melo/e58351ed7149f290"
KOKORO_SID = {"zf_001": 3, "zf_002": 4, "zf_003": 5, "zf_004": 6, "zm_009": 58, "zm_010": 59, "zm_011": 60, "zm_012": 61}

_engines = {}


def engine(name):
    if name in _engines:
        return _engines[name]
    import sherpa_onnx as sherpa
    threads = min(4, os.cpu_count() or 1)
    if name == "kokoro":
        r = KOKORO
        model = sherpa.OfflineTtsModelConfig(kokoro=sherpa.OfflineTtsKokoroModelConfig(
            model=str(r / "model.onnx"), voices=str(r / "voices.bin"), tokens=str(r / "tokens.txt"),
            data_dir=str(r / "espeak-ng-data"), lexicon=",".join(str(r / x) for x in ["lexicon-us-en.txt", "lexicon-zh.txt"])),
            num_threads=threads, provider="cpu")
        rules = [r / "date-zh.fst", r / "number-zh.fst"]
    elif name == "melo":
        r = MELO
        model = sherpa.OfflineTtsModelConfig(vits=sherpa.OfflineTtsVitsModelConfig(
            model=str(r / "model.onnx"), tokens=str(r / "tokens.txt"), lexicon=str(r / "lexicon.txt")),
            num_threads=threads, provider="cpu")
        rules = [r / "date.fst", r / "number.fst"]
    else:
        raise ValueError(name)
    cfg = sherpa.OfflineTtsConfig(model=model, rule_fsts=",".join(str(x) for x in rules), max_num_sentences=1)
    _engines[name] = sherpa.OfflineTts(cfg)
    return _engines[name]


def resample(x, src):
    if src == RATE:
        return x
    n = int(round(len(x) * RATE / src))
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


def secret(env):
    """Keys come from a file named by an environment variable; they are never printed or cached."""
    return Path(os.environ[env]).read_text().strip()


def http_json(url, headers, body, timeout=120):
    import urllib.request
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()


def pcm16(raw):
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def synth(name, voice, text, speed):
    if name == "doubao":
        # Same request as src-tauri/src/cloud.rs, plus the native speech_rate (-50..100, 100 = 2x).
        import base64, uuid
        body = http_json("https://openspeech.bytedance.com/api/v3/tts/unidirectional",
                         {"X-Api-Key": secret("DOUBAO_KEY_FILE"), "X-Api-Resource-Id": "seed-tts-2.0", "X-Api-Request-Id": str(uuid.uuid4())},
                         {"req_params": {"text": text, "speaker": voice,
                                         "audio_params": {"format": "pcm", "sample_rate": RATE, "speech_rate": round((speed - 1) * 100)}}})
        pcm = b""
        for line in filter(str.strip, body.splitlines()):
            v = json.loads(line)
            if v.get("code") not in (0, 20000000):
                raise RuntimeError(f"doubao {v.get('code')}")
            if v.get("data"):
                pcm += base64.b64decode(v["data"])
        return pcm16(pcm)
    if name == "mimo":
        # OpenAI-style chat completion: the spoken text is the assistant turn; pace is a natural-language direction.
        import base64, io
        pace = "正常语速，播客主持人自然讲述。" if speed <= 1.02 else f"语速加快到正常的 {speed:.2f} 倍左右，保持清晰，播客主持人自然讲述。"
        body = json.loads(http_json("https://api.xiaomimimo.com/v1/chat/completions", {"api-key": secret("MIMO_KEY_FILE")},
                                    {"model": os.environ.get("MIMO_MODEL", "mimo-v2.5-tts"),
                                     "messages": [{"role": "user", "content": pace}, {"role": "assistant", "content": text}],
                                     "audio": {"format": "wav", "voice": voice}}))
        x, sr = sf.read(io.BytesIO(base64.b64decode(body["choices"][0]["message"]["audio"]["data"])), dtype="float32")
        return resample(x if x.ndim == 1 else x.mean(axis=1), sr)
    if name == "qwen3":
        # Local Qwen3-TTS behind CrispASR's OpenAI-compatible server (`crispasr --server --backend qwen3-tts-customvoice`);
        # it takes the preset speaker as `voice` and a native `speed`.
        import io, urllib.request
        base = os.environ.get("COMPAT_BASE", "http://127.0.0.1:18791/v1")
        req = urllib.request.Request(base + "/audio/speech", headers={"Content-Type": "application/json"},
                                     data=json.dumps({"model": "qwen3-tts", "input": text, "voice": voice, "speed": round(speed, 2),
                                                      "response_format": "wav"}).encode())
        with urllib.request.urlopen(req, timeout=300) as r:
            x, sr = sf.read(io.BytesIO(r.read()), dtype="float32")
        return resample(x if x.ndim == 1 else x.mean(axis=1), sr)
    if name == "edge":
        # Microsoft's Read Aloud service through rany2/edge-tts (no key). Rate is a native SSML prosody percent.
        uv = os.environ.get("UV_BIN", "uv")
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "a.mp3"
            subprocess.run([uv, "tool", "run", "--quiet", "edge-tts", "--voice", voice, f"--rate=+{round((speed - 1) * 100)}%",
                            "--text", text, "--write-media", str(out)], check=True, capture_output=True)
            wav = Path(d) / "a.wav"
            subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(out), "-ac", "1", "-ar", str(RATE), str(wav)], check=True)
            x, _ = sf.read(wav, dtype="float32")
            return x
    if name == "say":
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "a.wav"
            # `say -r` is words per minute; ~175 is the default pace.
            subprocess.run(["say", "-v", voice, "-r", str(int(175 * speed)), "-o", str(out), "--data-format=LEI16@24000"],
                           input=text.encode(), check=True)
            x, sr = sf.read(out, dtype="float32")
            return resample(x, sr)
    sid = KOKORO_SID.get(voice, 0) if name == "kokoro" else 0
    a = engine(name).generate(text=text, sid=sid, speed=speed)
    return resample(np.asarray(a.samples, dtype=np.float32), a.sample_rate)


def trim(x, floor=0.01):
    """Drops leading/trailing near-silence so clip lengths compare with speech, not padding."""
    loud = np.where(np.abs(x) > floor)[0]
    if loud.size == 0:
        return x
    a, b = max(0, loud[0] - int(0.03 * RATE)), min(len(x), loud[-1] + int(0.08 * RATE))
    return x[a:b]


def clip(cache, name, voice, text, speed=1.0):
    key = hashlib.sha256(f"{name}|{voice}|{speed:.3f}|{text}".encode()).hexdigest()[:24]
    path = Path(cache) / f"{key}.wav"
    if not path.exists():
        x = trim(synth(name, voice, text, speed))
        sf.write(path, x, RATE, subtype="PCM_16")
    return str(path), sf.info(str(path)).duration


def main():
    ep, until, name, voice, cache, out = sys.argv[1:7]
    data = json.loads(Path(ep).read_text())
    segs, zh = data["segments"], data["zh"]
    Path(cache).mkdir(parents=True, exist_ok=True)
    lines = []
    for i, s in enumerate(segs):
        if s["start"] >= float(until):
            break
        text = (zh[i] or "").strip()
        if not text:
            continue
        nxt = segs[i + 1]["start"] if i + 1 < len(segs) else s["end"] + 0.5
        path, dur = clip(cache, name, voice, text)
        lines.append({"i": i, "start": s["start"], "end": s["end"], "slot": max(0.3, nxt - s["start"]),
                      "text": text, "clip": path, "dur": dur})
        print(f"{i}\t{dur:.2f}s\tslot {lines[-1]['slot']:.2f}s", flush=True)
    # Clips that overrun their slot get a native faster take, at most 1.25x.
    for l in lines:
        need = l["dur"] / l["slot"]
        if need > 1.03:
            speed = round(min(1.25, need), 2)
            l["fastClip"], l["fastDur"], l["speed"] = *clip(cache, name, voice, l["text"], speed), speed
    Path(out).write_text(json.dumps({"engine": name, "voice": voice, "lines": lines}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
