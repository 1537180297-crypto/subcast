//! Local transcription with whisper.cpp. The recogniser runs in a child process (this same executable started
//! with `--asr-worker`) so a crash in native code never takes the app down. Audio stays on this computer and is
//! deleted when the job ends; only the text is kept.
use crate::model::Segment;
use crate::net;
use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub struct ModelSpec {
    pub id: &'static str,
    pub name: &'static str,
    /// whisper: whisper.cpp in our own worker process; qwen3: Qwen3-ASR through the CrispASR program.
    pub engine: &'static str,
    /// Hugging Face repository the file comes from.
    pub repo: &'static str,
    pub file: &'static str,
    pub size_mb: u32,
    pub note: &'static str,
}

pub const MODELS: &[ModelSpec] = &[
    ModelSpec { id: "qwen3-asr", name: "Qwen3-ASR 0.6B（推荐）", engine: "qwen3", repo: "cstr/qwen3-asr-0.6b-GGUF", file: "qwen3-asr-0.6b-q8_0.gguf", size_mb: 960, note: "中英文都准，自带标点，专有名词识别好；首次使用另需下载约 20 MB 识别程序" },
    ModelSpec { id: "large-v3-turbo", name: "Whisper large-v3-turbo", engine: "whisper", repo: "ggerganov/whisper.cpp", file: "ggml-large-v3-turbo-q5_0.bin", size_mb: 547, note: "支持语言最多，Apple 芯片上 1 小时音频约 3–5 分钟" },
    ModelSpec { id: "small", name: "Whisper small", engine: "whisper", repo: "ggerganov/whisper.cpp", file: "ggml-small-q5_1.bin", size_mb: 181, note: "体积小、速度快，准确率稍低" },
    ModelSpec { id: "base", name: "Whisper base", engine: "whisper", repo: "ggerganov/whisper.cpp", file: "ggml-base-q5_1.bin", size_mb: 57, note: "最快，适合试用或老电脑" },
];

pub fn spec(id: &str) -> Option<&'static ModelSpec> { MODELS.iter().find(|m| m.id == id) }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub size_mb: u32,
    pub note: String,
    pub installed: bool,
    /** The app whose copy is used (found on this computer, linked, not downloaded). */
    pub from: Option<String>,
}

pub fn models_dir(data: &Path) -> PathBuf { data.join("models") }

pub fn list_models(data: &Path) -> Vec<ModelInfo> {
    adopt_found(data);
    let dir = models_dir(data);
    let mut out: Vec<ModelInfo> = MODELS.iter().map(|m| {
        let path = dir.join(m.file);
        let from = linked_from(&path);
        ModelInfo {
            id: m.id.into(), name: m.name.into(), size_mb: m.size_mb,
            note: m.note.into(),
            installed: path.is_file(),
            from,
        }
    }).collect();
    // Other whisper.cpp / Qwen3-ASR files found on this computer can be used as they are.
    for (name, engine) in extra_files(data) {
        let path = dir.join(&name);
        let size_mb = std::fs::metadata(&path).map(|m| (m.len() / 1_048_576) as u32).unwrap_or(0);
        let label = name.trim_start_matches("ggml-").trim_end_matches(".bin").trim_end_matches(".gguf");
        out.push(ModelInfo {
            id: format!("file:{name}"),
            name: if engine == "qwen3" { format!("Qwen3-ASR（{label}）") } else { format!("Whisper {label}") },
            size_mb,
            note: String::new(),
            installed: path.is_file(),
            from: Some(linked_from(&path).unwrap_or_else(|| "本机".into())),
        });
    }
    out
}

/// A model to run: its engine, file and the id it is recorded under.
pub struct Resolved { pub id: String, pub engine: &'static str, pub path: PathBuf }

/// Our own models by id, and files found on this computer as "file:<name>".
pub fn resolve(data: &Path, id: &str) -> Option<Resolved> {
    if let Some(m) = spec(id) { return Some(Resolved { id: m.id.into(), engine: m.engine, path: models_dir(data).join(m.file) }); }
    let name = id.strip_prefix("file:")?;
    if name.contains('/') || name.contains('\\') || name.contains("..") { return None; }
    let engine = engine_of(name)?;
    Some(Resolved { id: id.into(), engine, path: models_dir(data).join(name) })
}

/// whisper.cpp ggml files and Qwen3-ASR GGUF files, by name.
fn engine_of(name: &str) -> Option<&'static str> {
    let n = name.to_lowercase();
    if n.starts_with("ggml-") && n.ends_with(".bin") && !n.contains("silero") && !n.contains("vad") { Some("whisper") }
    else if n.starts_with("qwen3-asr") && n.ends_with(".gguf") { Some("qwen3") }
    else { None }
}

/// The app a linked model file belongs to, from where it lives ("Screen Studio", "Hugging Face 缓存"…).
fn linked_from(path: &Path) -> Option<String> {
    let target = std::fs::read_link(path).ok()?;
    let s = target.to_string_lossy();
    if s.contains("huggingface") { return Some("Hugging Face 缓存".into()); }
    if let Some(i) = s.find("Application Support/") { return s[i + 20..].split('/').next().map(str::to_string); }
    target.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string())
}

/// Model files in our folder that aren't ours: links to files found elsewhere.
fn extra_files(data: &Path) -> Vec<(String, &'static str)> {
    let mut v: Vec<(String, &'static str)> = std::fs::read_dir(models_dir(data)).into_iter().flatten().flatten()
        .filter_map(|e| { let n = e.file_name().to_string_lossy().to_string(); let eng = engine_of(&n)?; (!MODELS.iter().any(|m| m.file == n) && e.path().is_file()).then_some((n, eng)) })
        .collect();
    v.sort();
    v
}

/// Whether a file really is a model of that kind: whisper.cpp files start with "lmgg", GGUF with "GGUF".
fn looks_like_model(path: &Path, engine: &str) -> bool {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else { return false };
    let min = if engine == "qwen3" { 300 } else { 30 } * 1_048_576;
    if meta.len() < min { return false; }
    let mut magic = [0u8; 4];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut magic)).is_ok()
        && if engine == "qwen3" { &magic == b"GGUF" } else { &magic == b"lmgg" || &magic == b"ggjt" || &magic == b"GGUF" }
}

/// Where other apps keep speech models (whisper.cpp front ends, screen recorders, Hugging Face's cache…).
fn model_roots() -> Vec<(PathBuf, usize)> {
    let h = dirs::home_dir().unwrap_or_default();
    let mut v = vec![
        (h.join(".cache/huggingface/hub"), 5), (h.join(".cache"), 3), (h.join("whisper.cpp/models"), 1),
        (h.join("Downloads"), 1), (h.join(".local/share"), 3),
    ];
    if let Some(d) = dirs::data_dir() { v.push((d, 3)); }       // ~/Library/Application Support, %APPDATA%, ~/.local/share
    // Mac App Store apps keep theirs inside their sandbox containers.
    if cfg!(target_os = "macos") {
        for base in [h.join("Library/Containers"), h.join("Library/Group Containers")] {
            for e in std::fs::read_dir(&base).into_iter().flatten().flatten() {
                let p = e.path();
                v.push((p.join("Data/Library/Application Support"), 3));
                v.push((p.join("Data/Documents"), 2));
                v.push((p.join("Library/Application Support"), 3));
            }
        }
    }
    if let Some(d) = dirs::data_local_dir() { v.push((d, 3)); } // %LOCALAPPDATA%
    v
}

/// Links usable model files found elsewhere on this computer into our models folder (nothing is copied or
/// downloaded; deleting the link here never touches the original). Runs at most once a minute.
/// Looks again on the next list (Settings › 重新查找).
pub fn rescan() { *SCANNED.lock().unwrap() = None; }
static SCANNED: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

fn adopt_found(data: &Path) {
    let last_scan = &SCANNED;

    {
        let mut last = last_scan.lock().unwrap();
        if last.is_some_and(|t| t.elapsed().as_secs() < 60) { return; }
        *last = Some(std::time::Instant::now());
    }
    let dir = models_dir(data);
    let _ = std::fs::create_dir_all(&dir);
    let own = dir.canonicalize().unwrap_or(dir.clone());
    let mut found: Vec<PathBuf> = Vec::new();
    fn walk(p: &Path, depth: usize, own: &Path, out: &mut Vec<PathBuf>, budget: &mut usize) {
        if *budget == 0 { return; }
        let Ok(rd) = std::fs::read_dir(p) else { return };
        for e in rd.flatten() {
            *budget = budget.saturating_sub(1);
            if *budget == 0 { return; }
            let Ok(ft) = e.file_type() else { continue };
            let path = e.path();
            if ft.is_symlink() && !path.to_string_lossy().contains("huggingface") { continue; }
            if path.starts_with(own) { continue; }
            let name = e.file_name().to_string_lossy().to_string();
            if (ft.is_file() || ft.is_symlink()) && engine_of(&name).is_some() { out.push(path); }
            else if ft.is_dir() && depth > 0 && !name.starts_with('.') || (ft.is_dir() && depth > 0 && (name == ".cache" || name.starts_with("models--"))) {
                if matches!(name.as_str(), "node_modules" | "Caches" | "Logs" | "CrashReporter" | "Photos" | "MobileSync") { continue; }
                walk(&path, depth - 1, own, out, budget);
            }
        }
    }
    let mut budget = 60_000;
    for (root, depth) in model_roots() { walk(&root, depth, &own, &mut found, &mut budget); }
    for src in found {
        let Some(name) = src.file_name().map(|n| n.to_string_lossy().to_string()) else { continue };
        let Some(engine) = engine_of(&name) else { continue };
        let real = src.canonicalize().unwrap_or(src.clone());
        let dest = dir.join(&name);
        if dest.exists() || !looks_like_model(&real, engine) { continue; }
        // llama.cpp-style Qwen3-ASR comes as two files (the audio encoder in an mmproj file); CrispASR needs the
        // single-file GGUF, so those (Cap's, for one) can't be used.
        if engine == "qwen3" && real.parent().and_then(|d| std::fs::read_dir(d).ok()).is_some_and(|rd| rd.flatten().any(|e| e.file_name().to_string_lossy().to_lowercase().starts_with("mmproj"))) { continue; }
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(&real, &dest);
        #[cfg(windows)]
        let _ = std::fs::hard_link(&real, &dest).or_else(|_| std::os::windows::fs::symlink_file(&real, &dest));
    }
}

/// Streams `url` into `dest` (via a .part file), reporting (received, total). Stops when `cancel` is set.
pub async fn download(url: &str, dest: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64, Option<u64>)) -> Result<()> {
    let res = net::client().get(url).send().await?;
    if !res.status().is_success() { return Err(anyhow!("下载失败（{}）", res.status().as_u16())); }
    let total = res.content_length();
    let part = dest.with_extension("part");
    if let Some(dir) = dest.parent() { tokio::fs::create_dir_all(dir).await?; }
    let mut file = tokio::fs::File::create(&part).await?;
    let mut stream = res.bytes_stream();
    let mut received = 0u64;
    let mut last = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            return Err(anyhow!("已取消"));
        }
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        received += chunk.len() as u64;
        if last.elapsed().as_millis() > 200 { progress(received, total); last = std::time::Instant::now(); }
    }
    file.flush().await?;
    drop(file);
    if let Some(t) = total { if received < t { return Err(anyhow!("下载不完整")); } }
    tokio::fs::rename(&part, dest).await?;
    progress(received, total);
    Ok(())
}

pub async fn download_model(data: &Path, id: &str, cancel: &AtomicBool, mirror_first: bool, mut progress: impl FnMut(u64, Option<u64>)) -> Result<()> {
    let m = spec(id).ok_or_else(|| anyhow!("未知模型"))?;
    let dest = models_dir(data).join(m.file);
    // Hugging Face is often unreachable from mainland China; hf-mirror.com serves the same files.
    let hosts = if mirror_first { ["hf-mirror.com", "huggingface.co"] } else { ["huggingface.co", "hf-mirror.com"] };
    let mut err = anyhow!("下载失败");
    for host in hosts {
        let url = format!("https://{host}/{}/resolve/main/{}", m.repo, m.file);
        match download(&url, &dest, cancel, &mut progress).await {
            Ok(()) => return Ok(()),
            Err(e) if cancel.load(Ordering::Relaxed) => return Err(e),
            Err(e) => err = e,
        }
    }
    Err(err)
}

// ---- yt-dlp (only for YouTube audio) -------------------------------------------------------------

fn exe(name: &str) -> String { if cfg!(windows) { format!("{name}.exe") } else { name.to_string() } }

pub fn find_ytdlp(data: &Path) -> Option<PathBuf> {
    let own = data.join("bin").join(exe("yt-dlp"));
    if own.is_file() { return Some(own); }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] { dirs.push(d.into()); }
    if let Some(h) = dirs::home_dir() { dirs.push(h.join(".local/bin")); }
    dirs.into_iter().map(|d| d.join(exe("yt-dlp"))).find(|p| p.is_file())
}

/// Our mirror of the latest release (server/deploy/sync-ytdlp.sh), reachable where GitHub is slow or blocked.
const YTDLP_MIRROR: &str = "https://subcast.qiaomu.ai/tools/yt-dlp";
const YTDLP_GITHUB: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

fn ytdlp_asset() -> &'static str {
    if cfg!(target_os = "macos") { "yt-dlp_macos" } else if cfg!(windows) { "yt-dlp.exe" } else if cfg!(target_arch = "aarch64") { "yt-dlp_linux_aarch64" } else { "yt-dlp_linux" }
}

/// Downloads yt-dlp from the mirror, else GitHub, and keeps it only if it matches that release's SHA2-256SUMS.
pub async fn install_ytdlp(data: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64, Option<u64>)) -> Result<PathBuf> {
    let name = ytdlp_asset();
    let dest = data.join("bin").join(exe("yt-dlp"));
    let mut failure = None;
    for base in [YTDLP_MIRROR, YTDLP_GITHUB] {
        match fetch_checked(base, name, &dest, cancel, &mut progress).await {
            Ok(()) => { failure = None; break; }
            Err(e) if e.to_string().contains("已取消") => return Err(e),
            Err(e) => failure = Some(e),
        }
    }
    if let Some(e) = failure { return Err(e); }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(dest)
}

async fn fetch_checked(base: &str, name: &str, dest: &Path, cancel: &AtomicBool, progress: &mut impl FnMut(u64, Option<u64>)) -> Result<()> {
    use sha2::{Digest, Sha256};
    let sums = net::get_text(&format!("{base}/SHA2-256SUMS")).await?;
    let want = sums.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let (hash, file) = (it.next()?, it.next()?);
        (file.trim_start_matches('*') == name).then(|| hash.to_lowercase())
    }).ok_or_else(|| anyhow!("校验清单里没有 {name}"))?;
    let tmp = dest.with_extension("download");
    download(&format!("{base}/{name}"), &tmp, cancel, |a, b| progress(a, b)).await?;
    let got = hex::encode(Sha256::digest(tokio::fs::read(&tmp).await?));
    if got != want {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(anyhow!("yt-dlp 校验失败（{base}）"));
    }
    tokio::fs::rename(&tmp, dest).await?;
    Ok(())
}

/// YouTube changes often and old yt-dlp builds stop working, so the app keeps its own copy (in `bin/`) and
/// refreshes it at most once a day; a failed YouTube job also forces a check and retries once.
pub async fn ytdlp(data: &Path) -> Result<PathBuf> { ytdlp_with(data, |_, _| {}).await }

/// Only one first-time install at a time: the video page prepares yt-dlp while the player may also need it.
static INSTALLING: once_cell::sync::Lazy<tokio::sync::Mutex<()>> = once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(()));

/// Like `ytdlp`, reporting the first-time download (about 35 MB) so the UI can show it.
pub async fn ytdlp_with(data: &Path, progress: impl FnMut(u64, Option<u64>)) -> Result<PathBuf> {
    let own = data.join("bin").join(exe("yt-dlp"));
    if !own.is_file() {
        let _one = INSTALLING.lock().await;
        if !own.is_file() {
            match install_ytdlp(data, &AtomicBool::new(false), progress).await {
                Ok(p) => return Ok(p),
                // GitHub unreachable: a system-wide copy (Homebrew, pip) is better than nothing.
                Err(e) => return find_ytdlp(data).ok_or(e),
            }
        }
    }
    let d = data.to_path_buf();
    tokio::spawn(async move { let _ = update_ytdlp(&d, false).await; });
    Ok(own)
}

async fn ytdlp_version(bin: &Path) -> Option<String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("--version").kill_on_drop(true);
    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); }
    let out = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await.ok()?.ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Installs the newest release when ours is older. Returns whether it changed anything.
pub async fn update_ytdlp(data: &Path, force: bool) -> Result<bool> {
    let own = data.join("bin").join(exe("yt-dlp"));
    let stamp = data.join("bin").join("yt-dlp.checked");
    let fresh = std::fs::metadata(&stamp).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_secs() < 86_400);
    if !force && fresh { return Ok(false); }
    if force && std::fs::metadata(&stamp).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_secs() < 600) {
        return Ok(false); // a forced check already ran a few minutes ago
    }
    if let Some(dir) = stamp.parent() { std::fs::create_dir_all(dir)?; }
    std::fs::write(&stamp, b"")?;
    let latest = match net::get_text(&format!("{YTDLP_MIRROR}/VERSION")).await {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => {
            let res = net::client().get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
                .header("User-Agent", "SubCast").header("Accept", "application/vnd.github+json").send().await?;
            if !res.status().is_success() { return Err(anyhow!("GitHub {}", res.status().as_u16())); }
            res.json::<serde_json::Value>().await?["tag_name"].as_str().unwrap_or_default().to_string()
        }
    };
    if latest.is_empty() { return Ok(false); }
    if own.is_file() && ytdlp_version(&own).await.as_deref() == Some(latest.as_str()) { return Ok(false); }
    install_ytdlp(data, &AtomicBool::new(false), |_, _| {}).await?;
    Ok(true)
}

/// Runs a yt-dlp job; when it fails, updates yt-dlp (if a newer one exists) and tries once more.
pub async fn with_ytdlp<T, F, Fut>(data: &Path, job: F) -> Result<T>
where F: Fn(PathBuf) -> Fut, Fut: std::future::Future<Output = Result<T>> {
    let bin = ytdlp(data).await?;
    match job(bin.clone()).await {
        Ok(v) => Ok(v),
        Err(e) if e.to_string().contains("已取消") => Err(e),
        Err(e) => match update_ytdlp(data, true).await {
            Ok(true) => job(data.join("bin").join(exe("yt-dlp"))).await,
            _ => Err(e),
        },
    }
}
/// The browser whose YouTube sign-in yt-dlp may use when YouTube asks to "confirm you're not a bot" (Settings ›
/// 通用; empty = never). Read from the browser each time, never stored by SubCast.
pub static YT_BROWSER: std::sync::RwLock<String> = std::sync::RwLock::new(String::new());

fn bot_check(msg: &str) -> bool { let m = msg.to_lowercase(); m.contains("confirm you") && m.contains("bot") || m.contains("sign in to confirm") }

/// Downloads a video's audio. When YouTube answers with its bot check, tries other YouTube clients, then (if the
/// listener allowed it) their browser's sign-in.
pub async fn youtube_audio(ytdlp: &Path, video_id: &str, dir: &Path, cancel: Arc<AtomicBool>) -> Result<PathBuf> {
    match youtube_audio_with(ytdlp, video_id, dir, cancel.clone(), &[]).await {
        Err(e) if bot_check(&e.to_string()) => {
            let alt = ["--extractor-args", "youtube:player_client=tv,web_safari,mweb"];
            match youtube_audio_with(ytdlp, video_id, dir, cancel.clone(), &alt).await {
                Err(e2) if bot_check(&e2.to_string()) => {
                    let browser = YT_BROWSER.read().unwrap().clone();
                    if browser.is_empty() {
                        return Err(anyhow!("YouTube 要求验证「不是机器人」才能下载这个视频的音频。可以在 设置 › 通用 里选择一个已登录 YouTube 的浏览器，SubCast 会借用它的登录再试；也可以直接看视频版"));
                    }
                    youtube_audio_with(ytdlp, video_id, dir, cancel, &["--cookies-from-browser", &browser]).await
                        .map_err(|e3| if bot_check(&e3.to_string()) { anyhow!("YouTube 仍然要求验证。请在 {browser} 里打开 youtube.com 确认已登录后再试") } else { e3 })
                }
                other => other,
            }
        }
        other => other,
    }
}

async fn youtube_audio_with(ytdlp: &Path, video_id: &str, dir: &Path, cancel: Arc<AtomicBool>, extra: &[&str]) -> Result<PathBuf> {
    tokio::fs::create_dir_all(dir).await?;
    let template = dir.join(format!("{video_id}.%(ext)s"));
    let mut cmd = tokio::process::Command::new(ytdlp);
    // m4a (AAC) decodes without ffmpeg; format 18 (mp4 with AAC audio) is the fallback every video has.
    cmd.args(["-f", "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/18", "--no-playlist", "--no-part"]).args(extra).arg("-o").arg(&template);
    let proxy = net::proxy();
    if !proxy.is_empty() { cmd.args(["--proxy", &proxy]); }
    cmd.arg(format!("https://www.youtube.com/watch?v={video_id}")).kill_on_drop(true).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); }
    let mut child = cmd.spawn().context("无法启动 yt-dlp")?;
    let stderr = child.stderr.take();
    let tail = tokio::spawn(async move {
        let mut text = String::new();
        if let Some(s) = stderr { let mut lines = BufReader::new(s).lines(); while let Ok(Some(l)) = lines.next_line().await { text = l; } }
        text
    });
    loop {
        if cancel.load(Ordering::Relaxed) { let _ = child.kill().await; return Err(anyhow!("已取消")); }
        if let Some(status) = child.try_wait()? {
            let last = tail.await.unwrap_or_default();
            if !status.success() {
                return Err(anyhow!("下载 YouTube 音频失败：{}", last.chars().take(200).collect::<String>()));
            }
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    let mut entries = tokio::fs::read_dir(dir).await?;
    while let Some(e) = entries.next_entry().await? {
        if e.file_name().to_string_lossy().starts_with(video_id) { return Ok(e.path()); }
    }
    Err(anyhow!("没有找到下载的音频"))
}

/// A playable address for videos whose owners block the embedded player: YouTube's HLS master playlist
/// (adaptive quality, plays natively in WebKit) or, failing that, a single file with both audio and video.
/// A stream the app's own <video> can play. `hls`: the WebView plays HLS natively (WebKit on macOS). Elsewhere
/// (WebView2, most WebKitGTK) only a progressive MP4 works: YouTube's HLS manifests send no CORS header, so
/// hls.js can't load them.
pub async fn youtube_stream_url(ytdlp: &Path, video_id: &str, hls: bool) -> Result<String> {
    let mut cmd = tokio::process::Command::new(ytdlp);
    cmd.args(["-j", "--no-playlist", "--no-warnings"]);
    let proxy = net::proxy();
    if !proxy.is_empty() { cmd.args(["--proxy", &proxy]); }
    cmd.arg(format!("https://www.youtube.com/watch?v={video_id}")).kill_on_drop(true);
    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); }
    let out = tokio::time::timeout(std::time::Duration::from_secs(60), cmd.output()).await.map_err(|_| anyhow!("获取视频地址超时"))?.context("无法启动 yt-dlp")?;
    let info: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|_| {
        anyhow!("无法获取视频地址：{}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("").chars().take(200).collect::<String>())
    })?;
    let formats = info["formats"].as_array().cloned().unwrap_or_default();
    if hls {
        if let Some(u) = formats.iter().filter(|f| f["protocol"].as_str().is_some_and(|p| p.starts_with("m3u8"))).find_map(|f| f["manifest_url"].as_str()) {
            return Ok(u.to_string());
        }
    }
    // Progressive files with both audio and video (format 18, 360p, is the one nearly every video has).
    formats.iter().rev()
        .filter(|f| f["vcodec"].as_str().is_some_and(|v| v != "none") && f["acodec"].as_str().is_some_and(|a| a != "none") && f["protocol"].as_str() == Some("https"))
        .max_by_key(|f| (f["ext"].as_str() == Some("mp4"), f["height"].as_i64().unwrap_or(0)))
        .and_then(|f| f["url"].as_str().map(str::to_string))
        .ok_or_else(|| anyhow!("这个视频没有可直接播放的格式"))
}

// ---- CrispASR (runs Qwen3-ASR) ----------------------------------------------------------------------

const CRISPASR_VERSION: &str = "v0.8.54";

fn crispasr_asset() -> Option<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) { Some("crispasr-macos-arm64.tar.gz") }
    else if cfg!(target_os = "macos") { Some("crispasr-macos-x86_64.tar.gz") }
    else if cfg!(windows) { Some("crispasr-windows-x86_64-cpu.zip") }
    else if cfg!(all(target_os = "linux", target_arch = "aarch64")) { Some("crispasr-linux-arm64.tar.gz") }
    else if cfg!(target_os = "linux") { Some("crispasr-linux-x86_64.tar.gz") }
    else { None }
}

fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() { if let Some(f) = find_file(&p, name) { return Some(f); } }
        else if p.file_name().is_some_and(|n| n == name) { return Some(p); }
    }
    None
}

pub fn find_crispasr(data: &Path) -> Option<PathBuf> {
    find_file(&data.join("bin").join(format!("crispasr-{CRISPASR_VERSION}")), &exe("crispasr"))
}

pub async fn install_crispasr(data: &Path, cancel: &AtomicBool, progress: impl FnMut(u64, Option<u64>)) -> Result<PathBuf> {
    let asset = crispasr_asset().ok_or_else(|| anyhow!("这个系统暂不支持 Qwen3-ASR"))?;
    let archive = data.join("bin").join(asset);
    download(&format!("https://github.com/CrispStrobe/CrispASR/releases/download/{CRISPASR_VERSION}/{asset}"), &archive, cancel, progress).await?;
    let dest = data.join("bin").join(format!("crispasr-{CRISPASR_VERSION}"));
    let (a, d) = (archive.clone(), dest.clone());
    tokio::task::spawn_blocking(move || -> Result<()> {
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d)?;
        let file = std::fs::File::open(&a)?;
        if a.extension().is_some_and(|e| e == "zip") {
            zip::ZipArchive::new(file)?.extract(&d)?;
        } else {
            tar::Archive::new(flate2::read::GzDecoder::new(file)).unpack(&d)?;
        }
        Ok(())
    }).await??;
    let _ = std::fs::remove_file(&archive);
    let bin = find_crispasr(data).ok_or_else(|| anyhow!("识别程序安装不完整"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(bin)
}

/// Writes 16 kHz mono samples as a 16-bit PCM WAV file (what CrispASR reads most reliably).
pub fn write_wav(path: &Path, samples: &[f32]) -> Result<()> {
    use std::io::Write;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    let data_len = (samples.len() * 2) as u32;
    f.write_all(b"RIFF")?; f.write_all(&(36 + data_len).to_le_bytes())?; f.write_all(b"WAVEfmt ")?;
    f.write_all(&16u32.to_le_bytes())?; f.write_all(&1u16.to_le_bytes())?; f.write_all(&1u16.to_le_bytes())?;
    f.write_all(&16000u32.to_le_bytes())?; f.write_all(&32000u32.to_le_bytes())?; f.write_all(&2u16.to_le_bytes())?; f.write_all(&16u16.to_le_bytes())?;
    f.write_all(b"data")?; f.write_all(&data_len.to_le_bytes())?;
    for s in samples { f.write_all(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())?; }
    f.flush()?;
    Ok(())
}

/// Windows: the app-local Visual C++ runtime the installer ships (resources/vcrt). CrispASR's release build
/// imports MSVCP140, VCRUNTIME140(_1) and VCOMP140, which PCs without the Redistributable lack.
pub static VCRT_DIR: once_cell::sync::OnceCell<PathBuf> = once_cell::sync::OnceCell::new();

/// Copies the runtime DLLs next to an executable that needs them (the first place Windows looks).
pub fn place_runtime(bin: &Path) {
    let (Some(src), Some(dir)) = (VCRT_DIR.get(), bin.parent()) else { return };
    for entry in std::fs::read_dir(src).into_iter().flatten().flatten() {
        let p = entry.path();
        if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("dll")) {
            let to = dir.join(entry.file_name());
            if !to.exists() { let _ = std::fs::copy(&p, &to); }
        }
    }
}

/// Runs Qwen3-ASR on a 16 kHz WAV. CrispASR transcribes in ~30 s slices; each slice is split into sentences.
/// Background for a recogniser, in each form one reads (built by asr_context.rs; empty when there is none).
#[derive(Default, Clone, Debug)]
pub struct AsrContext {
    /// Whisper-style initial prompt (short; the end matters most).
    pub prompt: String,
    /// Qwen3-ASR `--context`, read whole.
    pub background: String,
    /// Doubao `corpus.context` JSON string.
    pub doubao: String,
    /// Names and terms from the episode's glossary, when one was made.
    pub hotwords: Vec<String>,
}

pub async fn run_crispasr(bin: &Path, model: &Path, wav: &Path, language: &str, ctx: &AsrContext, cancel: Arc<AtomicBool>, mut on_progress: impl FnMut(f64)) -> Result<Vec<Segment>> {
    let out = wav.with_extension("");
    if cfg!(windows) { place_runtime(bin); }
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("-m").arg(model).arg("-f").arg(wav).args(["-oj", "-np", "-pp"]).arg("-of").arg(&out);
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
    cmd.args(["-t", &threads.to_string()]);
    if language == "auto" { cmd.args(["-l", "auto", "--lid-backend", "off"]); } else { cmd.args(["-l", language]); }
    // Qwen3-ASR reads --context (the show notes) and --hotwords; --prompt is whisper-only in CrispASR.
    if !ctx.background.is_empty() { cmd.arg("--context").arg(&ctx.background); }
    let words: Vec<&str> = ctx.hotwords.iter().map(|w| w.trim()).filter(|w| !w.is_empty() && !w.contains(',')).take(60).collect();
    if !words.is_empty() { cmd.arg("--hotwords").arg(words.join(",")); }
    cmd.kill_on_drop(true).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); }
    let mut child = cmd.spawn().context("无法启动 Qwen3-ASR 识别程序")?;
    let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
    let re = regex::Regex::new(r"progress\s*=\s*(\d+)%").unwrap();
    let mut tail: Vec<String> = Vec::new();
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                if let Some(c) = re.captures(&line) { on_progress(c[1].parse::<f64>().unwrap_or(0.0) / 100.0); }
                else if !line.starts_with("ggml_") { tail.push(line); if tail.len() > 6 { tail.remove(0); } }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {
                if cancel.load(Ordering::Relaxed) { let _ = child.kill().await; return Err(anyhow!("已取消")); }
            }
        }
    }
    let status = child.wait().await?;
    let json_path = out.with_extension("json");
    if !status.success() || !json_path.is_file() {
        return Err(anyhow!("Qwen3-ASR 识别失败：{}", tail.last().cloned().unwrap_or_default()));
    }
    let v: serde_json::Value = serde_json::from_str(&tokio::fs::read_to_string(&json_path).await?)?;
    let mut segs = Vec::new();
    for t in v["transcription"].as_array().into_iter().flatten() {
        let start = t["offsets"]["from"].as_f64().unwrap_or(0.0) / 1000.0;
        let end = t["offsets"]["to"].as_f64().unwrap_or(0.0) / 1000.0;
        let text = t["text"].as_str().unwrap_or("").trim();
        if !text.is_empty() { segs.extend(crate::transcript::split_timed(text, start, end)); }
    }
    Ok(segs)
}

// ---- running the worker ---------------------------------------------------------------------------

pub enum WorkerEvent {
    Progress(f64),
    Segment(Segment),
}

pub struct WorkerResult {
    pub language: String,
    pub segments: Vec<Segment>,
}

pub async fn run_worker(audio: &Path, model: &Path, language: &str, prompt: &str, cancel: Arc<AtomicBool>, mut on: impl FnMut(WorkerEvent)) -> Result<WorkerResult> {
    let me = std::env::current_exe()?;
    let mut cmd = tokio::process::Command::new(me);
    cmd.arg("--asr-worker").arg(audio).arg(model).arg(language).arg(prompt).kill_on_drop(true)
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); }
    let mut child = cmd.spawn()?;
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let stderr = child.stderr.take().unwrap();
    let errtail = tokio::spawn(async move {
        let mut tail = Vec::new();
        let mut l = BufReader::new(stderr).lines();
        while let Ok(Some(x)) = l.next_line().await { tail.push(x); if tail.len() > 8 { tail.remove(0); } }
        tail.join("\n")
    });
    let mut segments = Vec::new();
    let mut language_out = language.to_string();
    let mut error: Option<String> = None;
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                match v["type"].as_str() {
                    Some("progress") => on(WorkerEvent::Progress(v["p"].as_f64().unwrap_or(0.0))),
                    Some("segment") => {
                        let s = Segment { start: v["start"].as_f64().unwrap_or(0.0), end: v["end"].as_f64().unwrap_or(0.0), text: v["text"].as_str().unwrap_or("").trim().to_string() };
                        if !s.text.is_empty() { on(WorkerEvent::Segment(s.clone())); segments.push(s); }
                    }
                    Some("language") => language_out = v["language"].as_str().unwrap_or(language).to_string(),
                    Some("error") => error = v["message"].as_str().map(String::from),
                    _ => {}
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {
                if cancel.load(Ordering::Relaxed) { let _ = child.kill().await; return Err(anyhow!("已取消")); }
            }
        }
    }
    let status = child.wait().await?;
    let tail = errtail.await.unwrap_or_default();
    if let Some(e) = error { return Err(anyhow!(e)); }
    if !status.success() { return Err(anyhow!("转写进程异常退出：{}", tail.lines().last().unwrap_or(""))); }
    Ok(WorkerResult { language: language_out, segments })
}

// ---- the worker itself -----------------------------------------------------------------------------

fn emit(v: serde_json::Value) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

/// Decodes any mp3/m4a/aac/wav/flac/ogg file to 16 kHz mono f32, the input whisper.cpp wants.
pub fn decode_16k_mono(path: &Path) -> Result<Vec<f32>> {
    use symphonia::core::{audio::SampleBuffer, codecs::DecoderOptions, errors::Error, formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint};
    let file = std::fs::File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) { hint.with_extension(ext); }
    let probed = symphonia::default::get_probe().format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default()).map_err(|e| anyhow!("无法识别音频格式：{e}"))?;
    let mut format = probed.format;
    let track = format.tracks().iter().find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL).ok_or_else(|| anyhow!("没有音轨"))?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default()).map_err(|e| anyhow!("不支持的音频编码：{e}"))?;
    let mut rate = track.codec_params.sample_rate.unwrap_or(44100);
    let mut mono: Vec<f32> = Vec::new();
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Error::ResetRequired) => break,
            Err(e) => return Err(anyhow!("读取音频失败：{e}")),
        };
        if packet.track_id() != track_id { continue; }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(Error::DecodeError(_)) => continue,
            Err(e) => return Err(anyhow!("解码失败：{e}")),
        };
        let spec = *decoded.spec();
        rate = spec.rate;
        let channels = spec.channels.count().max(1);
        if buf.as_ref().is_none_or(|b| b.capacity() < decoded.capacity() * channels) {
            buf = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
        }
        let b = buf.as_mut().unwrap();
        b.copy_interleaved_ref(decoded);
        for frame in b.samples().chunks(channels) {
            mono.push(frame.iter().sum::<f32>() / channels as f32);
        }
    }
    Ok(resample(&mono, rate, 16000))
}

/// Box-filtered linear resampling: plenty for speech recognition.
pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() { return input.to_vec(); }
    let ratio = from as f64 / to as f64;
    let width = ratio.ceil().max(1.0) as usize;
    let filtered: Vec<f32> = if width > 1 {
        let mut acc = 0.0f32;
        let mut out = Vec::with_capacity(input.len());
        for i in 0..input.len() {
            acc += input[i];
            if i >= width { acc -= input[i - width]; }
            out.push(acc / width.min(i + 1) as f32);
        }
        out
    } else { input.to_vec() };
    let n = (input.len() as f64 / ratio) as usize;
    (0..n).map(|i| {
        let pos = i as f64 * ratio;
        let j = pos as usize;
        let frac = (pos - j as f64) as f32;
        let a = filtered[j.min(filtered.len() - 1)];
        let b = filtered[(j + 1).min(filtered.len() - 1)];
        a + (b - a) * frac
    }).collect()
}

pub fn worker_main(args: &[String]) -> i32 {
    let run = || -> Result<()> {
        let [audio, model, language, prompt] = args else { return Err(anyhow!("参数错误")) };
        let samples = decode_16k_mono(Path::new(audio))?;
        emit(serde_json::json!({"type": "progress", "p": 0.02}));
        use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
        let ctx = WhisperContext::new_with_params(model, WhisperContextParameters::default()).map_err(|e| anyhow!("加载模型失败：{e}"))?;
        let mut state = ctx.create_state().map_err(|e| anyhow!("{e}"))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8) as i32;
        params.set_n_threads(threads);
        params.set_language(if language == "auto" { None } else { Some(language.as_str()) });
        if !prompt.is_empty() { params.set_initial_prompt(prompt); }
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        // Keeps one stuck hallucination from echoing through the rest of the file.
        params.set_no_context(true);
        params.set_progress_callback_safe(|p: i32| emit(serde_json::json!({"type": "progress", "p": (p as f64 / 100.0).max(0.02)})));
        params.set_segment_callback_safe_lossy(|s: whisper_rs::SegmentCallbackData| {
            emit(serde_json::json!({"type": "segment", "start": s.start_timestamp as f64 / 100.0, "end": s.end_timestamp as f64 / 100.0, "text": s.text}));
        });
        state.full(params, &samples).map_err(|e| anyhow!("转写失败：{e}"))?;
        if let Ok(id) = state.full_lang_id_from_state() {
            if let Some(l) = whisper_rs::get_lang_str(id) { emit(serde_json::json!({"type": "language", "language": l})); }
        }
        emit(serde_json::json!({"type": "progress", "p": 1.0}));
        Ok(())
    };
    match run() {
        Ok(()) => 0,
        Err(e) => { emit(serde_json::json!({"type": "error", "message": e.to_string()})); 1 }
    }
}

#[cfg(test)]
mod scan_tests {
    use super::*;
    #[test]
    fn links_models_found_elsewhere_and_unlinks_without_touching_them() {
        let home = std::env::temp_dir().join(format!("subcast-scan-{}", uuid::Uuid::new_v4()));
        let other = home.join("OtherApp/models");
        std::fs::create_dir_all(&other).unwrap();
        let mut ggml = b"lmgg".to_vec(); ggml.resize(31 * 1_048_576, 0);
        std::fs::write(other.join("ggml-medium.bin"), &ggml).unwrap();
        std::fs::write(other.join("ggml-tiny.bin"), b"lmgg too small").unwrap();
        let mut fake = b"XXXX".to_vec(); fake.resize(31 * 1_048_576, 0);
        std::fs::write(other.join("ggml-small-q5_1.bin"), &fake).unwrap();
        let data = home.join("data");
        std::fs::create_dir_all(models_dir(&data)).unwrap();
        let mut found = Vec::new();
        // The same linking as adopt_found, rooted at the test folder.
        for e in std::fs::read_dir(&other).unwrap().flatten() { found.push(e.path()); }
        for src in found {
            let name = src.file_name().unwrap().to_string_lossy().to_string();
            let Some(engine) = engine_of(&name) else { continue };
            if looks_like_model(&src, engine) { std::os::unix::fs::symlink(&src, models_dir(&data).join(&name)).unwrap(); }
        }
        let list = list_models(&data);
        let medium = list.iter().find(|m| m.id == "file:ggml-medium.bin").expect("found model listed");
        assert!(medium.installed && medium.from.is_some(), "{:?}", medium.from);
        assert!(!list.iter().any(|m| m.id == "file:ggml-tiny.bin"), "too small is not a model");
        assert!(!list.iter().find(|m| m.id == "small").unwrap().installed, "wrong magic is not adopted");
        let r = resolve(&data, "file:ggml-medium.bin").unwrap();
        assert_eq!(r.engine, "whisper");
        std::fs::remove_file(&r.path).unwrap();
        assert!(other.join("ggml-medium.bin").is_file(), "the original stays");
        assert!(resolve(&data, "file:../x.bin").is_none());
        let _ = std::fs::remove_dir_all(&home);
    }
    /// On this computer: what a real scan finds (prints, doesn't assert).
    #[test]
    #[ignore]
    fn scan_this_computer() {
        let data = std::env::temp_dir().join(format!("subcast-scan-real-{}", uuid::Uuid::new_v4()));
        let t0 = std::time::Instant::now();
        for m in list_models(&data) { println!("{} installed={} {} from={:?}", m.id, m.installed, m.size_mb, m.from); }
        println!("scan took {:?}", t0.elapsed());
        let _ = std::fs::remove_dir_all(&data);
    }
}

