//! Subcommand router and shared CLI helpers.
pub mod ai;
pub mod caption;
pub mod clip;
pub mod ep;
pub mod learn;
pub mod mcp;
pub mod ops;
pub mod pipe;
pub mod sub;

use crate::exit::CliError;
use crate::output::Out;
use clap::Subcommand;
use std::io::Read;
use std::sync::Arc;
use subcast_core::{db, ops as core_ops, resolver, CoreCtx, Episode, ProgressSink, Transcript};

#[derive(Subcommand)]
pub enum Commands {
    /// Subscribe to a podcast, YouTube channel, Xiaoyuzhou show, or single video URL
    Add(sub::AddArgs),
    /// Preview a podcast, YouTube channel, or RSS feed without subscribing
    Preview(sub::PreviewArgs),
    /// Manage subscribed shows (list, refresh, remove, search)
    Shows(sub::ShowsArgs),
    /// Search Apple Podcasts directory
    Search(sub::SearchArgs),
    /// Browse or subscribe to curated recommended podcasts
    Picks(sub::PicksArgs),
    /// Import subscriptions from OPML or a browser YouTube login
    Import(sub::ImportArgs),
    /// Export subscriptions (OPML)
    Export(sub::ExportArgs),

    /// Browse and update episodes (list, show, progress, watched)
    Ep(ep::EpArgs),
    /// Manage favorite episodes
    Fav(ep::FavArgs),
    /// Show listening statistics and AI listener portrait
    Stats(ep::StatsArgs),
    /// Play an episode or print its stream URL
    Play(ep::PlayArgs),

    /// Export subtitles (srt, vtt, ass, lrc, txt, md)
    Caption(caption::CaptionArgs),
    /// Transcribe an episode or local audio/video file
    Transcribe(caption::TranscribeArgs),
    /// Align transcript timestamps against downloaded/cached audio
    Align(caption::AlignArgs),
    /// Query, fetch, or publish community shared transcripts
    Shared(caption::SharedArgs),

    /// Translate episode subtitles
    Translate(ai::TranslateArgs),
    /// Generate or read a Chinese AI episode guide
    Guide(ai::GuideArgs),
    /// Fetch full show notes or Qiaomu deep-read notes
    Deep(ai::DeepArgs),
    /// Ask questions about an episode (multi-turn or one-shot)
    Ask(ai::AskArgs),
    /// Extract, list, polish, or generate social posts from episode highlights
    Highlights(ai::HighlightsArgs),

    /// Cut audio or video highlights and render clip covers
    Clip(clip::ClipArgs),
    /// Render a shareable quote poster PNG
    Poster(clip::PosterArgs),

    /// Manage vocabulary book, FSRS reviews, ECDICT lookup, and CSV/Anki export
    Vocab(learn::VocabArgs),
    /// Speech synthesis (TTS), system voices, and local TTS runtime
    Tts(learn::TtsArgs),
    /// Shadowing microphone readiness & pronunciation check
    Shadow(learn::ShadowArgs),

    /// Manage offline downloads
    Download(ops::DownloadArgs),
    /// Manage local ASR speech models
    Models(ops::ModelsArgs),
    /// Detect and probe local CLI AI agents (Claude, Codex, Gemini, etc.)
    Agents(ops::AgentsArgs),
    /// Inspect or update SubCast settings
    Config(ops::ConfigArgs),
    /// Manage API keys and YouTube cookies/login status
    Auth(ops::AuthArgs),
    /// Inspect storage usage and clear caches
    Storage(ops::StorageArgs),
    /// Check dependencies, keys, models, and database health
    Doctor(ops::DoctorArgs),
    /// Run a composable multi-stage pipeline on a URL, file, or episode
    Pipe(pipe::PipeArgs),
    /// Print shell completion scripts
    Completions(ops::CompletionsArgs),
    /// Run the Model Context Protocol (MCP) server over stdio
    Mcp(mcp::McpArgs),
}

pub async fn dispatch(
    cmd: Commands,
    ctx: &Arc<CoreCtx>,
    sink: Arc<dyn ProgressSink>,
    out: Out,
    no_input: bool,
) -> Result<(), CliError> {
    match cmd {
        Commands::Add(a) => sub::run_add(ctx, a, out).await,
        Commands::Preview(a) => sub::run_preview(ctx, a, out).await,
        Commands::Shows(a) => sub::run_shows(ctx, a, out).await,
        Commands::Search(a) => sub::run_search(a, out).await,
        Commands::Picks(a) => sub::run_picks(ctx, a, out).await,
        Commands::Import(a) => sub::run_import(ctx, a, out).await,
        Commands::Export(a) => sub::run_export(ctx, a, out).await,

        Commands::Ep(a) => ep::run_ep(ctx, a, out).await,
        Commands::Fav(a) => ep::run_fav(ctx, a, out).await,
        Commands::Stats(a) => ep::run_stats(ctx, a, sink.as_ref(), out).await,
        Commands::Play(a) => ep::run_play(ctx, a, out).await,

        Commands::Caption(a) => caption::run_caption(ctx, a, out).await,
        Commands::Transcribe(a) => caption::run_transcribe(ctx, a, sink, out).await,
        Commands::Align(a) => caption::run_align(ctx, a, sink.as_ref(), out).await,
        Commands::Shared(a) => caption::run_shared(ctx, a, out).await,

        Commands::Translate(a) => ai::run_translate(ctx, a, sink.as_ref(), out).await,
        Commands::Guide(a) => ai::run_guide(ctx, a, sink.as_ref(), out).await,
        Commands::Deep(a) => ai::run_deep(ctx, a, out).await,
        Commands::Ask(a) => ai::run_ask(ctx, a, sink.as_ref(), out).await,
        Commands::Highlights(a) => ai::run_highlights(ctx, a, sink.as_ref(), out).await,

        Commands::Clip(a) => clip::run_clip(ctx, a, sink.as_ref(), out).await,
        Commands::Poster(a) => clip::run_poster(ctx, a, out).await,

        Commands::Vocab(a) => learn::run_vocab(ctx, a, out).await,
        Commands::Tts(a) => learn::run_tts(ctx, a, sink.as_ref(), out).await,
        Commands::Shadow(a) => learn::run_shadow(ctx, a, out).await,

        Commands::Download(a) => ops::run_download(ctx, a, sink.as_ref(), out).await,
        Commands::Models(a) => ops::run_models(ctx, a, sink.as_ref(), out).await,
        Commands::Agents(a) => ops::run_agents(a, out).await,
        Commands::Config(a) => ops::run_config(ctx, a, out, no_input),
        Commands::Auth(a) => ops::run_auth(ctx, a, out),
        Commands::Storage(a) => ops::run_storage(ctx, a, out),
        Commands::Doctor(a) => ops::run_doctor(ctx, a, out),
        Commands::Pipe(a) => pipe::run_pipe(ctx, a, sink, out).await,
        Commands::Completions(a) => ops::run_completions(a),
        Commands::Mcp(_) => mcp::run_mcp(ctx).await,
    }
}

pub async fn resolve_or_ingest_episode(ctx: &CoreCtx, reference: &str) -> Result<Episode, CliError> {
    if resolver::is_url_or_path(reference) {
        let trimmed = reference.trim();
        let path = std::path::Path::new(trimmed);
        if path.is_file() {
            let canonical = std::fs::canonicalize(path)
                .map_err(|e| CliError::not_found(format!("找不到本地文件: {e}")))?;
            let path_str = canonical.to_string_lossy().into_owned();
            let ep_id = subcast_core::short_hash(&format!("local:{path_str}"), 20);
            if let Ok(Some(existing)) = db::get_episode(&ctx.db.lock().unwrap(), &ep_id) {
                return Ok(existing);
            }
            let ep = Episode {
                id: ep_id,
                show_id: "single".into(),
                guid: format!("local:{path_str}"),
                title: canonical
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Local Audio")
                    .to_string(),
                published: Some(subcast_core::now_ms()),
                audio_url: Some(path_str),
                ..Default::default()
            };
            db::upsert_episodes(&mut ctx.db.lock().unwrap(), std::slice::from_ref(&ep))?;
            return Ok(ep);
        }
        let added = core_ops::add_subscription(ctx, trimmed).await?;
        if let Some(ep) = added.episode {
            return Ok(ep);
        }
        if let Some(show) = added.show {
            let eps = db::list_episodes(&ctx.db.lock().unwrap(), Some(&show.id), 1)?;
            return eps
                .into_iter()
                .next()
                .ok_or_else(|| CliError::not_found("该频道暂时没有单集"));
        }
    }
    Ok(resolver::resolve_episode(ctx, reference).await?)
}

pub async fn ensure_transcript(
    ctx: &CoreCtx,
    ep: &Episode,
    allow_shared: bool,
    allow_youtube: bool,
) -> Result<Transcript, CliError> {
    if let Some(t) = db::get_transcript(&ctx.db.lock().unwrap(), &ep.id)? {
        return Ok(t);
    }
    if allow_shared {
        if let Some(t) = core_ops::shared_transcript(ctx, &ep.id).await? {
            return Ok(t);
        }
    }
    if let Some(t) = core_ops::fetch_official_transcript(ctx, &ep.id).await? {
        return Ok(t);
    }
    if allow_youtube && ep.video_id.is_some() {
        let tracks = core_ops::youtube_tracks(ctx, &ep.id).await?;
        if let Some(pick) = tracks
            .iter()
            .find(|t| !t.auto && t.language.starts_with("en"))
            .or_else(|| tracks.iter().find(|t| !t.auto))
            .or_else(|| tracks.first())
        {
            return Ok(core_ops::use_youtube_track(ctx, &ep.id, &pick.language, pick.auto).await?);
        }
    }
    Err(CliError::not_found(format!(
        "单集「{}」暂无可用字幕，请先运行 `subcast transcribe {}`",
        ep.title, ep.id
    )))
}

pub fn read_arg_or_stdin(raw: &str) -> Result<String, CliError> {
    if raw == "-" {
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| CliError::usage(format!("读取标准输入失败：{e}")))?;
        return Ok(buf);
    }
    Ok(raw.to_string())
}
