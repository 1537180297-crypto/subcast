//! Video highlight clipping & bilingual overlay rendering using yt-dlp + on-demand FFmpeg.
//!
//! Only the requested `[start, end]` range is fetched via `yt-dlp --download-sections` and cached
//! under `<data>/work/clips/<video_id>/`. Subtitles and title overlays are rendered in the WebView
//! onto transparent PNG canvases and composited by FFmpeg's `overlay` filter so every FFmpeg
//! build (even without `libass`/`drawtext`) produces crisp bilingual H.264 + AAC MP4 clips.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::asr;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub hardware_h264: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreparedClip {
    pub path: String,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub has_burned_subtitles: bool,
    pub cached: bool,
    pub frames: Vec<String>,
    pub best_frame: usize,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CueOverlay {
    pub start: f64,
    pub end: f64,
    pub y: i32,
    pub png_base64: String,
}

/// The output canvas and where the picture goes on it (computed by the dialog, which draws the overlays to match).
/// `fit`: "fill" crops the picture to cover the canvas (panned by `crop_x`), "card" fits it into the box
/// `vx,vy,vw,vh` over a blurred or plain background.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub w: u32,
    pub h: u32,
    pub fit: String,
    #[serde(default)] pub vx: u32,
    #[serde(default)] pub vy: u32,
    #[serde(default)] pub vw: u32,
    #[serde(default)] pub vh: u32,
    /// Card only: crop the picture to the box's shape (panned by `crop_x`) instead of fitting it whole.
    #[serde(default)] pub crop_box: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    #[serde(default)]
    pub frame: Option<Frame>,
    /// Where clips go unless the user picked a file (Settings › 存储); Downloads when empty.
    #[serde(default)]
    pub output_dir: Option<String>,
    pub raw_path: String,
    #[serde(default)]
    pub output_path: Option<String>,
    pub default_name: String,
    pub layout: String,
    pub card_bg: String,
    pub crop_x: f64,
    pub duration: f64,
    #[serde(default)]
    pub static_overlay_png: Option<String>,
    #[serde(default)]
    pub cues: Vec<CueOverlay>,
    #[serde(default)]
    pub cover_png: Option<String>,
    #[serde(default)]
    pub cover_mode: String,
    #[serde(default)]
    pub embed_thumbnail: bool,
    #[serde(default)]
    pub save_cover_sidecar: bool,
    #[serde(default)]
    pub landscape_cover_png: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RenderResult {
    pub video_path: String,
    pub cover_path: Option<String>,
    pub landscape_cover_path: Option<String>,
}

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

/// Finds `ffmpeg` in SubCast's own `bin/`, PATH, or standard package-manager directories.
pub fn find_ffmpeg(data: &Path) -> Option<PathBuf> {
    let name = exe("ffmpeg");
    let own = data.join("bin").join(&name);
    if own.is_file() { return Some(own); }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/opt/local/bin"] {
        dirs.push(d.into());
    }
    if let Some(h) = dirs::home_dir() { dirs.push(h.join(".local/bin")); }
    dirs.into_iter().map(|d| d.join(&name)).find(|p| p.is_file())
}

static VT_CACHE: std::sync::Mutex<Option<(PathBuf, bool)>> = std::sync::Mutex::new(None);

/// Checks whether the FFmpeg binary supports macOS hardware H.264 encoding (`h264_videotoolbox`).
pub fn has_videotoolbox(bin: &Path) -> bool {
    if !cfg!(target_os = "macos") { return false; }
    if let Some((cached, ok)) = VT_CACHE.lock().unwrap().as_ref() {
        if cached == bin { return *ok; }
    }
    let mut cmd = std::process::Command::new(bin);
    cmd.args(["-hide_banner", "-encoders"]);
    let ok = cmd.output().map(|o| {
        o.status.success() && String::from_utf8_lossy(&o.stdout).contains("h264_videotoolbox")
    }).unwrap_or(false);
    *VT_CACHE.lock().unwrap() = Some((bin.to_path_buf(), ok));
    ok
}

pub fn env_status(data: &Path) -> FfmpegStatus {
    match find_ffmpeg(data) {
        Some(bin) => {
            let hardware_h264 = has_videotoolbox(&bin);
            FfmpegStatus {
                installed: true,
                path: Some(bin.to_string_lossy().into_owned()),
                hardware_h264,
            }
        }
        None => FfmpegStatus { installed: false, path: None, hardware_h264: false },
    }
}

const FFMPEG_MIRROR: &str = "https://subcast.qiaomu.ai/tools/ffmpeg";

fn ffmpeg_urls() -> Vec<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        vec![
            "https://subcast.qiaomu.ai/tools/ffmpeg/ffmpeg-macos-arm64.zip",
            "https://www.osxexperts.net/ffmpeg711arm.zip",
        ]
    } else if cfg!(target_os = "macos") {
        vec![
            "https://subcast.qiaomu.ai/tools/ffmpeg/ffmpeg-macos-x64.zip",
            "https://evermeet.cx/ffmpeg/getrelease/zip",
        ]
    } else if cfg!(target_os = "windows") {
        vec![
            "https://subcast.qiaomu.ai/tools/ffmpeg/ffmpeg-windows-x64.zip",
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
        ]
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        vec!["https://subcast.qiaomu.ai/tools/ffmpeg/ffmpeg-linux-arm64.tar.gz"]
    } else {
        vec!["https://subcast.qiaomu.ai/tools/ffmpeg/ffmpeg-linux-x64.tar.gz"]
    }
}

static FFMPEG_INSTALL_LOCK: once_cell::sync::Lazy<tokio::sync::Mutex<()>> =
    once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(()));

/// Finds FFmpeg, or downloads a static build into `<data>/bin/` on first use.
pub async fn ensure_ffmpeg(
    data: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<PathBuf> {
    if let Some(p) = find_ffmpeg(data) { return Ok(p); }
    let _guard = FFMPEG_INSTALL_LOCK.lock().await;
    if let Some(p) = find_ffmpeg(data) { return Ok(p); }

    let _ = FFMPEG_MIRROR;
    let target_name = exe("ffmpeg");
    let dest = data.join("bin").join(&target_name);
    let tmp_dir = data.join("bin").join(".ffmpeg-dl");

    for url in ffmpeg_urls() {
        if cancel.load(Ordering::Relaxed) { bail!("已取消"); }
        let ext = if url.ends_with(".tar.gz") { "tar.gz" } else { "zip" };
        let archive = tmp_dir.join(format!("ffmpeg.{ext}"));
        let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
        if asr::download(url, &archive, cancel, |a, b| progress(a, b)).await.is_err() {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            continue;
        }
        let a = archive.clone();
        let d = dest.clone();
        let tn = target_name.clone();
        let extracted = tokio::task::spawn_blocking(move || extract_ffmpeg_archive(&a, &d, &tn)).await;
        let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
        if let Ok(Ok(())) = extracted {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
            }
            if dest.is_file() { return Ok(dest); }
        }
    }
    Err(anyhow!("未找到 ffmpeg，请先安装后重试"))
}

fn extract_ffmpeg_archive(archive: &Path, dest: &Path, bin_name: &str) -> Result<()> {
    if let Some(parent) = dest.parent() { std::fs::create_dir_all(parent)?; }
    let tmp = dest.with_extension("part");
    let file = std::fs::File::open(archive)?;
    if archive.to_string_lossy().ends_with(".tar.gz") {
        let mut ar = tar::Archive::new(flate2::read::GzDecoder::new(file));
        let mut found = false;
        for entry in ar.entries()? {
            let mut e = entry?;
            let path = e.path()?;
            if path.file_name().and_then(|n| n.to_str()) == Some(bin_name) && e.header().entry_type().is_file() {
                let mut out = std::fs::File::create(&tmp)?;
                std::io::copy(&mut e, &mut out)?;
                found = true;
                break;
            }
        }
        if !found { bail!("missing ffmpeg in tar.gz"); } // i18n-ignore
    } else {
        let mut zip = zip::ZipArchive::new(file)?;
        let mut found = false;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i)?;
            if !f.is_file() { continue; }
            let name = Path::new(f.name()).file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name == bin_name {
                let mut out = std::fs::File::create(&tmp)?;
                std::io::copy(&mut f, &mut out)?;
                found = true;
                break;
            }
        }
        if !found { bail!("missing ffmpeg in zip"); } // i18n-ignore
    }
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

pub fn safe_slug(s: &str) -> String {
    let cleaned: String = s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(64)
        .collect();
    if cleaned.is_empty() { "clip".into() } else { cleaned }
}

pub fn clips_work_dir(data: &Path, video_id: &str) -> PathBuf {
    data.join("work").join("clips").join(safe_slug(video_id))
}

fn ffmpeg_cmd(bin: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(bin);
    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); }
    cmd.kill_on_drop(true);
    cmd
}

/// Parses `Duration: HH:MM:SS.xx`, video `WxH`, and audio presence from `ffmpeg -hide_banner -i <file>` stderr.
pub fn parse_video_meta(stderr: &str) -> (f64, u32, u32, bool) {
    let dur = regex::Regex::new(r"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")
        .ok()
        .and_then(|re| re.captures(stderr))
        .and_then(|c| {
            let h: f64 = c[1].parse().ok()?;
            let m: f64 = c[2].parse().ok()?;
            let s: f64 = c[3].parse().ok()?;
            Some(h * 3600.0 + m * 60.0 + s)
        })
        .unwrap_or(0.0);

    let dims = stderr.lines()
        .find(|l| l.contains("Video:"))
        .and_then(|line| {
            regex::Regex::new(r"\b(\d{3,5})x(\d{3,5})\b").ok()?.captures(line).and_then(|c| {
                Some((c[1].parse::<u32>().ok()?, c[2].parse::<u32>().ok()?))
            })
        })
        .unwrap_or((1920, 1080));
    let has_audio = stderr.lines().any(|l| l.contains("Audio:"));
    (dur, dims.0, dims.1, has_audio)
}

pub async fn probe_video_meta(ffmpeg: &Path, path: &Path, fallback_dur: f64) -> (f64, u32, u32, bool) {
    let mut cmd = ffmpeg_cmd(ffmpeg);
    cmd.args(["-hide_banner", "-i"]).arg(path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let out = tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output()).await;
    if let Ok(Ok(o)) = out {
        let stderr = String::from_utf8_lossy(&o.stderr);
        let (d, w, h, has_audio) = parse_video_meta(&stderr);
        return (if d > 0.1 { d } else { fallback_dur }, w, h, has_audio);
    }
    (fallback_dur, 1920, 1080, true)
}

/// Detects whether the source frame already has changing burned-in captions in its lower 35% band.
/// Static watermarks/logos fail the overlap threshold because their pixels stay identical across samples.
pub fn decide_burned_subtitles(frames: &[&[u8]], width: usize, height: usize) -> bool {
    const BRIGHT: u8 = 200;
    const DARK: u8 = 80;
    const REACH: usize = 2;
    const MIN_FRAC: f64 = 0.0012;
    const MAX_OVERLAP: f64 = 0.5;

    if frames.len() < 3 || width == 0 || height == 0 { return false; }
    let left = (width as f64 * 0.15) as usize;
    let right = (width as f64 * 0.85) as usize;
    let threshold = (MIN_FRAC * (width * height) as f64) as usize;

    let mut masks: Vec<HashSet<usize>> = Vec::new();
    for &pix in frames {
        if pix.len() != width * height { continue; }
        let mut mask = HashSet::new();
        for y in 0..height {
            let row = &pix[y * width..(y + 1) * width];
            for x in left..right.min(width) {
                if row[x] < BRIGHT { continue; }
                let lo = x.saturating_sub(REACH);
                let hi = (x + REACH + 1).min(width);
                if row[lo..hi].iter().copied().min().unwrap_or(255) < DARK {
                    mask.insert(y * width + x);
                }
            }
        }
        if mask.len() >= threshold { masks.push(mask); }
    }
    if masks.len() < 3 || (masks.len() as f64) < frames.len() as f64 * 0.5 { return false; }
    let mut overlaps: Vec<f64> = masks.windows(2).map(|w| {
        let inter = w[0].intersection(&w[1]).count();
        let uni = w[0].union(&w[1]).count().max(1);
        inter as f64 / uni as f64
    }).collect();
    overlaps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    overlaps[overlaps.len() / 2] < MAX_OVERLAP
}

pub async fn detect_burned_subtitles(ffmpeg: &Path, path: &Path, duration: f64) -> bool {
    const W: usize = 480;
    const H: usize = 96;
    const SAMPLES: usize = 6;
    if duration <= 0.6 { return false; }

    let mut raw_frames: Vec<Vec<u8>> = Vec::new();
    for i in 0..SAMPLES {
        let frac = 0.08 + 0.84 * (i as f64 / (SAMPLES - 1) as f64);
        let at = duration * frac;
        let mut cmd = ffmpeg_cmd(ffmpeg);
        cmd.args(["-v", "error", "-ss", &format!("{at:.2}"), "-i"]).arg(path)
            .args([
                "-frames:v", "1",
                "-vf", &format!("crop=iw:ih*0.35:0:ih*0.65,scale={W}:{H},format=gray"),
                "-f", "rawvideo", "-",
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        if let Ok(Ok(out)) = tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await {
            if out.status.success() && out.stdout.len() == W * H {
                raw_frames.push(out.stdout);
            }
        }
    }
    let refs: Vec<&[u8]> = raw_frames.iter().map(|v| v.as_slice()).collect();
    decide_burned_subtitles(&refs, W, H)
}

/// Looks for an already-cached clip file `[cs, ce]` in `dir` that completely covers `[start_ms, end_ms]`.
pub fn find_covering_cache(dir: &Path, start_ms: u64, end_ms: u64) -> Option<(PathBuf, u64, u64)> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(PathBuf, u64, u64, u64)> = None;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("mp4") { continue; }
        let len = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        if len < 10_000 { continue; }
        let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else { continue };
        let Some((a, b)) = stem.split_once('-') else { continue };
        let (Ok(cs), Ok(ce)) = (a.parse::<u64>(), b.parse::<u64>()) else { continue };
        if cs <= start_ms && ce >= end_ms {
            let span = ce - cs;
            if best.as_ref().is_none_or(|(_, _, _, bs)| span < *bs) {
                best = Some((p, cs, ce, span));
            }
        }
    }
    best.map(|(p, cs, ce, _)| (p, cs, ce))
}

#[derive(Serialize, Deserialize)]
struct CachedMeta {
    duration: f64,
    width: u32,
    height: u32,
    has_burned_subtitles: bool,
}

#[derive(Serialize, Deserialize)]
struct CachedFrames {
    frames: Vec<String>,
    best_frame: usize,
}

/// Extracts 5 candidate still frames as base64 JPEG data URLs and picks the sharpest non-blank frame.
pub async fn extract_candidate_frames(ffmpeg: &Path, path: &Path, duration: f64) -> (Vec<String>, usize) {
    const FRACS: [f64; 5] = [0.10, 0.28, 0.48, 0.68, 0.85];
    let dur = duration.max(0.2);
    let mut frames: Vec<String> = Vec::new();
    let mut best_idx = 0usize;
    let mut best_bytes = 0usize;

    for frac in FRACS {
        let at = (dur * frac).max(0.05).min((dur - 0.08).max(0.05));
        let mut cmd = ffmpeg_cmd(ffmpeg);
        cmd.args(["-v", "error", "-ss", &format!("{at:.2}"), "-i"]).arg(path)
            .args(["-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "4", "-f", "image2pipe", "-vcodec", "mjpeg", "-"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        if let Ok(Ok(out)) = tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await {
            if out.status.success() && out.stdout.len() > 256 {
                let len = out.stdout.len();
                let b64 = base64::engine::general_purpose::STANDARD.encode(&out.stdout);
                if len > best_bytes {
                    best_bytes = len;
                    best_idx = frames.len();
                }
                frames.push(format!("data:image/jpeg;base64,{b64}"));
            }
        }
    }
    (frames, best_idx)
}

async fn finish_prepared(ffmpeg: &Path, dest: &Path, fallback_dur: f64, cached: bool) -> PreparedClip {
    let meta_path = dest.with_extension("meta.json");
    let frames_path = dest.with_extension("frames.json");

    let meta = if let Ok(raw) = tokio::fs::read_to_string(&meta_path).await {
        serde_json::from_str::<CachedMeta>(&raw).ok()
    } else {
        None
    };

    let (duration, width, height, has_burned_subtitles) = if let Some(m) = meta {
        (m.duration, m.width, m.height, m.has_burned_subtitles)
    } else {
        let (d, w, h, _) = probe_video_meta(ffmpeg, dest, fallback_dur).await;
        let burned = detect_burned_subtitles(ffmpeg, dest, d).await;
        let _ = tokio::fs::write(&meta_path, serde_json::to_string(&CachedMeta {
            duration: d, width: w, height: h, has_burned_subtitles: burned,
        }).unwrap_or_default()).await;
        (d, w, h, burned)
    };

    let (frames, best_frame) = if let Ok(raw) = tokio::fs::read_to_string(&frames_path).await {
        if let Ok(cf) = serde_json::from_str::<CachedFrames>(&raw) {
            if !cf.frames.is_empty() {
                let best = cf.best_frame.min(cf.frames.len() - 1);
                (cf.frames, best)
            } else { extract_candidate_frames(ffmpeg, dest, duration).await }
        } else {
            extract_candidate_frames(ffmpeg, dest, duration).await
        }
    } else {
        let res = extract_candidate_frames(ffmpeg, dest, duration).await;
        if !res.0.is_empty() {
            let _ = tokio::fs::write(&frames_path, serde_json::to_string(&CachedFrames {
                frames: res.0.clone(), best_frame: res.1,
            }).unwrap_or_default()).await;
        }
        res
    };

    PreparedClip {
        path: dest.to_string_lossy().into_owned(),
        duration,
        width,
        height,
        has_burned_subtitles,
        cached,
        frames,
        best_frame,
    }
}

/// Parses FFmpeg stderr progress line `... time=HH:MM:SS.xx ...` into seconds.
pub fn parse_ffmpeg_time(line: &str) -> Option<f64> {
    let idx = line.find("time=")?;
    let rest = line[idx + 5..].trim_start();
    let token = rest.split_whitespace().next()?;
    let mut parts = token.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

async fn run_ffmpeg_with_progress(
    ffmpeg: &Path,
    work_dir: Option<&Path>,
    args: &[String],
    total_dur: f64,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(f64),
) -> Result<()> {
    let mut cmd = ffmpeg_cmd(ffmpeg);
    if let Some(d) = work_dir { cmd.current_dir(d); }
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().context("无法启动 ffmpeg")?;
    let mut stderr = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut tail: Vec<String> = Vec::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            return Err(anyhow!("已取消"));
        }
        tokio::select! {
            line = stderr.next_line() => {
                match line {
                    Ok(Some(l)) => {
                        if let Some(sec) = parse_ffmpeg_time(&l) {
                            if total_dur > 0.1 { on_progress((sec / total_dur).clamp(0.0, 0.99)); }
                        }
                        if !l.trim().is_empty() {
                            tail.push(l);
                            if tail.len() > 10 { tail.remove(0); }
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {
                if cancel.load(Ordering::Relaxed) {
                    let _ = child.kill().await;
                    return Err(anyhow!("已取消"));
                }
            }
        }
    }
    let status = child.wait().await?;
    if !status.success() {
        let msg = tail.last().cloned().unwrap_or_default();
        return Err(anyhow!("视频处理失败：{}", msg.chars().take(180).collect::<String>()));
    }
    Ok(())
}

/// Separate video and audio (each starting a little before the stretch) as one exact-length MP4: one encode,
/// hardware H.264 at a generous bitrate since the export encodes once more.
pub async fn encode_exact(ffmpeg: &Path, video: &Path, v_ss: f64, audio: &Path, a_ss: f64, dur: f64, dest: &Path, cancel: &AtomicBool) -> Result<()> {
    let tmp = dest.with_extension("part.mp4");
    for hw in [has_videotoolbox(ffmpeg), false] {
        let mut args: Vec<String> = vec![
            "-y".into(), "-ss".into(), format!("{:.3}", v_ss.max(0.0)), "-i".into(), video.to_string_lossy().into_owned(),
            "-ss".into(), format!("{:.3}", a_ss.max(0.0)), "-i".into(), audio.to_string_lossy().into_owned(),
            "-t".into(), format!("{dur:.3}"), "-map".into(), "0:v:0".into(), "-map".into(), "1:a:0".into(),
            "-vf".into(), "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p".into(),
        ];
        if hw { args.extend(["-c:v".into(), "h264_videotoolbox".into(), "-b:v".into(), "12M".into()]); }
        else { args.extend(["-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(), "-crf".into(), "18".into()]); }
        args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into(), "-movflags".into(), "+faststart".into(), tmp.to_string_lossy().into_owned()]);
        match run_ffmpeg_with_progress(ffmpeg, None, &args, dur, cancel, |_| {}).await {
            Ok(()) => { tokio::fs::rename(&tmp, dest).await?; return Ok(()); }
            Err(e) if cancel.load(Ordering::Relaxed) || !hw => { let _ = tokio::fs::remove_file(&tmp).await; return Err(e); }
            Err(_) => { let _ = tokio::fs::remove_file(&tmp).await; }
        }
    }
    unreachable!()
}

/// Encodes `input` (optionally trimmed by `trim_ss` / `trim_t`) into a standard H.264/yuv420p/AAC MP4.
async fn normalize_mp4(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    trim: Option<(f64, f64)>,
    total_dur: f64,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(f64),
) -> Result<()> {
    let tmp = output.with_extension("part.mp4");
    let _ = tokio::fs::remove_file(&tmp).await;
    let use_vt = has_videotoolbox(ffmpeg);

    for attempt in [use_vt, false] {
        let mut args = vec!["-y".into()];
        if let Some((ss, dur)) = trim {
            args.extend(["-ss".into(), format!("{ss:.3}"), "-i".into(), input.to_string_lossy().into_owned(), "-t".into(), format!("{dur:.3}")]);
        } else {
            args.extend(["-i".into(), input.to_string_lossy().into_owned()]);
        }
        args.extend(["-vf".into(), "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p".into()]);
        if attempt {
            args.extend(["-c:v".into(), "h264_videotoolbox".into(), "-b:v".into(), "5000k".into()]);
        } else {
            args.extend(["-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(), "-crf".into(), "20".into()]);
        }
        args.extend([
            "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into(),
            "-movflags".into(), "+faststart".into(),
            tmp.to_string_lossy().into_owned(),
        ]);
        match run_ffmpeg_with_progress(ffmpeg, None, &args, total_dur, cancel, &mut on_progress).await {
            Ok(()) => {
                tokio::fs::rename(&tmp, output).await?;
                return Ok(());
            }
            Err(e) if cancel.load(Ordering::Relaxed) || !attempt => {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(e);
            }
            Err(_) => {
                let _ = tokio::fs::remove_file(&tmp).await;
            }
        }
    }
    unreachable!()
}

async fn download_youtube_section(
    ytdlp: &Path,
    ffmpeg: &Path,
    video_id: &str,
    start: f64,
    end: f64,
    dir: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    asr::with_bot_fallback(|extra| {
        let c = cancel.clone();
        async move {
            let x: Vec<&str> = extra.iter().map(String::as_str).collect();
            download_youtube_section_once(ytdlp, ffmpeg, video_id, start, end, dir, c, &x).await
        }
    }).await
}

async fn download_youtube_section_once(
    ytdlp: &Path,
    ffmpeg: &Path,
    video_id: &str,
    start: f64,
    end: f64,
    dir: &Path,
    cancel: Arc<AtomicBool>,
    extra: &[&str],
) -> Result<PathBuf> {
    tokio::fs::create_dir_all(dir).await?;
    let tag = format!("raw-{}", uuid::Uuid::new_v4().simple());
    let tpl = dir.join(format!("{tag}.%(ext)s"));
    let mut cmd = asr::ytdlp_command(ytdlp);
    let section = format!("*{start:.2}-{end:.2}");
    cmd.args([
        "--download-sections", &section,
        "--force-keyframes-at-cuts",
        "--ffmpeg-location", &ffmpeg.to_string_lossy(),
        "-f", "bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        "--merge-output-format", "mp4",
        "--no-playlist",
        "--no-part",
    ])
    .args(extra)
    .arg("-o").arg(&tpl)
    .arg(format!("https://www.youtube.com/watch?v={video_id}"))
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().context("无法启动 yt-dlp")?;
    let stderr = child.stderr.take();
    let tail = tokio::spawn(async move {
        let mut text = String::new();
        if let Some(s) = stderr {
            let mut lines = BufReader::new(s).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if !l.trim().is_empty() { text = l; }
            }
        }
        text
    });
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            return Err(anyhow!("已取消"));
        }
        if let Some(status) = child.try_wait()? {
            let last = tail.await.unwrap_or_default();
            if !status.success() {
                return Err(anyhow!("获取视频片段失败：{}", last.chars().take(180).collect::<String>()));
            }
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    let mut rd = tokio::fs::read_dir(dir).await?;
    while let Some(e) = rd.next_entry().await? {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with(&tag) && !name.ends_with(".part") {
            return Ok(e.path());
        }
    }
    Err(anyhow!("没有找到下载的视频片段"))
}

/// Several stretches of one video cut together in order (a montage): each is fetched (and cached) on its own,
/// then joined with one encode. Burned-in subtitle detection and frames come from the joined file.
pub async fn prepare_montage(
    data: &Path,
    video_id: &str,
    ranges: &[(f64, f64)],
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(&str, f64, &str),
) -> Result<PreparedClip> {
    if ranges.len() < 2 { bail!("片段时间范围无效"); }
    let dir = clips_work_dir(data, video_id);
    tokio::fs::create_dir_all(&dir).await?;
    let key: String = ranges.iter().map(|(a, b)| format!("{}-{}", (a * 1000.0).round() as u64, (b * 1000.0).round() as u64)).collect::<Vec<_>>().join("_");
    let dest = dir.join(format!("montage-{:x}.mp4", { use std::hash::{Hash, Hasher}; let mut h = std::collections::hash_map::DefaultHasher::new(); key.hash(&mut h); h.finish() }));
    let total: f64 = ranges.iter().map(|(a, b)| b - a).sum();
    let ffmpeg = ensure_ffmpeg(data, &cancel, |_, _| {}).await?;
    if dest.is_file() && std::fs::metadata(&dest).map(|m| m.len() > 10_000).unwrap_or(false) {
        on_progress("done", 1.0, "已复用缓存片段");
        return Ok(finish_prepared(&ffmpeg, &dest, total, true).await);
    }
    let n = ranges.len() as f64;
    let mut paths = Vec::new();
    for (k, &(a, b)) in ranges.iter().enumerate() {
        let base = k as f64 / n;
        let part = prepare_segment(data, video_id, a, b, cancel.clone(), |stage, p, m| {
            if stage != "done" { on_progress("download", (base + p / n) * 0.85, m); }
        }).await?;
        paths.push(PathBuf::from(part.path));
    }
    on_progress("trim", 0.88, "正在拼接片段…");
    let tmp = dest.with_extension("part.mp4");
    let mut args: Vec<String> = vec!["-y".into()];
    for p in &paths { args.extend(["-i".into(), p.to_string_lossy().into_owned()]); }
    // Same size for every part (they come from one video), then one concat.
    let mut graph = String::new();
    for k in 0..paths.len() { graph.push_str(&format!("[{k}:v]setsar=1,format=yuv420p[v{k}];")); }
    for k in 0..paths.len() { graph.push_str(&format!("[v{k}][{k}:a]")); }
    graph.push_str(&format!("concat=n={}:v=1:a=1[v][a]", paths.len()));
    args.extend(["-filter_complex".into(), graph, "-map".into(), "[v]".into(), "-map".into(), "[a]".into()]);
    if has_videotoolbox(&ffmpeg) { args.extend(["-c:v".into(), "h264_videotoolbox".into(), "-b:v".into(), "12M".into()]); }
    else { args.extend(["-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(), "-crf".into(), "18".into()]); }
    args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into(), "-movflags".into(), "+faststart".into(), tmp.to_string_lossy().into_owned()]);
    run_ffmpeg_with_progress(&ffmpeg, None, &args, total, &cancel, |p| on_progress("trim", 0.88 + p * 0.1, "正在拼接片段…")).await?;
    tokio::fs::rename(&tmp, &dest).await?;
    on_progress("done", 1.0, "片段已就绪");
    Ok(finish_prepared(&ffmpeg, &dest, total, false).await)
}

/// Fetches (or reuses cached) `[start, end]` raw H.264 clip for `video_id`.
pub async fn prepare_segment(
    data: &Path,
    video_id: &str,
    start: f64,
    end: f64,
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(&str, f64, &str),
) -> Result<PreparedClip> {
    if !(end > start) || end - start < 0.5 || end - start > 900.0 {
        bail!("片段时间范围无效");
    }
    let start = start.max(0.0);
    let dur = end - start;
    let start_ms = (start * 1000.0).round() as u64;
    let end_ms = (end * 1000.0).round() as u64;

    let dir = clips_work_dir(data, video_id);
    tokio::fs::create_dir_all(&dir).await?;
    let dest = dir.join(format!("{start_ms}-{end_ms}.mp4"));
    // One fetch per file at a time: a background prefetch and the user's own click on the same clip share it.
    let lock = {
        static LOCKS: once_cell::sync::Lazy<std::sync::Mutex<std::collections::HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> = once_cell::sync::Lazy::new(Default::default);
        LOCKS.lock().unwrap().entry(dest.clone()).or_default().clone()
    };
    let _held = lock.lock().await;

    on_progress("ffmpeg", 0.05, "正在检查视频工具…");
    let ffmpeg = ensure_ffmpeg(data, &cancel, |got, total| {
        let pct = total.map(|t| (got as f64 / t.max(1) as f64) * 0.2).unwrap_or(0.08);
        on_progress("ffmpeg", pct, "正在准备视频导出组件（首次使用需要下载）…");
    }).await?;

    if dest.is_file() && std::fs::metadata(&dest).map(|m| m.len() > 10_000).unwrap_or(false) {
        on_progress("done", 1.0, "已复用缓存片段");
        return Ok(finish_prepared(&ffmpeg, &dest, dur, true).await);
    }

    if let Some((parent, cs, _ce)) = find_covering_cache(&dir, start_ms, end_ms) {
        let ss = (start_ms - cs) as f64 / 1000.0;
        on_progress("trim", 0.3, "正在从缓存片段截取…");
        normalize_mp4(&ffmpeg, &parent, &dest, Some((ss, dur)), dur, &cancel, |p| {
            on_progress("trim", 0.3 + p * 0.65, "正在整理视频画面…");
        }).await?;
        on_progress("done", 1.0, "片段已就绪");
        return Ok(finish_prepared(&ffmpeg, &dest, dur, true).await);
    }

    // Fast path: only this stretch's bytes, over parallel connections (fastclip.rs). Falls back to yt-dlp's own
    // section download when the format has no index or anything else goes wrong.
    on_progress("download", 0.1, "正在获取这一段原视频…");
    if let Ok(bin) = asr::ytdlp(data).await {
        let fast = crate::fastclip::fetch_section(data, &bin, &ffmpeg, video_id, start, end, &dest, cancel.clone(), |p, m| on_progress("download", 0.1 + p * 0.85, m)).await;
        match fast {
            Ok(()) => {
                on_progress("done", 1.0, "片段已就绪");
                return Ok(finish_prepared(&ffmpeg, &dest, dur, false).await);
            }
            Err(e) if cancel.load(Ordering::Relaxed) => return Err(e),
            Err(e) => eprintln!("fast section download failed, using yt-dlp: {e}"),
        }
    }
    on_progress("download", 0.15, "正在获取这一段原视频…");
    let raw = asr::with_ytdlp(data, |bin| {
        let (ff, vid, d, c) = (ffmpeg.clone(), video_id.to_string(), dir.clone(), cancel.clone());
        async move { download_youtube_section(&bin, &ff, &vid, start, end, &d, c).await }
    }).await?;

    on_progress("trim", 0.65, "正在标准化片段画面…");
    let norm = normalize_mp4(&ffmpeg, &raw, &dest, None, dur, &cancel, |p| {
        on_progress("trim", 0.65 + p * 0.3, "正在标准化片段画面…");
    }).await;
    let _ = tokio::fs::remove_file(&raw).await;
    norm?;
    on_progress("done", 1.0, "片段已就绪");
    Ok(finish_prepared(&ffmpeg, &dest, dur, false).await)
}

/// Builds the FFmpeg `-filter_complex` graph for layout framing + static overlay + timed cue PNGs + optional cover intro.
pub fn build_filter_script(
    layout: &str,
    card_bg: &str,
    crop_x: f64,
    frame: Option<&Frame>,
    has_static: bool,
    cues: &[(f64, f64, i32)],
    cover_mode: &str,
    cover_input_idx: Option<usize>,
    has_audio: bool,
) -> String {
    let cx = crop_x.clamp(0.0, 1.0);
    let mut parts: Vec<String> = Vec::new();
    let even = |v: u32| (v / 2 * 2).max(2);

    if let Some(f) = frame {
        let (w, h) = (even(f.w), even(f.h));
        if f.fit == "card" {
            // Background blurred at quarter size (as good to the eye, ~7x cheaper than blurring the full frame).
            let bg = match card_bg {
                "blur" => format!("[bg]scale={qw}:{qh}:force_original_aspect_ratio=increase,crop={qw}:{qh},boxblur=6:2,eq=brightness=-0.22:saturation=0.85,scale={w}:{h},setsar=1[bg2]", qw = even(w / 4), qh = even(h / 4)),
                other => {
                    let hex = match other { "paper" => "#f5f2eb", "white" => "#ffffff", _ => "#141315" };
                    format!("[bg]scale={w}:{h},drawbox=x=0:y=0:w=iw:h=ih:color={hex}:t=fill,setsar=1[bg2]")
                }
            };
            let (vw, vh) = (even(f.vw.max(2)), even(f.vh.max(2)));
            let fg = if f.crop_box {
                format!("[fg]scale={vw}:{vh}:force_original_aspect_ratio=increase,crop={vw}:{vh}:(iw-{vw})*{cx:.4}:(ih-{vh})/2,setsar=1[fg2]")
            } else {
                format!("[fg]scale={vw}:{vh}:force_original_aspect_ratio=decrease,setsar=1[fg2]")
            };
            parts.push(format!(
                "[0:v]split[fg][bg];{bg};{fg};[bg2][fg2]overlay={vx}+({vw}-w)/2:{vy}+({vh}-h)/2[base]",
                vx = f.vx, vy = f.vy
            ));
        } else {
            parts.push(format!(
                "[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}:(iw-{w})*{cx:.4}:(ih-{h})/2,setsar=1[base]"
            ));
        }
    } else {
    match layout {
        "portrait_card" => {
            if card_bg == "blur" {
                parts.push(
                    "[0:v]split[fg][bg];\
                     [bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=6:2,eq=brightness=-0.22:saturation=0.85,scale=1080:1920,setsar=1[bg2];\
                     [fg]scale=1080:640:force_original_aspect_ratio=decrease,setsar=1[fg2];\
                     [bg2][fg2]overlay=(W-w)/2:560+(640-h)/2[base]".into()
                );
            } else {
                let hex = if card_bg == "paper" { "#f5f2eb" } else { "#141315" };
                parts.push(format!(
                    "[0:v]split[fg][bg];\
                     [bg]scale=1080:1920,drawbox=x=0:y=0:w=iw:h=ih:color={hex}:t=fill,setsar=1[bg2];\
                     [fg]scale=1032:620:force_original_aspect_ratio=decrease,setsar=1[fg2];\
                     [bg2][fg2]overlay=(W-w)/2:568+(620-h)/2[base]"
                ));
            }
        }
        "portrait_fill" => {
            parts.push(format!(
                "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-1080)*{cx:.4}:(ih-1920)/2,setsar=1[base]"
            ));
        }
        _ => {
            parts.push(
                "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1[base]".into()
            );
        }
    }
    }

    let mut cur = "base".to_string();
    let mut next_input = 1usize;

    if has_static {
        parts.push(format!("[{cur}][{next_input}:v]overlay=0:0:eof_action=repeat:format=auto[v0]"));
        cur = "v0".into();
        next_input += 1;
    }

    for (idx, &(s, e, y)) in cues.iter().enumerate() {
        let out_label = format!("vc{idx}");
        let start = s.max(0.0);
        let end = e.max(start + 0.05);
        parts.push(format!(
            "[{cur}][{next_input}:v]overlay=0:{y}:enable='between(t,{start:.3},{end:.3})':eof_action=repeat:format=auto[{out_label}]"
        ));
        cur = out_label;
        next_input += 1;
    }

    match (cover_input_idx, cover_mode) {
        (Some(cidx), "flash") => {
            parts.push(format!(
                "[{cur}][{cidx}:v]overlay=0:0:enable='lt(t,0.140)':eof_action=repeat:format=auto,format=yuv420p[vout]"
            ));
        }
        (Some(cidx), "hold") => {
            parts.push(format!(
                "[{cur}]tpad=start_duration=1.000:start_mode=clone[vtpad];\
                 [vtpad][{cidx}:v]overlay=0:0:enable='lt(t,1.000)':eof_action=repeat:format=auto,format=yuv420p[vout]"
            ));
            if has_audio {
                parts.push("[0:a]adelay=1000:all=1[aout]".into());
            }
        }
        _ => {
            parts.push(format!("[{cur}]format=yuv420p[vout]"));
        }
    }

    parts.join(";")
}

fn decode_png_base64(raw: &str) -> Result<Vec<u8>> {
    let trimmed = raw.trim();
    let b64 = trimmed.strip_prefix("data:image/png;base64,").unwrap_or(trimmed);
    base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| anyhow!("PNG 解码失败：{e}")) // i18n-ignore
}

/// A free `<name>.mp4` in `dir` (the folder set in Settings), or else the Downloads folder.
fn default_mp4_path(name: &str, dir: Option<&str>) -> Result<PathBuf> {
    let dir = match dir.map(str::trim).filter(|d| !d.is_empty()).map(PathBuf::from).filter(|d| d.is_dir()) {
        Some(d) => d,
        None => dirs::download_dir().or_else(dirs::desktop_dir).ok_or_else(|| anyhow!("找不到下载文件夹"))?,
    };
    let safe: String = name.chars().filter(|c| !"/\\:*?\"<>|\0".contains(*c)).take(80).collect();
    let safe = safe.trim();
    let base = if safe.is_empty() { "SubCast 切片" } else { safe }; // i18n-ignore
    let mut path = dir.join(format!("{base}.mp4"));
    let mut i = 2usize;
    while path.exists() {
        path = dir.join(format!("{base} {i}.mp4"));
        i += 1;
    }
    Ok(path)
}

fn sidecar_png_path(mp4_path: &Path, suffix: &str) -> PathBuf {
    let parent = mp4_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = mp4_path.file_stem().and_then(|s| s.to_str()).unwrap_or("clip");
    parent.join(format!("{stem}{suffix}.png"))
}

/// Composites layout framing, static overlay PNG, timed subtitle cue PNGs, cover intro/thumbnail, and sidecar PNGs.
pub async fn render_clip(
    data: &Path,
    req: RenderRequest,
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(&str, f64, &str),
) -> Result<RenderResult> {
    let raw_path = PathBuf::from(&req.raw_path);
    if !raw_path.is_file() { bail!("找不到源视频片段，请先重新获取"); }

    on_progress("ffmpeg", 0.04, "正在准备视频导出组件…");
    let ffmpeg = ensure_ffmpeg(data, &cancel, |got, total| {
        let pct = total.map(|t| (got as f64 / t.max(1) as f64) * 0.15).unwrap_or(0.06);
        on_progress("ffmpeg", pct, "正在准备视频导出组件（首次使用需要下载）…");
    }).await?;

    let final_out = match req.output_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => default_mp4_path(&req.default_name, req.output_dir.as_deref())?,
    };
    if let Some(parent) = final_out.parent() { tokio::fs::create_dir_all(parent).await?; }

    let cover_bytes = req.cover_png.as_deref().filter(|s| !s.is_empty()).map(decode_png_base64).transpose()?;
    let landscape_cover_bytes = req.landscape_cover_png.as_deref().filter(|s| !s.is_empty()).map(decode_png_base64).transpose()?;

    let work_dir = data.join("work").join(format!("render-{}", uuid::Uuid::new_v4().simple()));
    tokio::fs::create_dir_all(&work_dir).await?;

    let res = render_into(&ffmpeg, &raw_path, &work_dir, &final_out, &req, cover_bytes.as_deref(), &cancel, &mut on_progress).await;
    let _ = tokio::fs::remove_dir_all(&work_dir).await;
    res?;

    let mut cover_path = None;
    if req.save_cover_sidecar {
        if let Some(bytes) = cover_bytes.as_deref() {
            let cp = sidecar_png_path(&final_out, "-封面"); // i18n-ignore (filename suffix)
            tokio::fs::write(&cp, bytes).await?;
            cover_path = Some(cp.to_string_lossy().into_owned());
        }
    }
    let mut landscape_cover_path = None;
    if let Some(bytes) = landscape_cover_bytes.as_deref() {
        let lp = sidecar_png_path(&final_out, "-横版封面"); // i18n-ignore (filename suffix)
        tokio::fs::write(&lp, bytes).await?;
        landscape_cover_path = Some(lp.to_string_lossy().into_owned());
    }

    on_progress("done", 1.0, "导出完成");
    Ok(RenderResult {
        video_path: final_out.to_string_lossy().into_owned(),
        cover_path,
        landscape_cover_path,
    })
}

async fn render_into(
    ffmpeg: &Path,
    raw_path: &Path,
    work_dir: &Path,
    final_out: &Path,
    req: &RenderRequest,
    cover_bytes: Option<&[u8]>,
    cancel: &AtomicBool,
    on_progress: &mut impl FnMut(&str, f64, &str),
) -> Result<()> {
    let mut input_names: Vec<String> = Vec::new();
    let has_static = if let Some(png) = req.static_overlay_png.as_deref().filter(|s| !s.is_empty()) {
        tokio::fs::write(work_dir.join("s.png"), decode_png_base64(png)?).await?;
        input_names.push("s.png".into());
        true
    } else {
        false
    };

    let mut cue_meta: Vec<(f64, f64, i32)> = Vec::with_capacity(req.cues.len());
    for (idx, cue) in req.cues.iter().enumerate() {
        let name = format!("c{idx}.png");
        tokio::fs::write(work_dir.join(&name), decode_png_base64(&cue.png_base64)?).await?;
        input_names.push(name);
        cue_meta.push((cue.start, cue.end, cue.y));
    }

    let cover_mode = req.cover_mode.as_str();
    let need_cover_input = cover_bytes.is_some() && (matches!(cover_mode, "flash" | "hold") || req.embed_thumbnail);
    let cover_input_idx = if need_cover_input {
        tokio::fs::write(work_dir.join("cover.png"), cover_bytes.unwrap()).await?;
        input_names.push("cover.png".into());
        Some(input_names.len())
    } else {
        None
    };

    let (_, _, _, has_audio) = probe_video_meta(ffmpeg, raw_path, req.duration).await;
    let filter = build_filter_script(
        &req.layout,
        &req.card_bg,
        req.crop_x,
        req.frame.as_ref(),
        has_static,
        &cue_meta,
        cover_mode,
        cover_input_idx,
        has_audio,
    );
    let tmp_out = work_dir.join("out.mp4");
    let use_vt = has_videotoolbox(ffmpeg);
    let dur = req.duration.max(1.0) + if cover_input_idx.is_some() && cover_mode == "hold" { 1.0 } else { 0.0 };

    on_progress("render", 0.12, "正在烧录双语字幕并合成 MP4…");

    for attempt in [use_vt, false] {
        let mut args: Vec<String> = vec!["-y".into(), "-i".into(), raw_path.to_string_lossy().into_owned()];
        for name in &input_names {
            args.push("-i".into());
            args.push(name.clone());
        }
        let audio_map = if cover_input_idx.is_some() && cover_mode == "hold" && has_audio {
            "[aout]"
        } else {
            "0:a?"
        };
        args.extend([
            "-filter_complex".into(), filter.clone(),
            "-map".into(), "[vout]".into(),
            "-map".into(), audio_map.into(),
        ]);
        if attempt {
            args.extend(["-c:v:0".into(), "h264_videotoolbox".into(), "-b:v:0".into(), "10M".into(), "-maxrate:v:0".into(), "14M".into(), "-bufsize:v:0".into(), "20M".into()]);
        } else {
            args.extend(["-c:v:0".into(), "libx264".into(), "-preset".into(), "veryfast".into(), "-crf".into(), "19".into()]);
        }
        if let Some(cidx) = cover_input_idx.filter(|_| req.embed_thumbnail) {
            args.extend([
                "-map".into(), format!("{cidx}:v"),
                "-c:v:1".into(), "mjpeg".into(),
                "-q:v:1".into(), "3".into(),
                "-disposition:v:1".into(), "attached_pic".into(),
            ]);
        }
        args.extend([
            "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into(),
            "-movflags".into(), "+faststart".into(),
            tmp_out.to_string_lossy().into_owned(),
        ]);

        match run_ffmpeg_with_progress(ffmpeg, Some(work_dir), &args, dur, cancel, |p| {
            on_progress("render", 0.12 + p * 0.85, "正在烧录双语字幕并合成 MP4…");
        }).await {
            Ok(()) => {
                // Rename across directories falls back to copy + remove if final_out is on another volume.
                if tokio::fs::rename(&tmp_out, final_out).await.is_err() {
                    tokio::fs::copy(&tmp_out, final_out).await?;
                }
                return Ok(());
            }
            Err(e) if cancel.load(Ordering::Relaxed) || !attempt => {
                let _ = tokio::fs::remove_file(&tmp_out).await;
                return Err(e);
            }
            Err(_) => {
                let _ = tokio::fs::remove_file(&tmp_out).await;
            }
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_script_variants() {
        let l = build_filter_script("landscape", "blur", 0.5, None, true, &[(0.5, 2.0, 820)], "flash", Some(3), true);
        assert!(l.contains("scale=1920:1080"));
        assert!(l.contains("[base][1:v]overlay=0:0:eof_action=repeat:format=auto[v0]"));
        assert!(l.contains("[v0][2:v]overlay=0:820:enable='between(t,0.500,2.000)'"));
        assert!(l.contains("[3:v]overlay=0:0:enable='lt(t,0.140)'"));
        assert!(l.ends_with("format=yuv420p[vout]"));

        let c_blur = build_filter_script("portrait_card", "blur", 0.5, None, false, &[(0.0, 1.5, 1300)], "hold", Some(2), true);
        assert!(c_blur.contains("boxblur=6:2"));
        assert!(c_blur.contains("[base][1:v]overlay=0:1300"));
        assert!(c_blur.contains("tpad=start_duration=1.000:start_mode=clone"));
        assert!(c_blur.contains("[0:a]adelay=1000:all=1[aout]"));

        let c_hold_silent = build_filter_script("portrait_card", "night", 0.5, None, true, &[], "hold", Some(2), false);
        assert!(c_hold_silent.contains("color=#141315:t=fill"));
        assert!(c_hold_silent.contains("tpad=start_duration=1.000"));
        assert!(!c_hold_silent.contains("adelay="));

        let c_paper = build_filter_script("portrait_card", "paper", 0.5, None, false, &[], "none", None, false);
        assert!(c_paper.contains("color=#f5f2eb:t=fill"));

        let fill = build_filter_script("portrait_fill", "blur", 0.25, None, false, &[], "none", None, true);
        let card = Frame { w: 1080, h: 1440, fit: "card".into(), vx: 0, vy: 380, vw: 1080, vh: 608, crop_box: false };
        let g = build_filter_script("x", "blur", 0.5, Some(&card), false, &[], "none", None, true);
        assert!(g.contains("scale=270:360") && g.contains("scale=1080:1440") && g.contains("overlay=0+(1080-w)/2:380+(608-h)/2[base]"), "{g}");
        let sq = Frame { w: 1080, h: 1080, fit: "fill".into(), vx: 0, vy: 0, vw: 0, vh: 0, crop_box: false };
        let zoomed = Frame { w: 1080, h: 1920, fit: "card".into(), vx: 0, vy: 560, vw: 1080, vh: 810, crop_box: true };
        assert!(build_filter_script("x", "night", 0.7, Some(&zoomed), false, &[], "none", None, true).contains("crop=1080:810:(iw-1080)*0.7000"));
        assert!(build_filter_script("x", "blur", 0.3, Some(&sq), false, &[], "none", None, true).contains("crop=1080:1080:(iw-1080)*0.3000"));
        assert!(fill.contains("crop=1080:1920:(iw-1080)*0.2500:(ih-1920)/2"));
    }

    #[test]
    fn parse_meta_and_time() {
        let stderr = "\
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':
  Duration: 00:01:23.45, start: 0.000000, bitrate: 1543 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 1280x720 [SAR 1:1 DAR 16:9], 30 fps
  Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo, fltp
";
        let (d, w, h, has_audio) = parse_video_meta(stderr);
        assert!((d - 83.45).abs() < 0.01);
        assert_eq!((w, h), (1280, 720));
        assert!(has_audio);
        assert!((parse_ffmpeg_time("frame=  120 fps= 60 q=-0.0 size= 256kB time=00:00:04.25 bitrate= 493.2kbits/s").unwrap() - 4.25).abs() < 0.001);
    }

    #[test]
    fn burned_sub_detector() {
        let w = 100usize;
        let h = 40usize;
        // Static corner watermark at same coordinates in all frames -> overlap = 1.0 -> false
        let mut static_frame = vec![100u8; w * h];
        for y in 5..12 {
            for x in 20..30 {
                static_frame[y * w + x] = 240;
            }
            static_frame[y * w + 19] = 10;
        }
        assert!(!decide_burned_subtitles(&[&static_frame, &static_frame, &static_frame], w, h));

        // Shifting bright outlined glyphs across frames -> overlap < 0.5 -> true
        let make_sub = |x_off: usize| -> Vec<u8> {
            let mut f = vec![110u8; w * h];
            for y in 24..34 {
                for x in x_off..x_off + 20 {
                    f[y * w + x] = 245;
                }
                f[y * w + x_off - 1] = 15;
            }
            f
        };
        let f1 = make_sub(18);
        let f2 = make_sub(42);
        let f3 = make_sub(62);
        assert!(decide_burned_subtitles(&[&f1, &f2, &f3], w, h));
    }

    #[test]
    fn covering_cache_picks_tightest() {
        let d = std::env::temp_dir().join(format!("subcast-cache-match-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("10000-90000.mp4"), vec![0u8; 20_000]).unwrap();
        std::fs::write(d.join("20000-50000.mp4"), vec![0u8; 20_000]).unwrap();
        let hit = find_covering_cache(&d, 22000, 45000).unwrap();
        assert_eq!((hit.1, hit.2), (20000, 50000));
        assert!(find_covering_cache(&d, 5000, 45000).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    fn minimal_rgba_png_b64(w: u32, h: u32, r: u8, g: u8, b: u8, a: u8) -> String {
        use flate2::{write::ZlibEncoder, Compression};
        use std::io::Write;
        let mut raw = Vec::with_capacity((w as usize * 4 + 1) * h as usize);
        for _ in 0..h {
            raw.push(0);
            for _ in 0..w { raw.extend_from_slice(&[r, g, b, a]); }
        }
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&raw).unwrap();
        let idat = enc.finish().unwrap();
        fn chunk(tag: &[u8; 4], data: &[u8]) -> Vec<u8> {
            let mut out = Vec::with_capacity(12 + data.len());
            out.extend_from_slice(&(data.len() as u32).to_be_bytes());
            out.extend_from_slice(tag);
            out.extend_from_slice(data);
            // Simple CRC32
            let mut crc = 0xffff_ffffu32;
            for &byte in tag.iter().chain(data.iter()) {
                crc ^= byte as u32;
                for _ in 0..8 { crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 }; }
            }
            out.extend_from_slice(&(!crc).to_be_bytes());
            out
        }
        let mut ihdr = Vec::with_capacity(13);
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&chunk(b"IHDR", &ihdr));
        png.extend_from_slice(&chunk(b"IDAT", &idat));
        png.extend_from_slice(&chunk(b"IEND", &[]));
        base64::engine::general_purpose::STANDARD.encode(png)
    }

    #[tokio::test]
    async fn real_ffmpeg_render_smoke() {
        let data = std::env::temp_dir().join(format!("subcast-vclip-smoke-{}", uuid::Uuid::new_v4()));
        let Some(ffmpeg) = find_ffmpeg(&data) else { return };
        std::fs::create_dir_all(&data).unwrap();
        let src = data.join("src.mp4");
        let out = data.join("out.mp4");

        let mk = std::process::Command::new(&ffmpeg)
            .args([
                "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=2",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
            ])
            .arg(&src)
            .output()
            .unwrap();
        assert!(mk.status.success(), "generate test source failed");

        let req_flash = RenderRequest { frame: None, output_dir: None,
            raw_path: src.to_string_lossy().into_owned(),
            output_path: Some(out.to_string_lossy().into_owned()),
            default_name: "smoke".into(),
            layout: "portrait_card".into(),
            card_bg: "night".into(),
            crop_x: 0.5,
            duration: 2.0,
            static_overlay_png: Some(minimal_rgba_png_b64(1080, 1920, 0, 0, 0, 0)),
            cues: vec![CueOverlay {
                start: 0.2,
                end: 1.5,
                y: 1320,
                png_base64: minimal_rgba_png_b64(1080, 160, 255, 220, 80, 180),
            }],
            cover_png: Some(minimal_rgba_png_b64(1080, 1920, 24, 24, 28, 255)),
            cover_mode: "flash".into(),
            embed_thumbnail: true,
            save_cover_sidecar: true,
            landscape_cover_png: Some(minimal_rgba_png_b64(1920, 1080, 24, 24, 28, 255)),
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let res = render_clip(&data, req_flash, cancel.clone(), |_, _, _| {}).await.unwrap();
        let size = std::fs::metadata(&res.video_path).unwrap().len();
        assert!(size > 10_000, "rendered flash mp4 too small: {size}");
        assert!(std::fs::metadata(res.cover_path.as_ref().unwrap()).unwrap().len() > 100);
        assert!(std::fs::metadata(res.landscape_cover_path.as_ref().unwrap()).unwrap().len() > 100);

        let (frames, best) = extract_candidate_frames(&ffmpeg, &src, 2.0).await;
        assert!(!frames.is_empty());
        assert!(best < frames.len());

        let out_hold = data.join("out-hold.mp4");
        let req_hold = RenderRequest { frame: None, output_dir: None,
            raw_path: src.to_string_lossy().into_owned(),
            output_path: Some(out_hold.to_string_lossy().into_owned()),
            default_name: "smoke-hold".into(),
            layout: "portrait_card".into(),
            card_bg: "paper".into(),
            crop_x: 0.5,
            duration: 2.0,
            static_overlay_png: None,
            cues: vec![],
            cover_png: Some(minimal_rgba_png_b64(1080, 1920, 245, 240, 232, 255)),
            cover_mode: "hold".into(),
            embed_thumbnail: true,
            save_cover_sidecar: false,
            landscape_cover_png: None,
        };
        let res_hold = render_clip(&data, req_hold, cancel, |_, _, _| {}).await.unwrap();
        assert!(std::fs::metadata(&res_hold.video_path).unwrap().len() > 10_000);
        let _ = std::fs::remove_dir_all(&data);
    }
}

#[cfg(test)]
mod render_live {
    use super::*;
    /// Montage from two stretches inside the cached clip (run with --ignored; no network: both come from the cache).
    #[tokio::test]
    #[ignore]
    async fn montage_from_cache() {
        let data = dirs::data_dir().unwrap().join("ai.qiaomu.subcast");
        let t = std::time::Instant::now();
        let p = prepare_montage(&data, "xgAJkGC89rM", &[(545.0, 560.0), (600.0, 615.0)], Arc::new(AtomicBool::new(false)), |s, p, m| eprintln!("{s} {p:.2} {m}")).await.unwrap();
        eprintln!("montage took {:?}: {}x{} {:.2}s burned={} frames={}", t.elapsed(), p.width, p.height, p.duration, p.has_burned_subtitles, p.frames.len());
        assert!((p.duration - 30.0).abs() < 0.3, "{}", p.duration);
        assert_eq!((p.width, p.height), (1920, 1080));
        // The second part starts at 15 s: its first frame is the source at 600 s.
        let ff = find_ffmpeg(&data).unwrap();
        let src = data.join("work/clips/xgAJkGC89rM/541390-646520.mp4");
        for (file, at, name) in [(p.path.clone(), 15.2, "m15"), (src.to_string_lossy().into_owned(), 600.0 - 541.39 + 0.2, "s600")] {
            std::process::Command::new(&ff).args(["-v", "error", "-y", "-ss", &format!("{at:.2}"), "-i", &file, "-frames:v", "1", "-vf", "scale=320:-1", &format!("/tmp/claude-501/{name}.png")]).status().unwrap();
        }
    }

    /// Real render of the cached 105 s clip (run with --ignored): 9:16 card cropped to 4:3, blurred background,
    /// a static layer and 20 subtitle bands. Prints the time and checks the output's size and length.
    #[tokio::test]
    #[ignore]
    async fn renders_card_crop() {
        let data = dirs::data_dir().unwrap().join("ai.qiaomu.subcast");
        let src = data.join("work/clips/xgAJkGC89rM/541390-646520.mp4");
        let ff = find_ffmpeg(&data).unwrap();
        let png = |w: u32, h: u32| -> String {
            let out = std::process::Command::new(&ff).args(["-v", "error", "-f", "lavfi", "-i", &format!("color=c=white@0.0:s={w}x{h},format=rgba,drawbox=x=100:y=20:w=600:h=60:color=white@0.9:t=fill"), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]).output().unwrap();
            base64::engine::general_purpose::STANDARD.encode(out.stdout)
        };
        let band = { let out = std::process::Command::new(&ff).args(["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=1080x120", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]).output().unwrap(); base64::engine::general_purpose::STANDARD.encode(out.stdout) };
        let cues = (0..20).map(|k| CueOverlay { start: k as f64 * 5.0, end: k as f64 * 5.0 + 4.5, y: 1500, png_base64: band.clone() }).collect();
        let out = std::env::temp_dir().join("subcast-render-test.mp4");
        let _ = std::fs::remove_file(&out);
        let req = RenderRequest {
            output_dir: None,
            frame: Some(Frame { w: 1080, h: 1920, fit: "card".into(), vx: 0, vy: 556, vw: 1080, vh: 810, crop_box: true }),
            raw_path: src.to_string_lossy().into(), output_path: Some(out.to_string_lossy().into()), default_name: "t".into(),
            layout: "frame".into(), card_bg: "blur".into(), crop_x: 0.7, duration: 105.16,
            static_overlay_png: Some(png(1080, 1920)), cues, cover_png: None, cover_mode: "none".into(),
            embed_thumbnail: false, save_cover_sidecar: false, landscape_cover_png: None,
        };
        let t = std::time::Instant::now();
        render_clip(&data, req, Arc::new(AtomicBool::new(false)), |_, _, _| {}).await.unwrap();
        let (dur, w, h, audio) = probe_video_meta(&ff, &out, 0.0).await;
        eprintln!("render took {:?}: {w}x{h}, {dur:.2}s, audio={audio}", t.elapsed());
        assert_eq!((w, h), (1080, 1920));
        assert!((dur - 105.16).abs() < 0.3 && audio);
    }
}
