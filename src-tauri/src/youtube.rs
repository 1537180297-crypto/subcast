//! YouTube captions without the viewer's cookies: ask InnerTube's player endpoint as a mobile client
//! (the same route as youtube-transcript-api and yt-dlp, ported from qiaomu-clipper), then fetch the chosen track.
use crate::model::Segment;
use crate::net;
use crate::transcript;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};

const CLIENTS: &[(&str, &str, Option<u32>)] = &[
    ("ANDROID", "20.10.38", Some(34)),
    ("IOS", "20.10.3", None),
    ("ANDROID_VR", "1.60.19", Some(32)),
];

#[derive(Clone, Debug)]
pub struct Track {
    pub base_url: String,
    pub language: String,
    pub auto: bool,
}

pub struct VideoInfo {
    pub title: String,
    pub author: String,
    pub duration: Option<f64>,
    pub description: String,
    pub tracks: Vec<Track>,
}

fn tracks_of(player: &Value) -> Vec<Track> {
    player["captions"]["playerCaptionsTracklistRenderer"]["captionTracks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let url = t["baseUrl"].as_str()?;
            // Token-gated tracks need the web player's proof; skip them.
            if url.contains("exp=xpe") { return None; }
            Some(Track { base_url: url.to_string(), language: t["languageCode"].as_str().unwrap_or("und").to_string(), auto: t["kind"].as_str() == Some("asr") })
        })
        .collect()
}

pub async fn video_info(video_id: &str) -> Result<VideoInfo> {
    let mut last_err = anyhow!("YouTube 没有返回视频信息");
    let mut fallback: Option<VideoInfo> = None;
    for (name, version, sdk) in CLIENTS {
        let mut client = json!({ "clientName": name, "clientVersion": version, "hl": "en" });
        if let Some(sdk) = sdk { client["androidSdkVersion"] = json!(sdk); }
        let body = json!({ "context": { "client": client }, "videoId": video_id, "contentCheckOk": true, "racyCheckOk": true });
        let res = net::client().post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false").json(&body).send().await;
        let player: Value = match res {
            Ok(r) if r.status().is_success() => match r.json().await { Ok(v) => v, Err(e) => { last_err = e.into(); continue; } },
            Ok(r) => { last_err = anyhow!("YouTube {}", r.status()); continue; }
            Err(e) => { last_err = anyhow!("连不上 YouTube（国内需要设置代理）：{e}"); continue; }
        };
        let d = &player["videoDetails"];
        let info = VideoInfo {
            title: d["title"].as_str().unwrap_or("").to_string(),
            author: d["author"].as_str().unwrap_or("").to_string(),
            duration: d["lengthSeconds"].as_str().and_then(|s| s.parse().ok()),
            description: d["shortDescription"].as_str().unwrap_or("").to_string(),
            tracks: tracks_of(&player),
        };
        if !info.tracks.is_empty() { return Ok(info); }
        if fallback.is_none() && !info.title.is_empty() { fallback = Some(info); }
    }
    fallback.ok_or(last_err)
}

/// The track to show: a human-made one in the spoken language (the auto track's language tells us which
/// language is spoken), else the auto track, else any human-made one.
pub fn choose(tracks: &[Track]) -> Option<&Track> {
    let base = |l: &str| l.split('-').next().unwrap_or(l).to_lowercase();
    let spoken = tracks.iter().find(|t| t.auto).map(|t| base(&t.language));
    if let Some(sp) = &spoken {
        if let Some(t) = tracks.iter().find(|t| !t.auto && &base(&t.language) == sp) { return Some(t); }
        return tracks.iter().find(|t| t.auto);
    }
    tracks.iter().find(|t| base(&t.language) == "en").or_else(|| tracks.first())
}

pub async fn fetch_track(track: &Track) -> Result<Vec<Segment>> {
    let base = regex::Regex::new(r"&fmt=[^&]*").unwrap().replace_all(&track.base_url, "").to_string();
    for url in [format!("{base}&fmt=json3"), base.clone()] {
        if let Ok(r) = net::client().get(&url).send().await {
            if let Ok(body) = r.text().await {
                let segs = transcript::parse_youtube(&body);
                if !segs.is_empty() { return Ok(segs); }
            }
        }
    }
    Err(anyhow!("字幕下载失败"))
}
