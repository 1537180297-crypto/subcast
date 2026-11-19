# 架构

```
┌──────────────── WebView (React + TS) ────────────────┐
│ 订阅列表 · 单集列表 · 播放器(audio / YouTube iframe)   │
│ 双语字幕面板 · AI 问答/总结 · 设置                     │
│ LLM 调用：经 Rust 代理（流式事件）                     │
└──────────────▲───────────────── invoke / events ─────┘
               │
┌──────────────┴──────── Rust (Tauri 2) ───────────────┐
│ feeds     RSS/Atom 解析、YouTube 频道、iTunes 查找/搜索 │
│ captions  YouTube InnerTube（ANDROID/IOS 客户端）→     │
│           yt-dlp 回退；podcast:transcript (VTT/SRT/JSON)│
│ asr       下载音频 → symphonia 解码 16k 单声道 →        │
│           whisper.cpp（whisper-rs），进度事件            │
│ llm       OpenAI 兼容 / Anthropic 流式代理              │
│ db        SQLite：订阅、单集、字幕、译文、对话、进度     │
│ secrets   API Key → 系统钥匙串（keyring）              │
│ net       全局代理设置（http/socks5）                  │
└──────────────────────────────────────────────────────┘
```

## 关键决策
- **所有网络请求在 Rust 侧**：任意 RSS 主机和 InnerTube 都有 CORS，WebView 直接 fetch 不可行；也便于统一走代理。
- **订阅来源统一归一为 RSS/Atom**：
  - YouTube：`youtube.com/feeds/videos.xml?channel_id=UC…`（@handle / 频道链接 → 读页面得 channel_id）
  - Apple Podcasts：`itunes.apple.com/lookup?id=…&entity=podcast` → `feedUrl`；搜索用 iTunes Search API
  - 小宇宙：节目页 → 关联 RSS（多数节目有 `feed.xyzfm.space/<id>`）；单集页解析音频直链
- **本地转写，两个引擎**：
  - **Qwen3-ASR 0.6B（默认推荐）**：通过 [CrispASR](https://github.com/CrispStrobe/CrispASR)（MIT，ggml，Metal/CUDA/Vulkan）运行 `cstr/qwen3-asr-0.6b-GGUF` 的 q8_0（~960MB）。识别程序（~19MB）按平台从 GitHub Release 按需下载。它按 ~30 秒一段输出，再按句拆分、按字数分配时间。中英文都准、自带标点（qiaomu-clipper 也把它列为中文首选）。
  - **Whisper**（large-v3-turbo / small / base）：whisper.cpp 经 `whisper-rs` 编进本程序，以 `--asr-worker` 子进程运行（崩溃不拖垮主程序），支持语言最多、可实时逐句显示。
  - 模型优先从 hf-mirror.com 下载，失败回退 huggingface.co。
  - TODO：Qwen3 分支的音频解码目前在主进程（spawn_blocking）里做，应改走 `--asr-worker` 的解码模式，避免坏文件拖垮主程序。
- **音频解码**：播客 mp3/m4a/aac 用 `symphonia` + 重采样，无需 ffmpeg；YouTube 音频用 yt-dlp 取 m4a（按需下载 yt-dlp 独立程序）。
- **字幕对齐（align.rs，0.3.0）**：播客常会重新剪辑、换广告，字幕所用的音频和你此刻播放的可能不是同一个文件。正文相同，只是在广告处整段平移。
  - 字幕记下它对应的音频（blob `audio-ref`：字节数、时长、chromaprint 声音指纹，转写时算，随共享字幕上传）。
  - 播放前比对字节数，相同就不做任何事。不同时把当前音频下到 `audio-cache/`（播放也用这份），比对两份指纹得出「两边共有的段」（blob `tmap`），精度约 0.12 秒。
  - 没有指纹的字幕（0.3.0 以前共享的、节目方自带的）由用户在字幕栏「…」里点「重新自动对齐」：每 120 秒截 24 秒，拼成一个文件让本机模型识别一次，按 4 词一组到字幕里找位置，偏移跳变处再加密探测。也可以边听边点一句手动对齐。
  - 时间映射只在播放器里用（`src/lib/timemap.ts`：`track` 把播放器时钟换成字幕时间，`seek` 反过来）。字幕、译文、生词本跳转、导读时间戳都不用改；进度条按播放器自己的时钟。只在你的音频里有的片段（多半是广告）会提示，可选自动跳过。
- **翻译**：沿用乔木剪藏的分批策略（≤6 段/3500 字，邻近上下文，JSON 输出 + 块格式兜底）。
- **问答**：整集带时间戳文稿直接进上下文（主流模型 128k+ 足够一集）；超长时按章节检索。回答要求以 `[mm:ss]` 引用，前端渲染为可点击跳转。

## 复用自 qiaomu-clipper（MIT）
`parseFeed`、`parseCaptions/trackInfos/chooseTrack`、InnerTube 客户端列表、翻译提示词与批处理、Whisper 幻觉过滤、`asr_context` 的提示词拼接、云端 ASR 切块思路。

## 平台
macOS (arm64/x64)、Windows x64、Linux x64；GitHub Actions `tauri-action` 矩阵构建。
