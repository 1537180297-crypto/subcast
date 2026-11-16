# SubCast 交接（2026-11-16）

分支 `feat/ux-redesign`（未合入 main）。构建：`npm run tauri build -- --bundles app`，产物 `src-tauri/target/release/bundle/macos/SubCast.app`。
自测：`cd src-tauri && cargo test --lib <name> -- --ignored --nocapture`（live 测试：qiaomu_channels、qiaomu_rss_sources、captions、sources）。

## 本轮已完成（最后一次提交含以下全部）
- 精读面板去掉说明文字；收起字幕栏图标放大；月份日历改为中性色+细强调条
- 乔木精读去重：订阅了原版节目则侧栏不再重复显示，原版节目页顶部出现「这档节目有乔木精读版」入口（`deepPickFor`）
- 本集简介移到播放器下方；去掉「导读」tab，AI 导读改为左侧可折叠卡片（`GuideCard`）
- 划线工具条（复制带出处 / 翻译 / 生成海报），海报移植自 elon.qiaomu.ai kit.js（`src/lib/poster.ts`、`components/SelectionTools.tsx`、Rust `save_image` 存到「下载」）
- 新增 rss.qiaomu.ai 普通源 + 乔木改写（`qiaomu.rs`：`rss_channel`、`rss_rewrite`（Markdown→HTML）、`podscribe_transcript`（带时间戳）；Podscribe 源无音频时按标题从原 RSS 借音频）。live 测试已通过（nexttoken、podscribe-pivot）
- 发现页新增：Next Token、Joe Rogan、80k、Pivot、Freakonomics、ILTB、DOAC

## 未完成（按优先级）
1. **前端接上 rss 源**：
   - `src/lib/picks.ts` 把这些 pick 的 input 改成 `https://rss.qiaomu.ai/sources/<id>` 并加 `deep: true`：nexttoken、bannatie（替换 banlatie）、latentspace、podscribe-acquired、podscribe-pivot、podscribe-freakonomics-radio、podscribe-invest-like-the-best、podscribe-the-diary-of-a-ceo-with-steven-bartlett。
   - Rust `qiaomu.rs` 的 `title_for` / `cover_for` 补这些 id（标题要等于 pick.title，`showName` 才能映射中文名）。
   - 前端「是否精读」判断改为 `transcriptType ∈ {qiaomu, qiaomu-rss, podscribe}`：EpisodeView 显示「精读」tab，Lists 的「精读」标签；`DeepRead` 已通用（走 `qiaomu_detail`，后端已按类型分流）。
2. **字幕空状态重设计**（用户指出：顶部状态行截断、窄宽度下设置溢出、不够优雅）：重写 `TranscriptPanel.tsx` 的 `NoTranscript` 空状态——去掉顶部截断的 StatusLine，改为居中卡片（图标+衬线标题+一句说明+主按钮+模型大小小字），识别设置用紧凑可换行布局，配合 `.ep-right` 的 container query 适配各宽度。
3. **The Builders（Walter Isaacson，iHeart）**：用户要求加到「发现」并订阅。iTunes 按名搜不到，需找 RSS（omnycontent，iHeart；可在 Apple Podcasts 页面/omny 搜 "The Builders Walter Isaacson"），加 pick（话题「科技评论」/「AI 前沿」），并在 app 里订阅一次。
4. 未实测：窄面板图标 tab、骨架屏、视频失败自动切音频、云端识别/TTS（需 Key）、海报保存与复制、rss 源在 UI 中的完整流程。
5. 发布：合入 main 前按全局 git 流程（worktree、diff 审阅、验证后删分支）。release 分支 `release/macos-sign`（PR joeseesun/subcast#1）独立。

## 关键位置
- 精读站频道：`qiaomu.rs::channel/detail`；rss 源：`qiaomu.rs::rss_*`；命令在 `lib.rs`（`preview_show`、`cached_show`、`qiaomu_detail`、`fetch_official_transcript`）
- 设置（Capwise 移植）：`SettingsDialog.tsx`、`lib/settings.ts`（PRESETS/ASR_SERVICES/VOICES）、`cloud.rs`
- 布局：`lib/layout.ts`、`Splitter.tsx`；样式全部在 `src/styles.css`（后追加的块覆盖前面）
- 研究笔记：`docs/rss-qiaomu-integration.md`
