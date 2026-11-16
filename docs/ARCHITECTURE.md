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
- **本地转写**：whisper.cpp 经 `whisper-rs` 编译进独立的 `subcast-asr` 子进程（崩溃不拖垮主程序），默认模型 `ggml-large-v3-turbo-q5_0`（~550MB）首次使用时下载，可选 `small`。macOS 用 Metal。
- **音频解码**：播客 mp3/m4a/aac 用 `symphonia` + 重采样，无需 ffmpeg；YouTube 音频用 yt-dlp 取 m4a（按需下载 yt-dlp 独立程序）。
- **翻译**：沿用乔木剪藏的分批策略（≤6 段/3500 字，邻近上下文，JSON 输出 + 块格式兜底）。
- **问答**：整集带时间戳文稿直接进上下文（主流模型 128k+ 足够一集）；超长时按章节检索。回答要求以 `[mm:ss]` 引用，前端渲染为可点击跳转。

## 复用自 qiaomu-clipper（MIT）
`parseFeed`、`parseCaptions/trackInfos/chooseTrack`、InnerTube 客户端列表、翻译提示词与批处理、Whisper 幻觉过滤、`asr_context` 的提示词拼接、云端 ASR 切块思路。

## 平台
macOS (arm64/x64)、Windows x64、Linux x64；GitHub Actions `tauri-action` 矩阵构建。
