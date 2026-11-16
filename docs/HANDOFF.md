# SubCast 交接（2026-11-16）

分支 `feat/ux-redesign`（未合入 main）。构建：`npm run tauri build -- --bundles app`，产物 `src-tauri/target/release/bundle/macos/SubCast.app`。
自测：`cd src-tauri && cargo test --lib <name> -- --ignored --nocapture`（live 测试：qiaomu_channels、qiaomu_rss_sources、captions、sources）。

## 上一轮已完成
- 精读面板去掉说明文字；收起字幕栏图标放大；月份日历改为中性色+细强调条
- 乔木精读去重：订阅了原版节目则侧栏不再重复显示，原版节目页顶部出现「这档节目有乔木精读版」入口（`deepPickFor`）
- 本集简介移到播放器下方；去掉「导读」tab，AI 导读改为左侧可折叠卡片（`GuideCard`）
- 划线工具条（复制带出处 / 翻译 / 生成海报），海报移植自 elon.qiaomu.ai kit.js（`src/lib/poster.ts`、`components/SelectionTools.tsx`、Rust `save_image` 存到「下载」）
- 新增 rss.qiaomu.ai 普通源 + 乔木改写（`qiaomu.rs`：`rss_channel`、`rss_rewrite`（Markdown→HTML）、`podscribe_transcript`（带时间戳）；Podscribe 源无音频时按标题从原 RSS 借音频）。live 测试已通过（nexttoken、podscribe-pivot）
- 发现页新增：Next Token、Joe Rogan、80k、Pivot、Freakonomics、ILTB、DOAC

## 本轮已完成（2026-11-16 第二轮）
- **乔木改写频道接入前端**：发现页里 Next Token、半拿铁、Latent Space、Acquired、Pivot、Freakonomics、Invest Like the Best、Diary of a CEO 改为订阅 `https://rss.qiaomu.ai/sources/<id>`，标为精读（`picks.ts`；Rust `title_for` / `cover_for` 已补）。
  - 单集新增 `deep` 字段（`episodes.deep` 列，旧库启动时自动加列，原 `qiaomu` 单集置 1）。精读站单集恒为 true；rss 单集取接口的 `rewriteReady`，所以只有真有改写的单集才显示「精读」tab 和列表「精读」标签（Podscribe 源不少单集还没改写，如 Freakonomics 3/10）。
  - rss 普通源跳过没音频也没视频的条目（Latent Space 混着 AINews 文章，100 条剩 44 条可播）。
  - Podscribe 借音频改为读该节目自己的原始 RSS（`original_feed`，全量不截 300 条），按「标题完全一致 → 36 小时内且标题相近 → 12 小时内唯一一集 → 标题几乎一致」匹配（`find_audio`，有单测）。可播：Acquired 9/9、Pivot 22/22、Freakonomics 10/10、ILTB 10/10（之前 0）、DOAC 22/28（之前 7）。DOAC 原始 RSS 6.7 MB，订阅/刷新约多 5 秒。
  - 改写 Markdown 里的图片语法 `![..](..)` 不再漏出「!」。
- **字幕空状态重做**：`TranscriptPanel` 的无字幕 / 下载模型 / 识别失败改为居中卡片（`GenCard`：图标 + 衬线标题 + 一句说明 + 主按钮「生成字幕」+ 模型大小小字 + 可折叠识别设置，设置可换行）。错误文字去掉网址、最多三行，完整内容在悬停提示里。用 headless Chrome 在 340/460/760 px、浅色/深色下截图检查过。
- **The Builders**（Walter Isaacson，iHeart）加入发现页，RSS 为 omnycontent `…/51d9281c-e886-4139-b940-b4c0011494bc/podcast.rss`（Apple 按 "The Builders iHeart" 能搜到，id 6820674378）。

## 未完成（按优先级）
1. **在 app 里实测本轮改动**（本轮只做了接口 live 测试和 CSS 截图，没能在 app 里点过：构建时旧版 SubCast 正在运行，没有替用户退出）。重启 app 后看：
   - 发现 › 乔木精读：订阅 Pivot / Next Token，列表里只有真有改写的单集带「精读」标签，点开默认在「精读」tab；没有改写的单集不显示精读 tab。
   - 已订阅原版 Acquired 等节目的老用户：节目页顶部出现「这档节目有乔木精读版」入口。
   - 一集没字幕的 YouTube / 播客：字幕栏是居中卡片，拖窄字幕栏到最窄（340）不溢出；下载模型、识别失败两种状态也是卡片。
   - 订阅 DOAC 会多等约 5 秒（读原始 RSS 借音频）。
2. 未实测（沿用上一轮）：窄面板图标 tab、骨架屏、视频失败自动切音频、云端识别/TTS（需 Key）、海报保存与复制。
3. The Builders 中文名「造物者」是暂定，需要确认；用户要求「在 app 里订阅一次」也还没做（需要在 app 里点订阅）。
4. 发布：合入 main 前按全局 git 流程（worktree、diff 审阅、验证后删分支）。release 分支 `release/macos-sign`（PR joeseesun/subcast#1）独立。
## 关键位置
- 精读站频道：`qiaomu.rs::channel/detail`；rss 源：`qiaomu.rs::rss_*`；命令在 `lib.rs`（`preview_show`、`cached_show`、`qiaomu_detail`、`fetch_official_transcript`）
- 设置（Capwise 移植）：`SettingsDialog.tsx`、`lib/settings.ts`（PRESETS/ASR_SERVICES/VOICES）、`cloud.rs`
- 布局：`lib/layout.ts`、`Splitter.tsx`；样式全部在 `src/styles.css`（后追加的块覆盖前面）
- 研究笔记：`docs/rss-qiaomu-integration.md`
