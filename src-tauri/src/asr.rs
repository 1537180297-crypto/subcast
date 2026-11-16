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
}

pub fn models_dir(data: &Path) -> PathBuf { data.join("models") }

pub fn list_models(data: &Path) -> Vec<ModelInfo> {
    MODELS.iter().map(|m| ModelInfo {
        id: m.id.into(), name: m.name.into(), size_mb: m.size_mb, note: m.note.into(), installed: models_dir(data).join(m.file).is_file(),
    }).collect()
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

pub async fn install_ytdlp(data: &Path, cancel: &AtomicBool, progress: impl FnMut(u64, Option<u64>)) -> Result<PathBuf> {
    let name = if cfg!(target_os = "macos") { "yt-dlp_macos" } else if cfg!(windows) { "yt-dlp.exe" } else if cfg!(target_arch = "aarch64") { "yt-dlp_linux_aarch64" } else { "yt-dlp_linux" };
    let dest = data.join("bin").join(exe("yt-dlp"));
    download(&format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{name}"), &dest, cancel, progress).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(dest)
}

pub async fn youtube_audio(ytdlp: &Path, video_id: &str, dir: &Path, cancel: Arc<AtomicBool>) -> Result<PathBuf> {
    tokio::fs::create_dir_all(dir).await?;
    let template = dir.join(format!("{video_id}.%(ext)s"));
    let mut cmd = tokio::process::Command::new(ytdlp);
    // m4a (AAC) decodes without ffmpeg; format 18 (mp4 with AAC audio) is the fallback every video has.
    cmd.args(["-f", "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/18", "--no-playlist", "--no-part", "-o"]).arg(&template);
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

/// Runs Qwen3-ASR on a 16 kHz WAV. CrispASR transcribes in ~30 s slices; each slice is split into sentences.
pub async fn run_crispasr(bin: &Path, model: &Path, wav: &Path, language: &str, prompt: &str, cancel: Arc<AtomicBool>, mut on_progress: impl FnMut(f64)) -> Result<Vec<Segment>> {
    let out = wav.with_extension("");
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("-m").arg(model).arg("-f").arg(wav).args(["-oj", "-np", "-pp"]).arg("-of").arg(&out);
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
    cmd.args(["-t", &threads.to_string()]);
    if language == "auto" { cmd.args(["-l", "auto", "--lid-backend", "off"]); } else { cmd.args(["-l", language]); }
    if !prompt.is_empty() { cmd.arg("--prompt").arg(prompt); }
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
