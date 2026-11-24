//! YouTube videos for curated (乔木精读 / rss.qiaomu.ai) episodes that arrive without one. Many shows post each
//! episode to YouTube too (张小珺, 晚点聊, 42章经…) but the curated data only carries the audio. The show's channel
//! is found by name in YouTube's channel search and accepted only when its uploads carry the show's own episode
//! titles; then each episode is matched to its video by title (or episode number), with dates as a check.
//! A built-in table and the remote config (`curatedYoutube`: source id → channel id, feed URL or "none") override
//! the search.
use crate::model::Episode;
use crate::net;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
/// `duration` in seconds, when the uploads list gives it (the feed doesn't).
pub struct Vid { pub id: String, pub title: String, pub published: Option<i64>, pub duration: Option<f64> }

/// Known channels, for shows whose name finds the wrong channel or none.
fn builtin(source: &str) -> Option<&'static str> {
    Some(match source {
        // Checked by hand (2026-11): each channel's uploads carry the show's own episode titles.
        "nexttoken" => "UC_9pr_usdNG29RauPFwIFQw",
        "zhangxiaojun" | "zhangxiaojun-zh" => "UC3Sv1JuKpbOx3csUO8FAo5g",
        "42zhangjing" | "42zhangjing-zh" => "UCirUGhuiz6m85eKO8n3Picw",
        "crossing" | "crossing-zh" => "UCqoy3g7ZH24j2mLOq_nbKrQ",
        "zhixing" | "zhixing-zh" => "UC3ezayOvLhJRk5L0QRg_bfQ",
        "mianji" | "mianji-zh" => "UCroOLbclmz0FOit7d2Xe0PQ",
        "nopriors" | "nopriors-zh" => "UCSI7h9hydQ40K5MJHnCrQvw",
        "allin" | "allin-zh" => "UCESLZhusAkFfsNsApnjF_Cg",
        "unsupervised" | "unsupervised-zh" => "UCUl-s_Vp-Kkk_XVyDylNwLA",
        "cogrev" | "cogrev-zh" => "UCjNRVMBVI30Sak_p6HRWhIA",
        // No YouTube version, or titles too different to match safely (晚点聊 rewrites them on YouTube).
        "aialchemy" | "aialchemy-zh" | "35huan" | "35huan-zh" | "latetalk" | "latetalk-zh" => "none",
        _ => return None,
    })
}

static OVERRIDES: Lazy<RwLock<HashMap<String, String>>> = Lazy::new(|| RwLock::new(HashMap::new()));
/// What the search found per source this session: Some(channel) or None (searched, nothing fitting), and when.
static FOUND: Lazy<RwLock<HashMap<String, (Option<String>, Instant)>>> = Lazy::new(|| RwLock::new(load_saved()));

/// Channels found by search are kept on disk, so a show's page doesn't search again on every launch.
fn saved_path() -> Option<std::path::PathBuf> { dirs::cache_dir().map(|d| d.join("ai.qiaomu.subcast").join("curated-youtube.json")) }

fn load_saved() -> HashMap<String, (Option<String>, Instant)> {
    let Some(text) = saved_path().and_then(|p| std::fs::read_to_string(p).ok()) else { return HashMap::new() };
    let map: HashMap<String, String> = serde_json::from_str(&text).unwrap_or_default();
    map.into_iter().map(|(k, v)| (k, (Some(v), Instant::now()))).collect()
}

fn save_found() {
    let map: HashMap<String, String> = FOUND.read().unwrap().iter().filter_map(|(k, (v, _))| v.clone().map(|v| (k.clone(), v))).collect();
    if let Some(p) = saved_path() {
        if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
        let _ = std::fs::write(p, serde_json::to_string_pretty(&map).unwrap_or_default());
    }
}

/// From the remote config: `{"zhangxiaojun": "UC…", "some-show": "none"}`.
pub fn set_overrides(v: &Value) {
    let Some(m) = v.as_object() else { return };
    let map = m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.trim().to_string()))).collect();
    *OVERRIDES.write().unwrap() = map;
}

/// Gives videos to the episodes that have none. Never fails: without a channel or a match, nothing changes.
pub async fn fill(source: &str, show_name: &str, eps: &mut [Episode]) {
    if !eps.iter().any(|e| e.video_id.is_none()) { return; }
    // Bounded: a slow YouTube never holds up the show's page for long.
    let Ok(Some(channel)) = tokio::time::timeout(Duration::from_secs(20), channel_for(source, show_name, eps)).await else { return };
    let Ok(vids) = tokio::time::timeout(Duration::from_secs(15), channel_videos(&channel)).await else { return };
    if vids.is_empty() { return; }
    let mut used: std::collections::HashSet<String> = eps.iter().filter_map(|e| e.video_id.clone()).collect();
    for e in eps.iter_mut().filter(|e| e.video_id.is_none()) {
        if let Some(v) = best_match(&e.title, e.published, &vids, &used) {
            used.insert(v.clone());
            if e.cover.is_none() { e.cover = Some(format!("https://i.ytimg.com/vi/{v}/hqdefault.jpg")); }
            // Feeds of these shows often carry no length: the video's stands in, so the player and the episode
            // list show one before anything loads (and "watched" can be worked out).
            if e.duration.is_none_or(|d| d <= 0.0) {
                if let Some(d) = vids.iter().find(|x| x.id == v).and_then(|x| x.duration) { e.duration = Some(d); }
            }
            e.video_id = Some(v);
        }
    }
}

/// The show's channel id (UC…), from the overrides, this session's search, or a new search.
async fn channel_for(source: &str, show_name: &str, eps: &[Episode]) -> Option<String> {
    if let Some(o) = OVERRIDES.read().unwrap().get(source).cloned() {
        return channel_id_of(&o);
    }
    if let Some(b) = builtin(source) { return channel_id_of(b); }
    if let Some((found, at)) = FOUND.read().unwrap().get(source).cloned() {
        // A failed search is tried again before long: YouTube's search page is not always the same.
        if found.is_some() || at.elapsed() < Duration::from_secs(30 * 60) { return found; }
    }
    let mut found = discover(show_name, eps).await;
    if found.is_none() { found = discover(show_name, eps).await; }
    FOUND.write().unwrap().insert(source.to_string(), (found.clone(), Instant::now()));
    if found.is_some() { save_found(); }
    found
}

/// "UC…", a channel or uploads feed URL, or "none".
fn channel_id_of(s: &str) -> Option<String> {
    if s.eq_ignore_ascii_case("none") || s.is_empty() { return None; }
    if s.starts_with("UC") && s.len() == 24 { return Some(s.to_string()); }
    if let Some(c) = Regex::new(r"(?:channel_id=|/channel/)(UC[A-Za-z0-9_-]{22})").unwrap().captures(s) { return Some(c[1].to_string()); }
    let c = Regex::new(r"playlist_id=UU(?:LF)?([A-Za-z0-9_-]{22})").unwrap().captures(s)?;
    Some(format!("UC{}", &c[1]))
}

/// Searches YouTube channels by the show's name and keeps the one whose recent uploads carry the show's titles.
async fn discover(show_name: &str, eps: &[Episode]) -> Option<String> {
    // Site names carry our own labels ("面基 精读 · 一线经验者来聊", "Lex Fridman · 中文精读"): search the show's name.
    let name = show_name.split(" · ").next().unwrap_or(show_name).replace("中文精读", "").replace("精读", "").replace("文稿", ""); // i18n-ignore (matched, never shown)
    let hits = crate::feeds::search_youtube_channels(name.trim()).await.ok()?;
    let mut recent: Vec<&Episode> = eps.iter().collect();
    recent.sort_by_key(|e| std::cmp::Reverse(e.published.unwrap_or(0)));
    recent.truncate(40);
    let used = std::collections::HashSet::new();
    let chans: Vec<String> = hits.iter().take(3).filter_map(|h| channel_id_of(&h.feed_url)).collect();
    let feeds = futures_util::future::join_all(chans.iter().map(|c| feed_videos(c))).await;
    let mut best: Option<(usize, String)> = None;
    for (ch, vids) in chans.into_iter().zip(feeds) {
        let score = recent.iter().filter(|e| best_match(&e.title, e.published, &vids, &used).is_some()).count();
        if score > best.as_ref().map(|b| b.0).unwrap_or(0) { best = Some((score, ch)); }
    }
    let need = if recent.len() >= 4 { 2 } else { 1 };
    best.filter(|(s, _)| *s >= need).map(|(_, c)| c)
}

/// The channel's uploads: the last ~15 from its feed (with dates) and up to ~100 from its uploads list.
pub async fn channel_videos(channel: &str) -> Vec<Vid> {
    if !(channel.starts_with("UC") && channel.len() == 24) { return vec![]; }
    static CACHE: Lazy<RwLock<HashMap<String, (Vec<Vid>, Instant)>>> = Lazy::new(|| RwLock::new(HashMap::new()));
    if let Some((v, at)) = CACHE.read().unwrap().get(channel) { if at.elapsed() < Duration::from_secs(30 * 60) { return v.clone(); } }
    let (feed, page) = tokio::join!(feed_videos(channel), uploads_page(channel));
    let mut out = feed;
    for v in page {
        match out.iter_mut().find(|x| x.id == v.id) {
            Some(x) => { if x.duration.is_none() { x.duration = v.duration; } }
            None => out.push(v),
        }
    }
    if !out.is_empty() { CACHE.write().unwrap().insert(channel.to_string(), (out.clone(), Instant::now())); }
    out
}

async fn feed_videos(channel: &str) -> Vec<Vid> {
    let Ok(xml) = net::get_text(&format!("https://www.youtube.com/feeds/videos.xml?channel_id={channel}")).await else { return vec![] };
    Regex::new(r"(?s)<yt:videoId>\s*([^<]+?)\s*</yt:videoId>.*?<title>([^<]*)</title>.*?<published>([^<]+)</published>").unwrap()
        .captures_iter(&xml)
        .map(|c| Vid {
            id: c[1].to_string(),
            title: crate::transcript::decode_entities(&c[2]),
            published: chrono::DateTime::parse_from_rfc3339(&c[3]).ok().map(|d| d.timestamp_millis()),
            duration: None,
        })
        .collect()
}

/// The channel's uploads list page (no dates there), read from its embedded ytInitialData.
async fn uploads_page(channel: &str) -> Vec<Vid> {
    let list = format!("UU{}", &channel[2..]);
    let Ok(html) = net::get_text(&format!("https://www.youtube.com/playlist?list={list}")).await else { return vec![] };
    let Some(c) = Regex::new(r"var ytInitialData = (\{.*?\});</script>").unwrap().captures(&html) else { return vec![] };
    let Ok(data) = serde_json::from_str::<Value>(&c[1]) else { return vec![] };
    let mut out = Vec::new();
    collect(&data, &mut out);
    out
}

fn collect(v: &Value, out: &mut Vec<Vid>) {
    match v {
        Value::Object(m) => {
            if let Some(r) = m.get("playlistVideoRenderer") {
                let title = r["title"]["runs"][0]["text"].as_str().or_else(|| r["title"]["simpleText"].as_str());
                if let (Some(id), Some(t)) = (r["videoId"].as_str(), title) {
                    let duration = r["lengthSeconds"].as_str().and_then(|s| s.parse().ok()).or_else(|| clock_text(&r["lengthText"]));
                    out.push(Vid { id: id.into(), title: t.into(), published: None, duration });
                }
                return;
            }
            if let Some(r) = m.get("lockupViewModel") {
                let title = r["metadata"]["lockupMetadataViewModel"]["title"]["content"].as_str();
                if let (Some(id), Some(t)) = (r["contentId"].as_str().filter(|i| i.len() == 11), title) {
                    out.push(Vid { id: id.into(), title: t.into(), published: None, duration: clock_text(&r["contentImage"]) });
                }
                return;
            }
            for x in m.values() { collect(x, out); }
        }
        Value::Array(a) => for x in a { collect(x, out); },
        _ => {}
    }
}

/// The first "1:02:03" / "12:34" text anywhere under `v` (the length badge on a video's thumbnail), in seconds.
fn clock_text(v: &Value) -> Option<f64> {
    match v {
        Value::String(s) => {
            let parts: Vec<&str> = s.trim().split(':').collect();
            if !(2..=3).contains(&parts.len()) || parts.iter().any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit())) { return None; }
            Some(parts.iter().fold(0.0, |acc, p| acc * 60.0 + p.parse::<f64>().unwrap_or(0.0)))
        }
        Value::Object(m) => m.values().find_map(clock_text),
        Value::Array(a) => a.iter().find_map(clock_text),
        _ => None,
    }
}

fn norm(s: &str) -> String { s.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_lowercase()).collect() }

/// "157. …", "#157 …", "EP157 …", "… #157", "Ep 97: …".
fn episode_num(title: &str) -> Option<u32> {
    let re = Regex::new(r"(?i)(?:^\s*(\d{1,4})\s*[.、．:：]\s|(?:\bEP\.?\s*|#\s*|第\s*)0*(\d{1,4})\b)").unwrap();
    let c = re.captures(title)?;
    c.get(1).or_else(|| c.get(2))?.as_str().parse().ok()
}

/// Character bigrams of the normalised title (works for Chinese and English alike).
fn bigrams(s: &str) -> std::collections::HashSet<(char, char)> {
    let c: Vec<char> = norm(s).chars().collect();
    c.windows(2).map(|w| (w[0], w[1])).collect()
}

fn similarity(a: &str, b: &str) -> f64 {
    let (x, y) = (bigrams(a), bigrams(b));
    if x.is_empty() || y.is_empty() { return 0.0; }
    x.intersection(&y).count() as f64 / x.len().min(y.len()) as f64
}

/// The video that is this episode, if one clearly is.
pub fn best_match(title: &str, published: Option<i64>, vids: &[Vid], used: &std::collections::HashSet<String>) -> Option<String> {
    let n = norm(title);
    if n.chars().count() < 6 { return None; }
    let num = episode_num(title);
    let days = |v: &Vid| match (published, v.published) { (Some(a), Some(b)) => Some((a - b).abs() as f64 / 86_400_000.0), _ => None };
    let mut best: Option<(f64, &Vid)> = None;
    for v in vids.iter().filter(|v| !used.contains(&v.id)) {
        let nv = norm(&v.title);
        let d = days(v);
        if d.is_some_and(|d| d > 60.0) { continue; } // a re-upload or another show's numbering
        let sim = similarity(title, &v.title);
        let same_num = num.is_some() && num == episode_num(&v.title);
        let contained = nv == n || (n.chars().count() >= 8 && nv.contains(&n)) || (nv.chars().count() >= 12 && n.contains(&nv));
        let score = if contained { 3.0 + sim }
            else if same_num && (d.is_some_and(|d| d <= 10.0) || sim >= 0.35) { 2.0 + sim }
            else if sim >= 0.8 || (sim >= 0.6 && d.is_some_and(|d| d <= 7.0)) { 1.0 + sim }
            else { continue };
        if best.as_ref().is_none_or(|b| score > b.0) { best = Some((score, v)); }
    }
    best.map(|(_, v)| v.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn v(id: &str, t: &str, d: Option<i64>) -> Vid { Vid { id: id.into(), title: t.into(), published: d, duration: None } }

    #[test]
    fn lengths_from_the_uploads_list() {
        let page = serde_json::json!({"a": [
            {"playlistVideoRenderer": {"videoId": "aaaaaaaaaaa", "title": {"runs": [{"text": "One"}]}, "lengthSeconds": "3725"}},
            {"lockupViewModel": {"contentId": "bbbbbbbbbbb", "metadata": {"lockupMetadataViewModel": {"title": {"content": "Two"}}},
                "contentImage": {"thumbnailViewModel": {"overlays": [{"badge": {"text": "1:02:05"}}]}}}},
            {"lockupViewModel": {"contentId": "ccccccccccc", "metadata": {"lockupMetadataViewModel": {"title": {"content": "Three"}}}}}
        ]});
        let mut out = Vec::new();
        collect(&page, &mut out);
        assert_eq!(out.iter().map(|v| v.duration).collect::<Vec<_>>(), vec![Some(3725.0), Some(3725.0), None]);
        assert_eq!(clock_text(&serde_json::json!("12:34")), Some(754.0));
        assert_eq!(clock_text(&serde_json::json!("LIVE")), None);
        assert_eq!(clock_text(&serde_json::json!("2026:")), None);
    }
    const DAY: i64 = 86_400_000;

    #[test]
    fn matches_by_title_number_and_date() {
        let used = std::collections::HashSet::new();
        let vids = vec![
            v("ZXJ157", "157. 复盘Personal Agent集体诞生背后：和蔡伟聊AI产品史、需求真伪、入口与未来想象", Some(100 * DAY)),
            v("ZXJ156en", "\"Xia\" | A 6-Hour Interview with Soulframe Liang, Producer of Phantom Blade Zero", Some(95 * DAY)),
            v("ZXJ156", "156. 对影之刃零梁其伟6小时访谈：3A游戏、15年创业路上斩妖除魔", Some(95 * DAY)),
            v("LEX505", "GTA 6, Crime, Heists, Mafia, Gangs, Prison, Corrupt Cops, Miami & Money | Lex Fridman Podcast #505", Some(200 * DAY)),
        ];
        // The curated site drops the number; the rss source keeps it.
        assert_eq!(best_match("复盘Personal Agent集体诞生背后：和蔡伟聊AI产品史、需求真伪、入口与未来想象", Some(99 * DAY), &vids, &used).as_deref(), Some("ZXJ157"));
        assert_eq!(best_match("157. 复盘Personal Agent集体诞生背后：和蔡伟聊AI产品史、需求真伪、入口与未来想象", None, &vids, &used).as_deref(), Some("ZXJ157"));
        assert_eq!(best_match("对影之刃零梁其伟6小时访谈：3A游戏、15年创业路上斩妖除魔、命运——\"世界没有敌人，只有你和另一个自己\"", Some(95 * DAY), &vids, &used).as_deref(), Some("ZXJ156"));
        assert_eq!(best_match("#505 – GTA 6, Crime, Jewel Heists, Prison, Mafia, and the Mob", Some(200 * DAY), &vids, &used).as_deref(), Some("LEX505"));
        // Nothing alike, or alike but a year apart.
        assert!(best_match("和科沃斯钱程聊，父与子、企二代接班的样本与肌理", Some(90 * DAY), &vids, &used).is_none());
        assert!(best_match("复盘Personal Agent集体诞生背后：和蔡伟聊AI产品史、需求真伪、入口与未来想象", Some(500 * DAY), &vids, &used).is_none());
    }

    #[test]
    fn numbers_and_channel_ids() {
        assert_eq!(episode_num("157. 复盘"), Some(157));
        assert_eq!(episode_num("#010 黄仁勋"), Some(10));
        assert_eq!(episode_num("EP010 Jensen"), Some(10));
        assert_eq!(episode_num("Ep 97: Jev Creator"), Some(97));
        assert_eq!(episode_num("GPT 6.2 全网群嘲"), None);
        assert_eq!(channel_id_of("https://www.youtube.com/feeds/videos.xml?playlist_id=UULF3Sv1JuKpbOx3csUO8FAo5g").as_deref(), Some("UC3Sv1JuKpbOx3csUO8FAo5g"));
        assert_eq!(channel_id_of("https://www.youtube.com/feeds/videos.xml?channel_id=UC_9pr_usdNG29RauPFwIFQw").as_deref(), Some("UC_9pr_usdNG29RauPFwIFQw"));
        assert_eq!(channel_id_of("none"), None);
    }
}

#[cfg(test)]
mod live {
    use super::*;
    /// Lists what the uploads page and the feed give for a channel, and what the search finds for a name.
    #[tokio::test]
    #[ignore]
    async fn channel_and_discovery() {
        let vids = channel_videos("UC3Sv1JuKpbOx3csUO8FAo5g").await;
        println!("张小珺 uploads: {}", vids.len());
        for v in vids.iter().take(3) { println!("  {} {}", v.id, v.title); }
        for name in ["晚点聊 LateTalk", "42章经", "十字路口Crossing"] {
            let hits = crate::feeds::search_youtube_channels(name).await.unwrap_or_default();
            println!("{name}: {:?}", hits.iter().map(|h| (&h.title, &h.author)).collect::<Vec<_>>());
        }
    }
}

#[cfg(test)]
mod live_sites {
    /// CURATED=zhangxiaojun,latetalk … : how many episodes of each 乔木精读 site end up with a video.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn coverage() {
        let ids = std::env::var("CURATED").unwrap_or_else(|_| "zhangxiaojun".into());
        for id in ids.split(',') {
            let t0 = std::time::Instant::now();
            match crate::qiaomu::channel(id).await {
                Ok(c) => {
                    let with = c.episodes.iter().filter(|e| e.video_id.is_some()).count();
                    println!("{id:<14} {with:>3}/{:<3} with video  ({:.1}s)", c.episodes.len(), t0.elapsed().as_secs_f64());
                    if std::env::var("CHECK").is_ok() {
                        let ch = super::channel_for(id, &c.show.title, &c.episodes).await.unwrap_or_default();
                        let vids = super::channel_videos(&ch).await;
                        for e in c.episodes.iter().filter(|e| e.video_id.is_some()).step_by(7) {
                            let vt = vids.iter().find(|v| Some(&v.id) == e.video_id.as_ref()).map(|v| v.title.clone()).unwrap_or_else(|| "(site-provided)".into());
                            println!("    EP: {}\n    YT: {}", e.title.chars().take(46).collect::<String>(), vt.chars().take(46).collect::<String>());
                        }
                    }
                }
                Err(e) => println!("{id}: {e}"),
            }
        }
    }
}

