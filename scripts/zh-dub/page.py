"""Builds index.html next to the samples: players for every strategy and engine, with the numbers.

    python3 page.py <samples-dir> <voices.tsv>
"""
import html
import json
import sys
from pathlib import Path

EPISODES = {
    "aidaily": ("AI Daily Brief · 7 Things AI-Native Companies Do Differently", "单人独白，句子长"),
    "nopriors": ("No Priors · Robinhood", "双人访谈，句子短"),
}
ENGINES = {
    "doubao": "豆包 seed-tts 2.0（云端，¥3/万字）",
    "mimo": "小米 MiMo-V2.5-TTS（云端，限时免费）",
    "edge": "Edge 在线语音（免费，无 Key）",
    "kokoro": "Kokoro v1.1-zh（本机，sherpa-onnx）",
    "qwen3": "Qwen3-TTS 0.6B（本机，CrispASR）",
    "melo": "MeloTTS（本机，sherpa-onnx）",
    "say": "macOS 系统语音 · 婷婷",
}
STRATEGIES = [("A", "静音等待", "只听中文，句间保留原声的音乐和笑声；中文没读完时原声暂停等待"),
              ("B", "压低等待", "原声压低到 −15 dB 垫在中文下面，像同声传译"),
              ("C", "重排", "纯中文节目，按中文时长一句接一句，不跟原时间轴")]


def main():
    d = Path(sys.argv[1])
    speeds = {}
    for row in Path(sys.argv[2]).read_text().splitlines():
        e, v, s = row.split("\t")
        speeds[e] = s.replace(" chars/s", " 字/秒")
    body = []
    for ep, (title, note) in EPISODES.items():
        body.append(f'<section><h2>{html.escape(title)}</h2><p class="muted">{note} · 前 4 分钟</p>')
        body.append('<div class="orig"><span>英文原声</span><audio controls preload="none" src="' + f"{ep}-original.m4a" + '"></audio></div>')
        for eng, label in ENGINES.items():
            stats = d / f"{ep}-{eng}-stats.json"
            if not stats.exists():
                continue
            s = json.loads(stats.read_text())["summary"]
            body.append(f'<div class="engine"><h3>{label}</h3>'
                        f'<p class="nums">不加速放得下 <b>{s["fitNatural"]}</b> 句 · 加速 ≤1.25× 后 <b>{s["fitAfterSpeedup"]}</b> · '
                        f'原声暂停 {s["holds"]} 次共 <b>{s["holdSeconds"]} 秒</b>（最长 {s["longestHold"]} 秒）· '
                        f'中文自然时长 {s["chineseSpeechSeconds"]} 秒 / 原文 {s["originalSpanSeconds"]} 秒</p><div class="grid">')
            for tag, name, desc in STRATEGIES:
                f = f"{ep}-{eng}-{tag}.m4a"
                if (d / f).exists():
                    secs = s[f"{tag}_seconds"]
                    body.append(f'<div class="card"><p class="tag">{tag} · {name}<span>{secs} 秒</span></p><p class="muted small">{desc}</p>'
                                f'<audio controls preload="none" src="{f}"></audio></div>')
            body.append("</div></div>")
        body.append("</section>")
    voices = [f for f in sorted(d.glob("aidaily-voice-*.m4a"))]
    if voices:
        body.append('<section><h2>同一段中文，各引擎音色</h2><p class="muted">AI Daily Brief 开头 8 句，自然语速，音量拉齐</p><div class="grid">')
        for f in voices:
            eng = f.stem.split("-voice-")[1]
            body.append(f'<div class="card"><p class="tag">{ENGINES.get(eng, eng)}<span>{speeds.get(eng, "")}</span></p>'
                        f'<audio controls preload="none" src="{f.name}"></audio></div>')
        body.append("</div></section>")
    page = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>中文配音样例</title><style>
:root{{--bg:#fafafa;--fg:#111;--muted:#6b6b6b;--card:#fff;--line:#e5e5e5;--accent:#f97316;--tint:#fff4ec}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0b0b0b;--fg:#ededed;--muted:#9a9a9a;--card:#161616;--line:#262626;--tint:#2a1a0e}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}}
main{{max-width:1080px;margin:0 auto;padding:32px 16px 64px}}h1{{font-size:26px;margin:0 0 4px}}h2{{font-size:19px;margin:40px 0 2px}}
h3{{font-size:15px;margin:24px 0 2px}}.muted{{color:var(--muted)}}.small{{font-size:13px;margin:2px 0 8px}}
.nums{{font-size:13px;color:var(--muted);margin:0 0 10px}}.nums b{{color:var(--fg)}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}}
.tag{{margin:0;font-weight:600;display:flex;justify-content:space-between;gap:8px}}.tag span{{color:var(--muted);font-weight:400;font-size:13px}}
.orig{{display:flex;align-items:center;gap:12px;background:var(--tint);border-radius:12px;padding:10px 14px;margin-top:12px}}
.orig span{{font-weight:600;color:var(--accent);white-space:nowrap}}audio{{width:100%;height:36px}}
</style></head><body><main><h1>中文配音样例</h1><p class="muted">SubCast 实验 · 每句中文按原文时间轴播放 · 2026-11-18</p>
{''.join(body)}</main></body></html>"""
    (d / "index.html").write_text(page)


if __name__ == "__main__":
    main()
