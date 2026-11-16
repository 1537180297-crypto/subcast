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
    /// The spoken language, when YouTube marks one audio track as the original (videos with dubbed audio).
    pub original_language: Option<String>,
}

fn original_language(player: &Value) -> Option<String> {
    let mut found = std::collections::BTreeSet::new();
    for key in ["formats", "adaptiveFormats"] {
        for f in player["streamingData"][key].as_array().into_iter().flatten() {
            let a = &f["audioTrack"];
            if a["displayName"].as_str().is_some_and(|n| n.to_lowercase().contains("original")) {
                if let Some(id) = a["id"].as_str() { found.insert(base(id.split('.').next().unwrap_or(id))); }
            }
        }
    }
    (found.len() == 1).then(|| found.into_iter().next().unwrap())
}

fn base(lang: &str) -> String { lang.split(['-', '_']).next().unwrap_or(lang).to_lowercase() }

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
            original_language: original_language(&player),
        };
        if !info.tracks.is_empty() { return Ok(info); }
        if fallback.is_none() && !info.title.is_empty() { fallback = Some(info); }
    }
    fallback.ok_or(last_err)
}

/// The track to show: a human-made one in the spoken language, else the auto track in that language.
/// Videos with dubbed audio carry one auto track per dub, so the spoken language comes from the audio track
/// YouTube marks "original"; with a single auto track, that track's language is the spoken one.
pub fn choose<'a>(tracks: &'a [Track], original: Option<&str>) -> Option<&'a Track> {
    let autos: Vec<&Track> = tracks.iter().filter(|t| t.auto).collect();
    let spoken = original.map(base).or_else(|| (autos.len() == 1).then(|| base(&autos[0].language)));
    if let Some(sp) = &spoken {
        if let Some(t) = tracks.iter().find(|t| !t.auto && &base(&t.language) == sp) { return Some(t); }
        if let Some(t) = autos.iter().find(|t| &base(&t.language) == sp) { return Some(t); }
    }
    tracks.iter().find(|t| !t.auto && base(&t.language) == "en")
        .or_else(|| autos.iter().copied().find(|t| base(&t.language) == "en"))
        .or_else(|| tracks.iter().find(|t| !t.auto))
        .or_else(|| tracks.first())
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

#[cfg(test)]
mod tests {
    use super::*;
    fn t(l: &str, auto: bool) -> Track { Track { base_url: String::new(), language: l.into(), auto } }
    #[test]
    fn dubbed_video_picks_original() {
        let tracks = vec![t("ar", true), t("en", true), t("en-US", false), t("de", true)];
        assert_eq!(choose(&tracks, Some("en")).unwrap().language, "en-US");
        assert_eq!(choose(&tracks, None).unwrap().language, "en-US");
        let only_auto = vec![t("ar", true), t("en", true)];
        assert_eq!(choose(&only_auto, None).unwrap().language, "en");
        assert_eq!(choose(&[t("ja", true)], None).unwrap().language, "ja");
    }
}
