# 中文配音（实验）

把英文节目按句读成中文：每句用 TTS 读出已有的中文译文，按原文时间轴播放。这份文档记录 2026-11-18 的原型实验和产品化设计，原型脚本在 `scripts/zh-dub/`。

## 原型怎么做的

- `synth.py`：每句译文合成一段音频，按 `sha256(引擎|音色|语速|文本)` 缓存。合成后若比原句的时间槽（本句开始到下一句开始）长，再用引擎**原生语速**重合成一次，最多 1.25 倍。
- `mix.py`：同一段原声做三种播放方式：
  - **A 静音等待**：读中文时原声静音，句间空隙（音乐、笑声）保留原声；中文超过下一句开始时，原声暂停等中文读完，所以永远不会错位。
  - **B 压低等待**：时机同 A，原声压低到 −15 dB 垫在中文下面（同传感）。
  - **C 重排**：只有中文，一句接一句，句间停 0.28 秒，原文有长空隙处停 0.7 秒。
- `asr_check.py`：用本机 SenseVoice 把每句中文识别回文字，与译文比字错率，作为「听不听得清」的客观指标。

运行环境复用 qiaomu-audio 已装好的 sherpa-onnx Python 运行时和 Kokoro/Melo 模型；云端 Key 只从临时文件读取。

## 结果

见本文末尾「实验数据」。

## 产品化设计

### 1. 引擎层（Rust `speech.rs`，取代只认豆包的 `cloud::tts`）

一个命令：`tts_synthesize({ engine, model, voice, text, rate }) -> { path, seconds }`。音频写进缓存目录，前端用 `convertFileSrc` 播放，不再整段 base64 过桥。朗读（ReadAloud）和配音共用它。

| 引擎 | 实现 | Key | 原生语速 |
|---|---|---|---|
| 系统语音 | macOS `say`（AVSpeech 音色），Windows SAPI 以后 | 不要 | `say -r` |
| Edge 在线语音 | 移植 qiaomu-audio `edge.js` 的 WebSocket 协议（带 LGPL 署名）；一条串行通道 + 429 冷却 | 不要 | SSML `prosody rate` |
| 本机模型 | 见下「本机运行时」 | 不要 | Kokoro `speed` |
| 豆包语音 | 现有请求 + `audio_params.speech_rate` | `tts.doubao`，回退 `asr.doubao` | `speech_rate`（−50…100） |
| 小米 MiMo | `/v1/chat/completions`，文本放 assistant 消息，头 `api-key` | 与「AI 模型」里的 MiMo 共用 | 只能用自然语言说，幅度不准 → 按 1.0 合成，本地变速 |
| OpenAI / 兼容服务 | `/audio/speech` | `tts.<id>` | `speed` |
| 通义 Qwen-TTS、MiniMax、硅基流动、ElevenLabs、Azure | 照搬 qiaomu-audio `providers.js` 的请求和解码 | `tts.<id>` | 各自参数 |

引擎不支持准确调速时，用本地 WSOLA 变速（不变调），上限 1.25 倍。

### 2. 本机运行时

SubCast 的惯例是「按需下载预编译程序」（CrispASR、yt-dlp），不要求用户装 Python。

- **CrispASR 自带的 Kokoro 不能用于中文**：它走 espeak-ng，声调信息被丢掉，而且依赖系统里的 espeak-ng（实测报错）。
- **Kokoro v1.1-zh / MeloTTS**：用 sherpa-onnx 的预编译发布包（`sherpa-onnx-offline-tts` + 动态库），按需下载，模型来自 sherpa 固定版本、校验 SHA-256（与 qiaomu-audio 同一份 `models.json`）。机器上已有 qiaomu-audio / 乔木 Reader 下载的同版本模型时只读复用。
- **Qwen3-TTS 等大模型**：CrispASR `--server` 提供 OpenAI 兼容的 `/v1/audio/speech`，本机就是一个「兼容服务」，生命周期照 `--asr-worker`（启动、健康检查、空闲退出）。结论见实验数据。

### 3. 配音调度（前端 `src/lib/dub.ts`，独立模块）

- 只订阅 `time`、`current`、`playing` 和当前的句子表（与字幕面板用同一份、经过时间对齐的句子；feat/align 合入后自动跟随）。
- **预合成窗口**：从当前句往后 90 秒或 8 句；云端并发 3（MiMo 慢，需要并发）、Edge 1、本机 1；失败重试 2 次（1.5 s、3 s 退避），仍失败的句子跳过并在状态里计数，不卡播放。跳转时取消排队中的任务，已完成的进缓存。
- **语速预估**：按每个音色的实测「字/秒」滚动估计，在第一次请求时就给出语速，云端不必重合成（原型里重合成会多花约 50% 字数）。
- **播放**：自己的 `<audio>` 元素播中文；中文还没读完、原文已到下一句时，暂停原声，读完再继续（A/B 模式的「等待」）。
- **对 Players.tsx 的唯一改动**：`PlayerHandle` 加可选 `duck?(gain)`，`AudioEngine` 里一行 `el.volume = gainOf() * gain`，YouTube 用 `setVolume`。音量滑块不动，不写 localStorage。
- **C 重排**做成「导出中文音频」（m4a），而不是播放模式：它的时间轴和原文不对应，进度条、字幕跳转都要另做一套。

### 4. 界面（照现有风格）

- 设置 → 新块「朗读与配音」，结构和「如果没有字幕时」一致：`engine-switch` 三张卡片「本机 / 免费在线 / 云端服务」；云端用 `provider-tabs` chips + 「更多」；音色用 `model-chips`，每个音色可试听；`KeyField` + 「获取 Key」；本机模型用 `model-list` 行（大小、下载进度、取消）。
- 播放控制条：有中文译文时出现「中文配音」按钮，弹层选「压低原声 / 只听中文 / 关」和音色；准备中显示「正在准备 3/8」。
- 字幕面板里正在读的中文句高亮。
- 精读、导读的「朗读」弹层改为显示当前引擎和它的音色，不再写死豆包。
- 存储页显示配音缓存大小，可清空。

### 5. 后续

- **双人对话**：No Priors 这种访谈用一个声音读两个人很怪。CrispASR 有 `--diarize-speakers`，可以给句子标说话人，再给两个声音。
- **译文适配配音**：译文是为阅读写的，偏长。可以加一个「口语化压缩」的翻译变体，按时间槽限制字数，比加速更自然。
- 发布方式：新增 Tauri 命令，属于 App 发版，不能热更新。
