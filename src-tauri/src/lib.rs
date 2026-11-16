mod asr;
mod db;
mod feeds;
mod llm;
mod model;
mod net;
mod transcript;
mod youtube;

use model::*;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// The port the bundled app serves its pages from. YouTube's embedded player refuses pages served from the
/// `tauri://` scheme (no valid origin / referrer), so release builds use http://localhost like a normal website.
#[cfg(not(debug_assertions))]
const LOCAL_PORT: u16 = 14327;

pub struct AppState {
    db: Mutex<Connection>,
    data: PathBuf,
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AppState {
    fn job(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.jobs.lock().unwrap().insert(id.to_string(), flag.clone());
        flag
    }
    fn done(&self, id: &str) { self.jobs.lock().unwrap().remove(id); }
}

type Res<T> = Result<T, String>;
fn e<E: std::fmt::Display>(err: E) -> String { err.to_string() }

// ---- subscriptions ---------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Added { show: Option<Show>, episode: Option<Episode> }

fn store(state: &AppState, show: &Show, eps: &[Episode]) -> Res<()> {
    let mut conn = state.db.lock().unwrap();
    db::upsert_show(&conn, show).map_err(e)?;
    db::upsert_episodes(&mut conn, eps).map_err(e)?;
    Ok(())
}

async fn single_youtube(state: &AppState, video_id: &str) -> Res<Episode> {
    let info = youtube::video_info(video_id).await.map_err(e)?;
    let ep = Episode {
        id: short_hash(&format!("single:{video_id}"), 20),
        show_id: "single".into(),
        guid: video_id.into(),
        title: if info.title.is_empty() { video_id.to_string() } else { info.title },
        published: Some(now_ms()),
        duration: info.duration,
        video_id: Some(video_id.into()),
        link: Some(format!("https://www.youtube.com/watch?v={video_id}")),
        cover: Some(format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg")),
        notes: Some(format!("{}\n\n{}", info.author, info.description)),
        ..Default::default()
    };
    let mut conn = state.db.lock().unwrap();
    db::upsert_episodes(&mut conn, std::slice::from_ref(&ep)).map_err(e)?;
    Ok(db::get_episode(&conn, &ep.id).map_err(e)?.unwrap_or(ep))
}

#[tauri::command]
async fn add_subscription(state: State<'_, AppState>, input: String) -> Res<Added> {
    let (show, eps) = match feeds::resolve(&input).await.map_err(e)? {
        feeds::Source::YouTubeVideo(id) => return Ok(Added { show: None, episode: Some(single_youtube(&state, &id).await?) }),
        feeds::Source::XiaoyuzhouEpisode(url) => {
            let mut ep = feeds::xiaoyuzhou_episode(&url).await.map_err(e)?;
            ep.id = short_hash(&format!("single:{}", ep.guid), 20);
            let mut conn = state.db.lock().unwrap();
            db::upsert_episodes(&mut conn, std::slice::from_ref(&ep)).map_err(e)?;
            let ep = db::get_episode(&conn, &ep.id).map_err(e)?.unwrap_or(ep);
            return Ok(Added { show: None, episode: Some(ep) });
        }
        feeds::Source::Xiaoyuzhou(url) => feeds::xiaoyuzhou_show(&url).await.map_err(e)?,
        feeds::Source::Feed(url) => match feeds::fetch_show(&url, "podcast").await {
            Ok(r) if !r.1.is_empty() => r,
            // A channel with no long-form videos: fall back to everything it uploads.
            other if url.contains("playlist_id=UULF") => {
                let all = url.replace("playlist_id=UULF", "channel_id=UC");
                match feeds::fetch_show(&all, "podcast").await { Ok(r) => r, Err(err) => return Err(other.err().map(e).unwrap_or_else(|| e(err))) }
            }
            other => other.map_err(e)?,
        },
    };
    if eps.is_empty() { return Err("这个订阅源里没有可播放的节目".into()); }
    store(&state, &show, &eps)?;
    Ok(Added { show: Some(show), episode: None })
}

#[tauri::command]
async fn refresh_show(state: State<'_, AppState>, id: String) -> Res<Show> {
    let show = db::get_show(&state.db.lock().unwrap(), &id).map_err(e)?.ok_or("节目不存在")?;
    let (fresh, eps) = feeds::fetch_show(&show.feed_url, &show.kind).await.map_err(e)?;
    let fresh = Show { id: show.id.clone(), kind: show.kind.clone(), ..fresh };
    store(&state, &fresh, &eps)?;
    Ok(fresh)
}

#[tauri::command]
async fn refresh_all(state: State<'_, AppState>) -> Res<usize> {
    let shows = db::list_shows(&state.db.lock().unwrap()).map_err(e)?;
    let mut ok = 0;
    for chunk in shows.chunks(6) {
        let results = futures_util::future::join_all(chunk.iter().map(|s| feeds::fetch_show(&s.feed_url, &s.kind))).await;
        for (s, r) in chunk.iter().zip(results) {
            if let Ok((fresh, eps)) = r {
                let fresh = Show { id: s.id.clone(), kind: s.kind.clone(), ..fresh };
                if store(&state, &fresh, &eps).is_ok() { ok += 1; }
            }
        }
    }
    Ok(ok)
}

#[tauri::command]
fn list_shows(state: State<'_, AppState>) -> Res<Vec<Show>> { db::list_shows(&state.db.lock().unwrap()).map_err(e) }

#[tauri::command]
fn list_episodes(state: State<'_, AppState>, show_id: Option<String>, limit: Option<i64>) -> Res<Vec<Episode>> {
    db::list_episodes(&state.db.lock().unwrap(), show_id.as_deref(), limit.unwrap_or(300)).map_err(e)
}

#[tauri::command]
fn recent_episodes(state: State<'_, AppState>) -> Res<Vec<Episode>> { db::recent_episodes(&state.db.lock().unwrap(), 60).map_err(e) }

#[tauri::command]
fn get_episode(state: State<'_, AppState>, id: String) -> Res<Option<Episode>> { db::get_episode(&state.db.lock().unwrap(), &id).map_err(e) }

#[tauri::command]
fn remove_show(state: State<'_, AppState>, id: String) -> Res<()> { db::delete_show(&state.db.lock().unwrap(), &id).map_err(e) }

#[tauri::command]
fn set_progress(state: State<'_, AppState>, id: String, seconds: f64) -> Res<()> { db::set_progress(&state.db.lock().unwrap(), &id, seconds).map_err(e) }

#[tauri::command]
async fn search_podcasts(term: String, country: Option<String>) -> Res<Vec<feeds::SearchResult>> {
    feeds::search_podcasts(&term, country.as_deref().unwrap_or("US")).await.map_err(e)
}

// ---- transcripts -----------------------------------------------------------------------------------

#[tauri::command]
fn load_transcript(state: State<'_, AppState>, episode_id: String) -> Res<Option<Transcript>> {
    db::get_transcript(&state.db.lock().unwrap(), &episode_id).map_err(e)
}

/// The publisher's own subtitles: YouTube captions, or a feed's <podcast:transcript>. None when there are none.
#[tauri::command]
async fn fetch_official_transcript(state: State<'_, AppState>, episode_id: String) -> Res<Option<Transcript>> {
    let ep = db::get_episode(&state.db.lock().unwrap(), &episode_id).map_err(e)?.ok_or("节目不存在")?;
    let t = if let Some(vid) = &ep.video_id {
        let info = youtube::video_info(vid).await.map_err(e)?;
        match youtube::choose(&info.tracks, info.original_language.as_deref()) {
            Some(track) => {
                let segs = transcript::clean(youtube::fetch_track(track).await.map_err(e)?);
                let segs = transcript::resegment(segs);
                Some(Transcript { episode_id: ep.id.clone(), source: if track.auto { "youtube-auto" } else { "youtube" }.into(), language: track.language.clone(), segments: segs })
            }
            None => None,
        }
    } else if let Some(url) = &ep.transcript_url {
        let body = net::get_text(url).await.map_err(e)?;
        let kind = ep.transcript_type.clone().unwrap_or_default();
        let segs = if kind.contains("json") { transcript::parse_podcast_json(&body) } else { transcript::parse_cues(&body) };
        let segs = transcript::resegment(transcript::clean(segs));
        (!segs.is_empty()).then(|| Transcript { episode_id: ep.id.clone(), source: "rss".into(), language: "auto".into(), segments: segs })
    } else {
        None
    };
    if let Some(t) = &t {
        if t.segments.is_empty() { return Ok(None); }
        db::save_transcript(&state.db.lock().unwrap(), t).map_err(e)?;
    }
    Ok(t)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AsrEvent { episode_id: String, stage: String, progress: f64, message: Option<String>, segment: Option<Segment> }

fn asr_emit(app: &AppHandle, id: &str, stage: &str, progress: f64, message: Option<String>, segment: Option<Segment>) {
    let _ = app.emit("asr", AsrEvent { episode_id: id.into(), stage: stage.into(), progress, message, segment });
}

#[tauri::command]
async fn transcribe(app: AppHandle, state: State<'_, AppState>, episode_id: String, model: String, language: String) -> Res<Transcript> {
    let ep = db::get_episode(&state.db.lock().unwrap(), &episode_id).map_err(e)?.ok_or("节目不存在")?;
    let spec = asr::spec(&model).ok_or("未知模型")?;
    let model_path = asr::models_dir(&state.data).join(spec.file);
    if !model_path.is_file() { return Err("请先下载识别模型".into()); }
    let cancel = state.job(&episode_id);
    let work = state.data.join("work").join(&episode_id);
    let result = async {
        let _ = tokio::fs::create_dir_all(&work).await;
        asr_emit(&app, &episode_id, "download", 0.0, None, None);
        let audio = if let Some(vid) = &ep.video_id {
            let ytdlp = match asr::find_ytdlp(&state.data) {
                Some(p) => p,
                None => {
                    asr_emit(&app, &episode_id, "download", 0.0, Some("正在准备 YouTube 下载工具".into()), None);
                    asr::install_ytdlp(&state.data, &cancel, |_, _| {}).await.map_err(e)?
                }
            };
            asr::youtube_audio(&ytdlp, vid, &work, cancel.clone()).await.map_err(e)?
        } else {
            let url = ep.audio_url.clone().ok_or("这集没有音频地址")?;
            let ext = url.split('?').next().and_then(|u| u.rsplit('.').next()).filter(|x| x.len() <= 4).unwrap_or("mp3").to_lowercase();
            let dest = work.join(format!("audio.{ext}"));
            let app2 = app.clone();
            let id2 = episode_id.clone();
            asr::download(&url, &dest, &cancel, move |got, total| {
                let p = total.map(|t| got as f64 / t as f64).unwrap_or(0.0);
                asr_emit(&app2, &id2, "download", p, None, None);
            }).await.map_err(e)?;
            dest
        };
        asr_emit(&app, &episode_id, "transcribe", 0.0, None, None);
        let prompt = format!("{} — {}", ep.show_title.clone().unwrap_or_default(), ep.title).chars().take(200).collect::<String>();
        let app2 = app.clone();
        let id2 = episode_id.clone();
        let out = if spec.engine == "qwen3" {
            let bin = match asr::find_crispasr(&state.data) {
                Some(p) => p,
                None => {
                    asr_emit(&app, &episode_id, "download", 0.0, Some("正在准备 Qwen3-ASR 识别程序".into()), None);
                    let (a, i) = (app.clone(), episode_id.clone());
                    asr::install_crispasr(&state.data, &cancel, move |got, total| {
                        asr_emit(&a, &i, "download", total.map(|t| got as f64 / t as f64).unwrap_or(0.0), Some("正在准备 Qwen3-ASR 识别程序".into()), None);
                    }).await.map_err(e)?
                }
            };
            asr_emit(&app, &episode_id, "transcribe", 0.01, Some("正在解码音频".into()), None);
            let (src, wav) = (audio.clone(), work.join("audio16k.wav"));
            let wav2 = wav.clone();
            tokio::task::spawn_blocking(move || -> anyhow::Result<()> { asr::write_wav(&wav2, &asr::decode_16k_mono(&src)?) }).await.map_err(e)?.map_err(e)?;
            let segments = asr::run_crispasr(&bin, &model_path, &wav, &language, &prompt, cancel.clone(), move |p| asr_emit(&app2, &id2, "transcribe", p, None, None)).await.map_err(e)?;
            let sample: String = segments.iter().take(5).map(|s| s.text.as_str()).collect();
            let lang = if language != "auto" { language.clone() } else if sample.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)) { "zh".into() } else { "auto".into() };
            asr::WorkerResult { language: lang, segments }
        } else {
            asr::run_worker(&audio, &model_path, &language, &prompt, cancel.clone(), move |ev| match ev {
                asr::WorkerEvent::Progress(p) => asr_emit(&app2, &id2, "transcribe", p, None, None),
                asr::WorkerEvent::Segment(s) => asr_emit(&app2, &id2, "segment", 0.0, None, Some(s)),
            }).await.map_err(e)?
        };
        let segments = transcript::resegment(transcript::clean(out.segments));
        if segments.is_empty() { return Err("没有识别出文字（可能是纯音乐或静音）".to_string()); }
        let t = Transcript { episode_id: ep.id.clone(), source: "whisper".into(), language: out.language, segments };
        db::save_transcript(&state.db.lock().unwrap(), &t).map_err(e)?;
        Ok(t)
    }.await;
    let _ = tokio::fs::remove_dir_all(&work).await;
    state.done(&episode_id);
    match &result {
        Ok(_) => asr_emit(&app, &episode_id, "done", 1.0, None, None),
        Err(m) => asr_emit(&app, &episode_id, "error", 0.0, Some(m.clone()), None),
    }
    result
}

#[tauri::command]
fn cancel_job(state: State<'_, AppState>, id: String) {
    if let Some(f) = state.jobs.lock().unwrap().get(&id) { f.store(true, Ordering::Relaxed); }
}

#[tauri::command]
fn asr_models(state: State<'_, AppState>) -> Vec<asr::ModelInfo> { asr::list_models(&state.data) }

#[tauri::command]
async fn download_model(app: AppHandle, state: State<'_, AppState>, id: String, mirror_first: bool) -> Res<()> {
    let job = format!("model:{id}");
    let cancel = state.job(&job);
    let app2 = app.clone();
    let id2 = id.clone();
    let r = asr::download_model(&state.data, &id, &cancel, mirror_first, move |got, total| {
        let _ = app2.emit("model-download", json!({"id": id2, "received": got, "total": total}));
    }).await;
    state.done(&job);
    r.map_err(e)
}

#[tauri::command]
fn delete_model(state: State<'_, AppState>, id: String) -> Res<()> {
    let spec = asr::spec(&id).ok_or("未知模型")?;
    let _ = std::fs::remove_file(asr::models_dir(&state.data).join(spec.file));
    Ok(())
}

// ---- stored data and settings ------------------------------------------------------------------------

#[tauri::command]
fn get_blob(state: State<'_, AppState>, episode_id: String, kind: String) -> Res<Option<String>> {
    db::get_blob(&state.db.lock().unwrap(), &episode_id, &kind).map_err(e)
}

#[tauri::command]
fn set_blob(state: State<'_, AppState>, episode_id: String, kind: String, data: String) -> Res<()> {
    db::set_blob(&state.db.lock().unwrap(), &episode_id, &kind, &data).map_err(e)
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Res<Value> {
    let raw = db::get_setting(&state.db.lock().unwrap(), "app").map_err(e)?;
    Ok(raw.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or(Value::Null))
}

#[tauri::command]
fn set_settings(state: State<'_, AppState>, settings: Value) -> Res<()> {
    net::set_proxy(settings["proxy"].as_str().unwrap_or("")).map_err(e)?;
    db::set_setting(&state.db.lock().unwrap(), "app", &settings.to_string()).map_err(e)
}

#[tauri::command]
fn set_api_key(provider: String, key: String) -> Res<()> { llm::set_key(&provider, key.trim()).map_err(e) }

#[tauri::command]
fn has_api_key(provider: String) -> bool { llm::get_key(&provider).is_some_and(|k| !k.is_empty()) }

#[tauri::command]
async fn llm_chat(app: AppHandle, state: State<'_, AppState>, request_id: String, provider: llm::Provider, system: String, messages: Vec<llm::Message>, max_tokens: Option<u32>, json_mode: Option<bool>) -> Res<String> {
    let cancel = state.job(&request_id);
    let rid = request_id.clone();
    let r = llm::chat(&provider, &system, &messages, max_tokens.unwrap_or(8000), json_mode.unwrap_or(false), &cancel, |d| {
        let _ = app.emit("llm", json!({"requestId": rid, "delta": d}));
    }).await;
    state.done(&request_id);
    r.map_err(e)
}

// ---- app ------------------------------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--asr-worker") {
        std::process::exit(asr::worker_main(&args[2..]));
    }
    let builder = tauri::Builder::default();
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_localhost::Builder::new(LOCAL_PORT).build());
    builder
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            let conn = db::open(&data.join("subcast.db"))?;
            conn.execute("INSERT OR IGNORE INTO shows(id,kind,title,feed_url,updated_at) VALUES('single','single','单独打开','',0)", [])?;
            if let Some(s) = db::get_setting(&conn, "app")?.and_then(|r| serde_json::from_str::<Value>(&r).ok()) {
                let _ = net::set_proxy(s["proxy"].as_str().unwrap_or(""));
            }
            app.manage(AppState { db: Mutex::new(conn), data, jobs: Mutex::new(HashMap::new()) });
            #[cfg(debug_assertions)]
            let url = tauri::WebviewUrl::App("index.html".into());
            #[cfg(not(debug_assertions))]
            let url = tauri::WebviewUrl::External(format!("http://localhost:{LOCAL_PORT}").parse().unwrap());
            tauri::WebviewWindowBuilder::new(app, "main", url)
                .title("SubCast · 声渡")
                .inner_size(1360.0, 880.0)
                .min_inner_size(980.0, 640.0)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_subscription, refresh_show, refresh_all, list_shows, list_episodes, recent_episodes, get_episode, remove_show,
            set_progress, search_podcasts, load_transcript, fetch_official_transcript, transcribe, cancel_job, asr_models,
            download_model, delete_model, get_blob, set_blob, get_settings, set_settings, set_api_key, has_api_key, llm_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod live {
    //! Network tests against real services: `cargo test -- --ignored --nocapture`.
    use super::*;
    #[tokio::test]
    #[ignore]
    async fn sources() {
        for input in ["https://www.youtube.com/@DwarkeshPatel", "https://podcasts.apple.com/us/podcast/no-priors/id1668002688", "https://www.xiaoyuzhoufm.com/podcast/5e5c52c9418a84a04625e6cc", "https://feeds.megaphone.fm/nopriors"] {
            let (show, eps) = match feeds::resolve(input).await.unwrap() {
                feeds::Source::Feed(u) => feeds::fetch_show(&u, "podcast").await.unwrap(),
                feeds::Source::Xiaoyuzhou(u) => feeds::xiaoyuzhou_show(&u).await.unwrap(),
                _ => panic!("unexpected source for {input}"),
            };
            println!("{input} -> {} [{}] {} episodes; first: {:?} audio={:?} video={:?} transcript={:?}", show.title, show.kind, eps.len(), eps[0].title, eps[0].audio_url.is_some(), eps[0].video_id, eps[0].transcript_url);
            assert!(!eps.is_empty());
        }
        let r = feeds::search_podcasts("lex fridman", "US").await.unwrap();
        println!("search: {} results, first {}", r.len(), r[0].title);
    }
    #[tokio::test]
    #[ignore]
    async fn captions() {
        let info = youtube::video_info("dQw4w9WgXcQ").await.unwrap();
        let t = youtube::choose(&info.tracks, info.original_language.as_deref()).unwrap();
        let segs = transcript::resegment(transcript::clean(youtube::fetch_track(t).await.unwrap()));
        println!("{} lang={} auto={} {} blocks; {:?}", info.title, t.language, t.auto, segs.len(), &segs[..2]);
        assert!(segs.len() > 5);
    }
    #[tokio::test]
    #[ignore]
    async fn qwen3_pipeline() {
        // SUBCAST_TEST_DIR holds clip.mp3 and qwen3-asr-0.6b-q8_0.gguf.
        let dir = std::path::PathBuf::from(std::env::var("SUBCAST_TEST_DIR").unwrap());
        let data = dir.join("data");
        let flag = std::sync::Arc::new(AtomicBool::new(false));
        let bin = match asr::find_crispasr(&data) { Some(b) => b, None => asr::install_crispasr(&data, &flag, |_, _| {}).await.unwrap() };
        let wav = dir.join("t16k.wav");
        asr::write_wav(&wav, &asr::decode_16k_mono(&dir.join("clip.mp3")).unwrap()).unwrap();
        let segs = asr::run_crispasr(&bin, &dir.join("qwen3-asr-0.6b-q8_0.gguf"), &wav, "auto", "No Priors", flag, |p| println!("progress {p}")).await.unwrap();
        for s in &segs { println!("[{:.1}-{:.1}] {}", s.start, s.end, s.text); }
        assert!(segs.len() >= 5);
    }
}
