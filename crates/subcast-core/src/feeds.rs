//! Turning whatever the user pastes into a subscription, and reading feeds.
//! Every source ends up as RSS/Atom except 小宇宙, whose show page is merged with Apple Podcasts when available.
use crate::model::*;
use crate::net;
use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use roxmltree::{Document, Node, ParsingOptions};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

pub const MAX_EPISODES: usize = 300;

/// Cached mapping from 小宇宙 podcast `pid` -> Apple Podcasts collection id (`None` = searched & not found).
static XYZ_APPLE_ID: Lazy<Mutex<HashMap<String, Option<i64>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub enum Source {
    Feed(String),
    Xiaoyuzhou(String),
    YouTubeVideo(String),
    XiaoyuzhouEpisode(String),
}

fn re(p: &str) -> Regex { Regex::new(p).unwrap() }

/// A feed hosted by 小宇宙 (feed.xyzfm.space), which turns away readers outside its whitelist.
fn is_xyzfm_feed(url: &str) -> bool { url.contains("xyzfm.space/") }

/// Detect the HTML 403 block page returned by `feed.xyzfm.space` (case-insensitive + Chinese fallback text).
fn is_xyzfm_blocked(body: &str) -> bool {
    let head = body.trim_start().get(..800).unwrap_or(body.trim_start());
    if head.starts_with("<?xml") || head.contains("<rss") || head.contains("<feed") {
        return false;
    }
    let lower = body.to_ascii_lowercase();
    lower.contains("403 forbidden") || body.contains("403 · 无法访问") || body.contains("访问受限") // i18n-ignore (xyzfm HTML 403 block page markers)
}

fn extract_xyz_pid(s: &str) -> Option<String> {
    for pat in [
        r"xiaoyuzhoufm\.com/podcast/([0-9a-fA-F]{24})",
        r"media\.xyzcdn\.net/([0-9a-fA-F]{24})",
        r"dts-api\.xiaoyuzhoufm\.com/track/([0-9a-fA-F]{24})",
    ] {
        if let Some(c) = re(pat).captures(s) {
            return Some(c[1].to_ascii_lowercase());
        }
    }
    None
}

fn unwrap_xyz_audio(url: &str) -> String {
    if url.contains("dts-api.xiaoyuzhoufm.com/") {
        if let Some((_, rest)) = url.split_once("/media.xyzcdn.net/") {
            if !rest.is_empty() {
                return format!("https://media.xyzcdn.net/{rest}");
            }
        }
    }
    url.to_string()
}

/// A channel's long-form uploads (the "UULF" playlist), so Shorts do not crowd out real episodes.
pub fn channel_feed(channel_id: &str) -> String {
    format!("https://www.youtube.com/feeds/videos.xml?playlist_id=UULF{}", &channel_id[2..])
}

pub fn youtube_video_id(url: &str) -> Option<String> {
    re(r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|live/|embed/)|youtu\.be/)([A-Za-z0-9_-]{11})")
        .captures(url)
        .map(|c| c[1].to_string())
}

/// Works out what a pasted link points at. May fetch a page (YouTube handles, Apple Podcasts ids, HTML pages).
pub async fn resolve(input: &str) -> Result<Source> {
    let input = input.trim();
    if input.is_empty() {
        return Err(anyhow!("请粘贴链接"));
    }
    let url = if input.starts_with("http://") || input.starts_with("https://") { input.to_string() } else if input.starts_with('@') {
        format!("https://www.youtube.com/{input}")
    } else {
        format!("https://{input}")
    };
    if let Some(id) = youtube_video_id(&url) {
        if !url.contains("list=") || url.contains("watch?v=") {
            return Ok(Source::YouTubeVideo(id));
        }
    }
    if url.contains("youtube.com") {
        if let Some(c) = re(r"[?&]list=([A-Za-z0-9_-]+)").captures(&url) {
            return Ok(Source::Feed(format!("https://www.youtube.com/feeds/videos.xml?playlist_id={}", &c[1])));
        }
        if let Some(c) = re(r"youtube\.com/channel/(UC[A-Za-z0-9_-]{22})").captures(&url) {
            return Ok(Source::Feed(channel_feed(&c[1])));
        }
        if url.contains("feeds/videos.xml") {
            return Ok(Source::Feed(url));
        }
        let html = net::get_text(&url).await?;
        let id = re(r#"<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[A-Za-z0-9_-]{22})""#)
            .captures(&html)
            .or_else(|| re(r#""externalId":"(UC[A-Za-z0-9_-]{22})""#).captures(&html))
            .or_else(|| re(r#""channelId":"(UC[A-Za-z0-9_-]{22})""#).captures(&html))
            .map(|c| c[1].to_string())
            .ok_or_else(|| anyhow!("没有在这个页面找到 YouTube 频道"))?;
        return Ok(Source::Feed(channel_feed(&id)));
    }
    if url.contains("podcasts.apple.com") {
        let id = re(r"/id(\d+)").captures(&url).map(|c| c[1].to_string()).ok_or_else(|| anyhow!("无法识别 Apple Podcasts 链接"))?;
        let v: serde_json::Value = net::client()
            .get(format!("https://itunes.apple.com/lookup?id={id}&entity=podcastEpisode&limit=5"))
            .timeout(Duration::from_secs(10))
            .send()
            .await?
            .json()
            .await?;
        let results = v["results"].as_array().cloned().unwrap_or_default();
        let feed = results.first().and_then(|r| r["feedUrl"].as_str())
            .ok_or_else(|| anyhow!("这档节目没有公开 RSS（可能是 Apple 独家）"))?;
        // 小宇宙-hosted feeds only answer whitelisted readers (403 for everyone else); map to 小宇宙 + cache Apple id.
        if is_xyzfm_feed(feed) {
            let mut pid = results.iter().skip(1).find_map(|r| {
                r["episodeUrl"].as_str().and_then(extract_xyz_pid)
                    .or_else(|| r["previewUrl"].as_str().and_then(extract_xyz_pid))
            });
            if pid.is_none() {
                if let Ok(html) = net::get_text(&format!("https://podcasts.apple.com/podcast/id{id}")).await {
                    pid = extract_xyz_pid(&html);
                }
            }
            if let Some(pid) = pid {
                if let Ok(aid) = id.parse::<i64>() {
                    if let Ok(mut map) = XYZ_APPLE_ID.lock() {
                        map.insert(pid.clone(), Some(aid));
                    }
                }
                return Ok(Source::Xiaoyuzhou(format!("https://www.xiaoyuzhoufm.com/podcast/{pid}")));
            }
            // Fallback to Apple's own episode lookup when xyzfm is blocked and no 小宇宙 pid was exposed.
            return Ok(Source::Feed(format!("https://podcasts.apple.com/podcast/id{id}")));
        }
        return Ok(Source::Feed(feed.to_string()));
    }
    if url.contains("xiaoyuzhoufm.com/podcast/") {
        return Ok(Source::Xiaoyuzhou(url));
    }
    if url.contains("xiaoyuzhoufm.com/episode/") {
        return Ok(Source::XiaoyuzhouEpisode(url));
    }
    // A direct feed is downloaded again by fetch_show. Probing it here made Discover's + wait twice.
    if is_direct_feed(&url) {
        return Ok(Source::Feed(url));
    }
    // Anything else: a feed, or a page that links one.
    let body = net::get_text(&url).await?;
    let head = body.trim_start().get(..800).unwrap_or(body.trim_start());
    let looks_like_xml = head.starts_with("<?xml") || head.contains("<rss") || head.contains("<feed");
    if is_xyzfm_feed(&url) && (is_xyzfm_blocked(&body) || !looks_like_xml) {
        return Err(anyhow!("小宇宙的 RSS 不对外开放，请粘贴小宇宙 App 里分享的节目链接"));
    }
    if looks_like_xml {
        return Ok(Source::Feed(url));
    }
    if let Some(c) = re(r#"<link[^>]+type="application/(?:rss|atom)\+xml"[^>]*href="([^"]+)""#).captures(&body) {
        let href = crate::transcript::decode_entities(&c[1]);
        let abs = reqwest::Url::parse(&url)?.join(&href)?;
        return Ok(Source::Feed(abs.to_string()));
    }
    Err(anyhow!("没有识别出订阅源。支持 YouTube 频道/视频、Apple Podcasts、小宇宙和 RSS 链接"))
}

/// True when `url` is the feed itself (RSS/Atom), not an HTML page that merely links one.
/// YouTube `@handle` pages are not feeds: those still need the channel page to find the id.
pub fn is_direct_feed(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    let rest = u.split_once("://").map(|(_, r)| r).unwrap_or(&u);
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let path = path.split(['?', '#']).next().unwrap_or(path);
    host.starts_with("feeds.") || host.starts_with("rss.")
        || path.ends_with(".xml") || path.ends_with(".rss")
        || path.split('/').any(|s| s == "rss" || s == "feed" || s == "atom")
}

// ---- RSS / Atom ---------------------------------------------------------------------------------

fn child<'a, 'i>(n: Node<'a, 'i>, name: &str) -> Option<Node<'a, 'i>> {
    n.children().find(|c| c.is_element() && c.tag_name().name() == name)
}
fn child_ns<'a, 'i>(n: Node<'a, 'i>, ns: &str, name: &str) -> Option<Node<'a, 'i>> {
    n.children().find(|c| c.is_element() && c.tag_name().name() == name && c.tag_name().namespace().is_some_and(|x| x.contains(ns)))
}
fn text_of(n: Option<Node>) -> Option<String> {
    let t: String = n?.descendants().filter(|d| d.is_text()).map(|d| d.text().unwrap_or("")).collect();
    let t = t.trim().to_string();
    (!t.is_empty()).then_some(t)
}
fn plain_child<'a, 'i>(n: Node<'a, 'i>, name: &str) -> Option<Node<'a, 'i>> {
    n.children().find(|c| c.is_element() && c.tag_name().name() == name && c.tag_name().namespace().is_none_or(|x| x.is_empty() || x.contains("Atom")))
}

fn parse_date(s: &str) -> Option<i64> {
    let s = s.trim();
    // Feeds often get the weekday wrong, which strict RFC 2822 parsing rejects; it is redundant anyway.
    let no_weekday = s.split_once(", ").filter(|(d, _)| d.len() <= 9 && d.chars().all(|c| c.is_ascii_alphabetic())).map(|(_, r)| r).unwrap_or(s);
    chrono::DateTime::parse_from_rfc2822(no_weekday)
        .or_else(|_| chrono::DateTime::parse_from_rfc2822(s))
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(s))
        .or_else(|_| chrono::DateTime::parse_from_str(s, "%a, %d %b %Y %H:%M:%S %Z"))
        .map(|d| d.timestamp_millis())
        .ok()
}

fn parse_duration(s: &str) -> Option<f64> {
    let s = s.trim();
    if let Ok(v) = s.parse::<f64>() {
        return (v > 0.0).then_some(v);
    }
    let mut total = 0.0;
    for p in s.split(':') {
        total = total * 60.0 + p.trim().parse::<f64>().ok()?;
    }
    (total > 0.0).then_some(total)
}

/// Preferred transcript type when a feed lists several.
fn transcript_rank(kind: &str) -> i32 {
    match kind {
        k if k.contains("vtt") => 4,
        k if k.contains("srt") || k.contains("subrip") => 3,
        k if k.contains("json") => 2,
        _ => 0,
    }
}

pub fn parse_feed(xml: &str, feed_url: &str) -> Result<(Show, Vec<Episode>)> {
    parse_feed_limit(xml, feed_url, MAX_EPISODES)
}

pub fn parse_feed_limit(xml: &str, feed_url: &str, limit: usize) -> Result<(Show, Vec<Episode>)> {
    let opts = ParsingOptions { allow_dtd: true, ..Default::default() };
    let doc = Document::parse_with_options(xml, opts).map_err(|e| anyhow!("订阅源格式错误：{e}"))?;
    let root = doc.root_element();
    let show_id = short_hash(feed_url, 16);
    let mut episodes = Vec::new();
    if root.tag_name().name() == "feed" {
        // Atom (YouTube channels and playlists).
        let youtube = feed_url.contains("youtube.com");
        let title = text_of(child(root, "title")).unwrap_or_default();
        let author = child(root, "author").and_then(|a| text_of(child(a, "name")));
        // A channel's uploads playlist is titled "Videos"; the channel is what the user subscribed to.
        let title = if youtube && feed_url.contains("playlist_id=UU") { author.clone().unwrap_or(title) } else { title };
        let link = root.children().find(|c| c.tag_name().name() == "link" && c.attribute("rel") == Some("alternate")).and_then(|l| l.attribute("href")).map(String::from);
        for e in root.children().filter(|c| c.tag_name().name() == "entry").take(limit) {
            let video_id = text_of(child_ns(e, "youtube", "videoId"));
            let guid = video_id.clone().or_else(|| text_of(child(e, "id"))).unwrap_or_default();
            let group = child_ns(e, "search.yahoo.com/mrss", "group");
            let cover = group.and_then(|g| child_ns(g, "mrss", "thumbnail")).and_then(|t| t.attribute("url")).map(String::from);
            let notes = group.and_then(|g| text_of(child_ns(g, "mrss", "description"))).or_else(|| text_of(child(e, "summary")));
            let link = e.children().find(|c| c.tag_name().name() == "link").and_then(|l| l.attribute("href")).map(String::from);
            // Shorts are not what anyone subscribes to a channel for.
            if link.as_deref().is_some_and(|l| l.contains("/shorts/")) { continue; }
            episodes.push(Episode {
                id: short_hash(&format!("{show_id}:{guid}"), 20),
                show_id: show_id.clone(),
                guid,
                title: text_of(child(e, "title")).unwrap_or_default(),
                published: text_of(child(e, "published")).and_then(|d| parse_date(&d)),
                video_id,
                link,
                cover,
                notes: notes.map(|n| n.chars().take(20_000).collect()),
                ..Default::default()
            });
        }
        let cover = episodes.first().and_then(|e| e.cover.clone());
        let show = Show { id: show_id, kind: if youtube { "youtube" } else { "podcast" }.into(), title, author, cover, feed_url: feed_url.into(), link, description: None, updated_at: now_ms(), unplayed: 0 };
        return Ok((show, episodes));
    }
    let channel = child(root, "channel").ok_or_else(|| anyhow!("不是 RSS 订阅源"))?;
    let cover = child_ns(channel, "itunes", "image")
        .and_then(|i| i.attribute("href"))
        .map(String::from)
        .or_else(|| plain_child(channel, "image").and_then(|i| text_of(child(i, "url"))));
    for item in channel.children().filter(|c| c.tag_name().name() == "item").take(limit) {
        let enclosure = child(item, "enclosure");
        let audio = enclosure.and_then(|e| e.attribute("url")).map(|u| u.trim().to_string());
        let link = text_of(plain_child(item, "link"));
        let video_id = link.as_deref().and_then(youtube_video_id);
        if audio.is_none() && video_id.is_none() { continue; }
        let guid = text_of(child(item, "guid")).or_else(|| audio.clone()).unwrap_or_default();
        let transcript = item
            .children()
            .filter(|c| c.tag_name().name() == "transcript" && c.tag_name().namespace().is_some_and(|n| n.contains("podcastindex")))
            .filter_map(|t| Some((t.attribute("url")?.to_string(), t.attribute("type").unwrap_or("").to_lowercase())))
            .filter(|(_, k)| transcript_rank(k) > 0)
            .max_by_key(|(_, k)| transcript_rank(k));
        let notes = text_of(child_ns(item, "purl.org/rss/1.0/modules/content", "encoded"))
            .or_else(|| text_of(plain_child(item, "description")))
            .or_else(|| text_of(child_ns(item, "itunes", "summary")));
        episodes.push(Episode {
            id: short_hash(&format!("{show_id}:{guid}"), 20),
            show_id: show_id.clone(),
            guid,
            title: text_of(plain_child(item, "title")).unwrap_or_default(),
            published: text_of(child(item, "pubDate")).and_then(|d| parse_date(&d)),
            duration: text_of(child_ns(item, "itunes", "duration")).and_then(|d| parse_duration(&d)),
            audio_url: audio,
            video_id,
            link,
            cover: child_ns(item, "itunes", "image").and_then(|i| i.attribute("href")).map(String::from),
            notes: notes.map(|n| n.chars().take(40_000).collect()),
            transcript_url: transcript.as_ref().map(|t| t.0.clone()),
            transcript_type: transcript.map(|t| t.1),
            ..Default::default()
        });
    }
    let show = Show {
        id: show_id,
        kind: "podcast".into(),
        title: text_of(plain_child(channel, "title")).unwrap_or_default(),
        author: text_of(child_ns(channel, "itunes", "author")),
        cover,
        feed_url: feed_url.into(),
        link: text_of(plain_child(channel, "link")),
        description: text_of(plain_child(channel, "description")).map(|d| d.chars().take(2000).collect()),
        updated_at: now_ms(),
        unplayed: 0,
    };
    Ok((show, episodes))
}

// ---- 小宇宙 ---------------------------------------------------------------------------------------

fn next_data(html: &str) -> Result<serde_json::Value> {
    let c = re(r#"(?s)<script id="__NEXT_DATA__"[^>]*>(.*?)</script>"#).captures(html).ok_or_else(|| anyhow!("小宇宙页面结构变化，读取失败"))?;
    Ok(serde_json::from_str(&c[1])?)
}

fn xyz_episode(e: &serde_json::Value, show_id: &str) -> Option<Episode> {
    let eid = e["eid"].as_str()?;
    Some(Episode {
        id: short_hash(&format!("{show_id}:{eid}"), 20),
        show_id: show_id.to_string(),
        guid: eid.to_string(),
        title: e["title"].as_str().unwrap_or_default().to_string(),
        published: e["pubDate"].as_str().and_then(parse_date),
        duration: e["duration"].as_f64(),
        audio_url: e["enclosure"]["url"].as_str().or_else(|| e["media"]["source"]["url"].as_str()).map(String::from),
        link: Some(format!("https://www.xiaoyuzhoufm.com/episode/{eid}")),
        cover: e["image"]["picUrl"].as_str().map(String::from),
        notes: e["shownotes"].as_str().or_else(|| e["description"].as_str()).map(String::from),
        ..Default::default()
    })
}

fn extract_xyz_eid(s: &str) -> Option<String> {
    for pat in [
        r"xiaoyuzhoufm\.com/episode/([0-9a-fA-F]{24})",
        r"dts-api\.xiaoyuzhoufm\.com/track/[0-9a-fA-F]{24}/([0-9a-fA-F]{24})",
    ] {
        if let Some(c) = re(pat).captures(s) {
            return Some(c[1].to_ascii_lowercase());
        }
    }
    None
}

fn episode_xyz_eid(ep: &Episode) -> Option<String> {
    ep.link.as_deref().and_then(extract_xyz_eid)
        .or_else(|| ep.audio_url.as_deref().and_then(extract_xyz_eid))
        .or_else(|| {
            let g = ep.guid.trim();
            if re(r"^[0-9a-fA-F]{24}$").is_match(g) {
                Some(g.to_ascii_lowercase())
            } else {
                extract_xyz_eid(g)
            }
        })
}

fn normalize_audio_key(url: &str) -> String {
    let unwrapped = unwrap_xyz_audio(url.trim());
    unwrapped.split('?').next().unwrap_or(&unwrapped).to_string()
}

fn parse_apple_episodes(show_id: &str, results: &[serde_json::Value]) -> Vec<Episode> {
    results.iter().filter(|e| e["wrapperType"].as_str() == Some("podcastEpisode")).filter_map(|e| {
        let title = e["trackName"].as_str().map(str::trim).filter(|s| !s.is_empty())?.to_string();
        let raw_audio = e["episodeUrl"].as_str()
            .or_else(|| e["previewUrl"].as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let audio_url = raw_audio.map(unwrap_xyz_audio);
        let guid = e["episodeGuid"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
            .or_else(|| raw_audio.map(unwrap_xyz_audio))
            .or_else(|| e["trackId"].as_i64().map(|n| n.to_string()))
            .unwrap_or_else(|| short_hash(&title, 12));
        let id = short_hash(&format!("{show_id}:{guid}"), 16);
        let published = e["releaseDate"].as_str().and_then(parse_date);
        let duration = e["trackTimeMillis"].as_f64().filter(|&ms| ms > 0.0).map(|ms| ms / 1000.0);
        let link = raw_audio.and_then(extract_xyz_eid)
            .map(|eid| format!("https://www.xiaoyuzhoufm.com/episode/{eid}"))
            .or_else(|| e["trackViewUrl"].as_str().filter(|s| !s.is_empty()).map(String::from));
        let cover = e["artworkUrl600"].as_str()
            .or_else(|| e["artworkUrl160"].as_str())
            .or_else(|| e["artworkUrl60"].as_str())
            .filter(|s| !s.is_empty())
            .map(String::from);
        let notes = e["description"].as_str()
            .or_else(|| e["shortDescription"].as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        Some(Episode {
            id,
            show_id: show_id.into(),
            guid,
            title,
            published,
            duration,
            audio_url,
            link,
            cover,
            notes,
            ..Episode::default()
        })
    }).collect()
}

fn apple_matches_xyz_pid(pid: &str, web_eps: &[Episode], results: &[serde_json::Value]) -> bool {
    let target_pid = pid.to_ascii_lowercase();
    for r in results {
        for key in ["episodeUrl", "previewUrl"] {
            if let Some(u) = r[key].as_str() {
                if extract_xyz_pid(u).as_deref() == Some(target_pid.as_str()) {
                    return true;
                }
            }
        }
    }
    if web_eps.is_empty() {
        return false;
    }
    let web_guids: HashSet<&str> = web_eps.iter().map(|e| e.guid.trim()).filter(|s| !s.is_empty()).collect();
    let web_eids: HashSet<String> = web_eps.iter().filter_map(episode_xyz_eid).collect();
    let web_audios: HashSet<String> = web_eps.iter().filter_map(|e| e.audio_url.as_deref()).map(normalize_audio_key).collect();
    for r in results {
        if r["wrapperType"].as_str() != Some("podcastEpisode") {
            continue;
        }
        if let Some(g) = r["episodeGuid"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
            if web_guids.contains(g) {
                return true;
            }
            if let Some(eid) = extract_xyz_eid(g) {
                if web_eids.contains(&eid) {
                    return true;
                }
            }
        }
        for key in ["episodeUrl", "previewUrl"] {
            if let Some(u) = r[key].as_str().map(str::trim).filter(|s| !s.is_empty()) {
                if web_audios.contains(&normalize_audio_key(u)) {
                    return true;
                }
                if let Some(eid) = extract_xyz_eid(u) {
                    if web_eids.contains(&eid) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn same_episode(a: &Episode, b: &Episode) -> bool {
    if !a.guid.is_empty() && a.guid == b.guid {
        return true;
    }
    if let (Some(ua), Some(ub)) = (a.audio_url.as_deref(), b.audio_url.as_deref()) {
        if !ua.is_empty() && !ub.is_empty() && normalize_audio_key(ua) == normalize_audio_key(ub) {
            return true;
        }
    }
    if let (Some(ea), Some(eb)) = (episode_xyz_eid(a), episode_xyz_eid(b)) {
        if ea == eb {
            return true;
        }
    }
    let ta = a.title.trim();
    let tb = b.title.trim();
    if !ta.is_empty() && ta == tb {
        if let (Some(pa), Some(pb)) = (a.published, b.published) {
            if (pa - pb).abs() <= 172_800_000 {
                return true;
            }
        }
    }
    false
}

fn merge_episodes(web: Vec<Episode>, apple: Vec<Episode>) -> Vec<Episode> {
    let mut out = web;
    for a in apple {
        if let Some(existing) = out.iter_mut().find(|w| same_episode(w, &a)) {
            if existing.published.is_none() {
                existing.published = a.published;
            }
            if existing.duration.unwrap_or(0.0) <= 0.0 {
                existing.duration = a.duration;
            }
            if existing.audio_url.as_deref().unwrap_or("").is_empty() {
                existing.audio_url = a.audio_url;
            }
            if existing.cover.as_deref().unwrap_or("").is_empty() {
                existing.cover = a.cover;
            }
            if existing.link.as_deref().unwrap_or("").is_empty() {
                existing.link = a.link;
            }
            match (&existing.notes, &a.notes) {
                (None, Some(an)) => existing.notes = Some(an.clone()),
                (Some(wn), Some(an)) if an.chars().count() > wn.chars().count() => existing.notes = Some(an.clone()),
                _ => {}
            }
        } else {
            out.push(a);
        }
    }
    out.sort_by(|a, b| b.published.unwrap_or(0).cmp(&a.published.unwrap_or(0)));
    out.truncate(MAX_EPISODES);
    out
}

async fn fetch_apple_lookup(apple_id: i64) -> Result<Vec<serde_json::Value>> {
    let v: serde_json::Value = net::client()
        .get(format!("https://itunes.apple.com/lookup?id={apple_id}&entity=podcastEpisode&limit=200"))
        .timeout(Duration::from_secs(6))
        .send()
        .await?
        .json()
        .await?;
    Ok(v["results"].as_array().cloned().unwrap_or_default())
}

async fn find_apple_for_xyz(pid: &str, title: &str, web_eps: &[Episode]) -> Result<Option<(i64, Vec<serde_json::Value>)>> {
    let q = title.trim();
    if q.is_empty() {
        return Ok(None);
    }
    let v: serde_json::Value = net::client()
        .get(format!(
            "https://itunes.apple.com/search?term={}&entity=podcast&country=CN&limit=5",
            urlencoding::encode(q)
        ))
        .timeout(Duration::from_secs(6))
        .send()
        .await?
        .json()
        .await?;
    let results = v["results"].as_array().cloned().unwrap_or_default();
    let ql = q.to_lowercase();
    let mut candidates: Vec<(i32, i64)> = results.iter().filter_map(|r| {
        let cid = r["collectionId"].as_i64()?;
        let cname = r["collectionName"].as_str().unwrap_or_default().to_lowercase();
        let feed = r["feedUrl"].as_str().unwrap_or_default();
        let mut score = 0;
        if is_xyzfm_feed(feed) { score += 4; }
        if cname == ql { score += 3; } else if cname.contains(&ql) || ql.contains(&cname) { score += 1; }
        Some((score, cid))
    }).collect();
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates.dedup_by_key(|c| c.1);
    for (_, cid) in candidates.into_iter().take(2) {
        if let Ok(rows) = fetch_apple_lookup(cid).await {
            if apple_matches_xyz_pid(pid, web_eps, &rows) {
                return Ok(Some((cid, rows)));
            }
        }
    }
    Ok(None)
}

fn apple_show_from_results(
    show_id: &str,
    kind: &str,
    feed_url: String,
    link: Option<String>,
    results: &[serde_json::Value],
) -> Result<(Show, Vec<Episode>)> {
    let meta = results.first().ok_or_else(|| anyhow!("Apple Podcasts 没有返回节目信息"))?;
    let title = meta["collectionName"].as_str()
        .or_else(|| meta["trackName"].as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Apple Podcasts 节目信息不完整"))?
        .to_string();
    let show = Show {
        id: show_id.into(),
        kind: kind.into(),
        title,
        author: meta["artistName"].as_str().filter(|s| !s.is_empty()).map(String::from),
        cover: meta["artworkUrl600"].as_str()
            .or_else(|| meta["artworkUrl100"].as_str())
            .or_else(|| meta["artworkUrl60"].as_str())
            .filter(|s| !s.is_empty())
            .map(String::from),
        feed_url,
        link,
        description: None,
        updated_at: now_ms(),
        unplayed: 0,
    };
    let episodes = merge_episodes(Vec::new(), parse_apple_episodes(show_id, results));
    Ok((show, episodes))
}

async fn xiaoyuzhou_web_show(url: &str) -> Result<(Show, Vec<Episode>)> {
    let v = next_data(&net::get_text(url).await?)?;
    let p = &v["props"]["pageProps"]["podcast"];
    let pid = p["pid"].as_str().ok_or_else(|| anyhow!("没有找到小宇宙节目"))?;
    let feed_url = format!("https://www.xiaoyuzhoufm.com/podcast/{pid}");
    let show_id = short_hash(&feed_url, 16);
    let episodes = p["episodes"].as_array().into_iter().flatten().filter_map(|e| xyz_episode(e, &show_id)).collect();
    let show = Show {
        id: show_id,
        kind: "xiaoyuzhou".into(),
        title: p["title"].as_str().unwrap_or_default().into(),
        author: p["author"].as_str().map(String::from),
        cover: p["image"]["middlePicUrl"].as_str().or_else(|| p["image"]["picUrl"].as_str()).map(String::from),
        feed_url: feed_url.clone(),
        link: Some(feed_url),
        description: p["description"].as_str().map(String::from),
        updated_at: now_ms(),
        unplayed: 0,
    };
    Ok((show, episodes))
}

pub async fn xiaoyuzhou_show(url: &str) -> Result<(Show, Vec<Episode>)> {
    let pid_hint = extract_xyz_pid(url);
    let cached = pid_hint.as_ref().and_then(|p| XYZ_APPLE_ID.lock().ok().and_then(|m| m.get(p).copied()));
    match cached {
        Some(Some(aid)) => {
            let (web_res, apple_res) = tokio::join!(xiaoyuzhou_web_show(url), fetch_apple_lookup(aid));
            match (web_res, apple_res) {
                (Ok((show, web_eps)), Ok(rows)) => {
                    let episodes = match extract_xyz_pid(&show.feed_url) {
                        Some(pid) if apple_matches_xyz_pid(&pid, &web_eps, &rows) => {
                            merge_episodes(web_eps, parse_apple_episodes(&show.id, &rows))
                        }
                        _ => merge_episodes(web_eps, Vec::new()),
                    };
                    Ok((show, episodes))
                }
                (Ok((show, web_eps)), Err(_)) => Ok((show, merge_episodes(web_eps, Vec::new()))),
                (Err(err), Ok(rows)) => {
                    if let Some(pid) = pid_hint {
                        let feed_url = format!("https://www.xiaoyuzhoufm.com/podcast/{pid}");
                        let show_id = short_hash(&feed_url, 16);
                        if let Ok((show, eps)) = apple_show_from_results(&show_id, "xiaoyuzhou", feed_url.clone(), Some(feed_url), &rows) {
                            if !eps.is_empty() {
                                return Ok((show, eps));
                            }
                        }
                    }
                    Err(err)
                }
                (Err(err), Err(_)) => Err(err),
            }
        }
        Some(None) => xiaoyuzhou_web_show(url).await,
        None => {
            let (show, web_eps) = xiaoyuzhou_web_show(url).await?;
            let Some(pid) = extract_xyz_pid(&show.feed_url) else {
                return Ok((show, web_eps));
            };
            let cached_after = XYZ_APPLE_ID.lock().ok().and_then(|m| m.get(&pid).copied());
            let apple_rows = match cached_after {
                Some(Some(aid)) => fetch_apple_lookup(aid).await.ok().filter(|rows| apple_matches_xyz_pid(&pid, &web_eps, rows)),
                Some(None) => None,
                None => match find_apple_for_xyz(&pid, &show.title, &web_eps).await {
                    Ok(Some((aid, rows))) => {
                        if let Ok(mut map) = XYZ_APPLE_ID.lock() {
                            map.insert(pid, Some(aid));
                        }
                        Some(rows)
                    }
                    Ok(None) => {
                        if let Ok(mut map) = XYZ_APPLE_ID.lock() {
                            map.insert(pid, None);
                        }
                        None
                    }
                    Err(_) => None,
                },
            };
            let episodes = match apple_rows {
                Some(rows) => merge_episodes(web_eps, parse_apple_episodes(&show.id, &rows)),
                None => merge_episodes(web_eps, Vec::new()),
            };
            Ok((show, episodes))
        }
    }
}

async fn apple_podcast_show(url: &str) -> Result<(Show, Vec<Episode>)> {
    let id_str = re(r"/id(\d+)").captures(url).map(|c| c[1].to_string())
        .ok_or_else(|| anyhow!("无法识别 Apple Podcasts 链接"))?;
    let id: i64 = id_str.parse().map_err(|_| anyhow!("无法识别 Apple Podcasts 链接"))?;
    let rows = fetch_apple_lookup(id).await?;
    let feed_url = format!("https://podcasts.apple.com/podcast/id{id}");
    let show_id = short_hash(&feed_url, 16);
    apple_show_from_results(&show_id, "podcast", feed_url.clone(), Some(feed_url), &rows)
}

pub async fn xiaoyuzhou_episode(url: &str) -> Result<Episode> {
    let v = next_data(&net::get_text(url).await?)?;
    let e = &v["props"]["pageProps"]["episode"];
    let mut ep = xyz_episode(e, "single").ok_or_else(|| anyhow!("没有找到这集节目"))?;
    ep.cover = ep.cover.or_else(|| e["podcast"]["image"]["middlePicUrl"].as_str().map(String::from));
    Ok(ep)
}

pub async fn fetch_show(feed_url: &str, kind: &str) -> Result<(Show, Vec<Episode>)> {
    if kind == "xiaoyuzhou" {
        return xiaoyuzhou_show(feed_url).await;
    }
    if feed_url.contains("podcasts.apple.com/") && re(r"/id\d+").is_match(feed_url) {
        return apple_podcast_show(feed_url).await;
    }
    let xml = net::get_text(feed_url).await?;
    if is_xyzfm_blocked(&xml) {
        return Err(anyhow!("小宇宙的 RSS 不对外开放，请粘贴小宇宙 App 里分享的节目链接"));
    }
    parse_feed(&xml, feed_url)
}

/// Channel id carried by a YouTube uploads feed. The show cover in that feed is a video thumbnail, not the avatar.
pub fn youtube_channel_id_from_feed(feed_url: &str) -> Option<String> {
    if let Some(c) = re(r"[?&]channel_id=(UC[A-Za-z0-9_-]{22})").captures(feed_url) {
        return Some(c[1].to_string());
    }
    // UULF is the long-form playlist; UU is every upload. Either way the 22 characters after the prefix are the channel id without "UC".
    if let Some(c) = re(r"[?&]playlist_id=UU(?:LF|LL|SH)?([A-Za-z0-9_-]{22})").captures(feed_url) {
        return Some(format!("UC{}", &c[1]));
    }
    None
}

fn og_image(html: &str) -> Option<String> {
    let raw = re(r#"<meta property="og:image" content="([^"]+)""#).captures(html)?.get(1)?.as_str();
    let url = raw.replace("&amp;", "&");
    // The page asks for a large copy. The sidebar only needs a small one, and the smaller file inlines faster.
    let url = re(r"=s\d+").replace(&url, "=s176").into_owned();
    is_youtube_avatar_host(&url).then_some(url)
}

const AVATAR_HOSTS: &[&str] = &["https://yt3.ggpht.com/", "https://yt3.googleusercontent.com/"];
const AVATAR_MAX: usize = 256 * 1024;

fn is_youtube_avatar_host(url: &str) -> bool {
    AVATAR_HOSTS.iter().any(|host| url.starts_with(host))
}

fn image_data_url(mime: &str, bytes: &[u8]) -> Option<String> {
    let mime = mime.split(';').next().unwrap_or("").trim();
    if !mime.starts_with("image/") || mime.contains(['"', ' ', '\n']) { return None; }
    if bytes.is_empty() || bytes.len() > AVATAR_MAX { return None; }
    use base64::Engine;
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

async fn inline_youtube_avatar(url: &str) -> Option<String> {
    if !is_youtube_avatar_host(url) { return None; }
    tokio::time::timeout(std::time::Duration::from_secs(4), async {
        let mut res = net::get(url).await.ok()?;
        let mime = res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("image/jpeg").to_string();
        let mut bytes = Vec::new();
        while let Some(chunk) = res.chunk().await.ok()? {
            if chunk.len() > AVATAR_MAX - bytes.len() { return None; }
            bytes.extend_from_slice(&chunk);
        }
        image_data_url(&mime, &bytes)
    }).await.ok().flatten()
}

/// The channel's own picture, as a data URL the webview can show. None keeps the video thumbnail already on the show.
pub async fn youtube_channel_avatar(feed_url: &str) -> Option<String> {
    let id = youtube_channel_id_from_feed(feed_url)?;
    let html = net::get_text(&format!("https://www.youtube.com/channel/{id}")).await.ok()?;
    let url = og_image(&html)?;
    inline_youtube_avatar(&url).await
}

// ---- search -------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub title: String,
    pub author: String,
    pub cover: Option<String>,
    pub feed_url: String,
    pub genre: Option<String>,
    pub episodes: Option<i64>,
    /// "youtube" for a YouTube channel; absent for a podcast from Apple's directory.
    pub source: Option<String>,
}

/// Channels first (they carry video), then podcasts. Either search may fail on its own (YouTube is
/// unreachable without a proxy in mainland China); only when both fail is it an error.
pub async fn search_podcasts(term: &str, country: &str) -> Result<Vec<SearchResult>> {
    let (yt, pods) = tokio::join!(search_youtube_channels(term), search_apple(term, country));
    let mut out = yt.unwrap_or_default();
    match pods {
        Ok(p) => out.extend(p),
        Err(e) if out.is_empty() => return Err(e),
        Err(_) => {}
    }
    Ok(out)
}

/// The top few channels from YouTube's own search page (channel filter), read from its embedded ytInitialData.
pub(crate) async fn search_youtube_channels(term: &str) -> Result<Vec<SearchResult>> {
    const MAX: usize = 3;
    // YouTube now and then serves a results page with no results in it (about one in ten): ask again.
    let mut found = Vec::new();
    for attempt in 0..3 {
        let html = net::get_text(&format!("https://www.youtube.com/results?search_query={}&sp=EgIQAg%253D%253D", urlencoding::encode(term))).await?;
        if let Some(json) = re(r"var ytInitialData = (\{.*?\});</script>").captures(&html) {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&json[1]) { collect_channels(&data, &mut found, MAX); }
        }
        if !found.is_empty() || attempt == 2 { break; }
    }
    // Covers are yt3.ggpht.com URLs. The webview loads them itself and draws a broken-image question mark when
    // that request fails; this client is the one that already reached YouTube (including via the app proxy).
    // Fetch the avatar here and hand the webview a data URL. A failed fetch keeps the original URL.
    let inlined = futures_util::future::join_all(found.iter().map(|r| {
        let url = r.cover.clone();
        async move { match url { Some(u) => inline_youtube_avatar(&u).await, None => None } }
    })).await;
    for (row, data) in found.iter_mut().zip(inlined) {
        if data.is_some() { row.cover = data; }
    }
    Ok(found)
}

fn collect_channels(v: &serde_json::Value, out: &mut Vec<SearchResult>, max: usize) {
    if out.len() >= max { return; }
    match v {
        serde_json::Value::Object(m) => {
            if let Some(c) = m.get("channelRenderer") {
                if let (Some(id), Some(title)) = (c["channelId"].as_str(), c["title"]["simpleText"].as_str()) {
                    if id.starts_with("UC") && id.len() == 24 {
                        let cover = c["thumbnail"]["thumbnails"].as_array().and_then(|t| t.last()).and_then(|t| t["url"].as_str())
                            .map(|u| if u.starts_with("//") { format!("https:{u}") } else { u.to_string() });
                        out.push(SearchResult {
                            title: title.into(),
                            // The handle (@name); YouTube puts it in subscriberCountText in the current layout.
                            author: c["subscriberCountText"]["simpleText"].as_str().filter(|h| h.starts_with('@')).unwrap_or("YouTube").into(),
                            cover,
                            feed_url: channel_feed(id),
                            genre: None,
                            episodes: None,
                            source: Some("youtube".into()),
                        });
                    }
                }
                return;
            }
            for x in m.values() { collect_channels(x, out, max); }
        }
        serde_json::Value::Array(a) => for x in a { collect_channels(x, out, max); },
        _ => {}
    }
}

async fn search_apple(term: &str, country: &str) -> Result<Vec<SearchResult>> {
    let url = format!(
        "https://itunes.apple.com/search?media=podcast&entity=podcast&limit=25&country={}&term={}",
        country,
        urlencoding::encode(term)
    );
    let v: serde_json::Value = net::get_json(&url).await?;
    Ok(v["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            Some(SearchResult {
                title: r["collectionName"].as_str()?.into(),
                author: r["artistName"].as_str().unwrap_or("").into(),
                cover: r["artworkUrl600"].as_str().or_else(|| r["artworkUrl100"].as_str()).map(String::from),
                // A 小宇宙-hosted feed can't be read directly; subscribing through the Apple link finds its 小宇宙 page.
                feed_url: match (r["feedUrl"].as_str()?, r["collectionId"].as_i64()) {
                    (f, Some(id)) if is_xyzfm_feed(f) => format!("https://podcasts.apple.com/podcast/id{id}"),
                    (f, _) => f.into(),
                },
                genre: r["primaryGenreName"].as_str().map(String::from),
                episodes: r["trackCount"].as_i64(),
                source: None,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rss_with_transcript() {
        let xml = r#"<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Show</title><itunes:image href="https://x/c.jpg"/>
        <item><title>Ep 1</title><guid>g1</guid><pubDate>Mon, 10 Nov 2026 10:00:00 GMT</pubDate><itunes:duration>1:02:03</itunes:duration>
        <enclosure url="https://x/1.mp3" type="audio/mpeg"/><podcast:transcript url="https://x/1.json" type="application/json"/><podcast:transcript url="https://x/1.vtt" type="text/vtt"/></item></channel></rss>"#;
        let (s, e) = parse_feed(xml, "https://x/feed").unwrap();
        assert_eq!(s.title, "Show");
        assert_eq!(s.cover.as_deref(), Some("https://x/c.jpg"));
        assert_eq!(e[0].duration, Some(3723.0));
        assert_eq!(e[0].transcript_url.as_deref(), Some("https://x/1.vtt"));
        assert!(e[0].published.is_some());
    }
    #[test]
    fn youtube_channel_results() {
        let data: serde_json::Value = serde_json::from_str(r#"{"contents":[{"itemSectionRenderer":{"contents":[
            {"channelRenderer":{"channelId":"UC33VP_gIBzCVcEvaGKBocZA","title":{"simpleText":"罗永浩的十字路口"},"subscriberCountText":{"simpleText":"@罗永浩的十字路口"},"thumbnail":{"thumbnails":[{"url":"//yt3.ggpht.com/a=s88"},{"url":"//yt3.ggpht.com/a=s176"}]}}},
            {"channelRenderer":{"channelId":"UC3Ilesza14SKQBwCTCmhj4w","title":{"simpleText":"二号"},"thumbnail":{"thumbnails":[]}}},
            {"channelRenderer":{"channelId":"UCvtFgYy1WF1sJvgcAAj1VIw","title":{"simpleText":"三号"}}},
            {"channelRenderer":{"channelId":"UCA6enTYxSFdTtUsHFZOFmZg","title":{"simpleText":"四号"}}}]}}]}"#).unwrap();
        let mut out = Vec::new();
        collect_channels(&data, &mut out, 3);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].feed_url, "https://www.youtube.com/feeds/videos.xml?playlist_id=UULF33VP_gIBzCVcEvaGKBocZA");
        assert_eq!(out[0].author, "@罗永浩的十字路口");
        assert_eq!(out[0].cover.as_deref(), Some("https://yt3.ggpht.com/a=s176"));
        assert_eq!(out[1].author, "YouTube");
    }
    #[test]
    fn channel_id_comes_from_the_uploads_feed() {
        assert_eq!(
            youtube_channel_id_from_feed("https://www.youtube.com/feeds/videos.xml?playlist_id=UULFFDMMIHbtRdrVhHlGXVzApA").as_deref(),
            Some("UCFDMMIHbtRdrVhHlGXVzApA")
        );
        assert_eq!(
            youtube_channel_id_from_feed("https://www.youtube.com/feeds/videos.xml?channel_id=UCFDMMIHbtRdrVhHlGXVzApA").as_deref(),
            Some("UCFDMMIHbtRdrVhHlGXVzApA")
        );
        assert!(youtube_channel_id_from_feed("https://example.com/feed.xml").is_none());
    }
    #[test]
    fn channel_page_og_image_is_a_small_avatar() {
        let html = r#"<html><meta property="og:image" content="https://yt3.googleusercontent.com/abc=s900-c-k-c0x00ffffff-no-rj"></html>"#;
        assert_eq!(og_image(html).as_deref(), Some("https://yt3.googleusercontent.com/abc=s176-c-k-c0x00ffffff-no-rj"));
        assert!(og_image(r#"<meta property="og:image" content="https://evil.example/a.jpg">"#).is_none());
    }
    #[test]
    fn avatar_data_url_stays_on_youtube_hosts() {
        assert!(is_youtube_avatar_host("https://yt3.ggpht.com/abc=s176-c-k-c0x00ffffff-no-rj-mo"));
        assert!(is_youtube_avatar_host("https://yt3.googleusercontent.com/abc"));
        assert!(!is_youtube_avatar_host("https://yt3.ggpht.com.evil.test/abc"));
        assert!(!is_youtube_avatar_host("http://yt3.ggpht.com/abc"));
        assert!(!is_youtube_avatar_host("https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"));
        let url = image_data_url("image/jpeg; charset=binary", &[0xff, 0xd8, 1, 2]).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"));
        assert!(image_data_url("text/html", &[1, 2, 3]).is_none());
        assert!(image_data_url("image/jpeg", &[]).is_none());
        assert!(image_data_url("image/jpeg", &vec![1u8; AVATAR_MAX + 1]).is_none());
    }
    /// Network: a Chinese name finds the YouTube channel first, and a 小宇宙-hosted show resolves to its 小宇宙 page.
    #[tokio::test]
    #[ignore]
    async fn live_search_and_xyzfm() {
        let r = search_podcasts("罗永浩的十字路口", "CN").await.unwrap();
        assert_eq!(r[0].source.as_deref(), Some("youtube"), "{:?}", r.iter().map(|x| &x.title).collect::<Vec<_>>());
        let apple = r.iter().find(|x| x.source.is_none() && x.feed_url.contains("podcasts.apple.com")).expect("小宇宙 show via Apple");
        match resolve(&apple.feed_url).await.unwrap() {
            Source::Xiaoyuzhou(u) => assert_eq!(u, "https://www.xiaoyuzhoufm.com/podcast/68981df29e7bcd326eb91d88"),
            _ => panic!("expected the 小宇宙 page"),
        }
    }
    #[test]
    fn direct_feeds_skip_the_probe() {
        assert!(is_direct_feed("https://feeds.simplecast.com/JGE3yC0V"));
        assert!(is_direct_feed("https://rss.libsyn.com/shows/61840/destinations/240976.xml"));
        assert!(is_direct_feed("https://anchor.fm/s/f7cac464/podcast/rss"));
        assert!(is_direct_feed("https://api.substack.com/feed/podcast/10845.rss"));
        assert!(!is_direct_feed("https://www.youtube.com/@ycombinator"));
        assert!(!is_direct_feed("https://podcasts.apple.com/us/podcast/example/id123"));
    }
    #[test]
    fn video_ids() {
        assert_eq!(youtube_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(youtube_video_id("https://youtu.be/dQw4w9WgXcQ").as_deref(), Some("dQw4w9WgXcQ"));
    }

    /// Network: the 小宇宙 page carries the full shownotes that rss.qiaomu.ai cuts to ~300 characters.
    #[tokio::test]
    #[ignore]
    async fn xiaoyuzhou_full_shownotes() {
        let ep = xiaoyuzhou_episode("https://www.xiaoyuzhoufm.com/episode/6af9e512fe62f8f52c4ba6fb").await.unwrap();
        let n = ep.notes.unwrap_or_default();
        println!("shownotes chars: {}", n.chars().count());
        assert!(n.chars().count() > 600);
    }

    #[test]
    fn xyzfm_403_detection() {
        assert!(is_xyzfm_blocked("403 FORBIDDEN"));
        assert!(is_xyzfm_blocked("403 Forbidden"));
        assert!(is_xyzfm_blocked("<html><title>403 · 无法访问</title><footer>403 FORBIDDEN · 访问受限</footer></html>"));
        assert!(!is_xyzfm_blocked("<?xml version=\"1.0\"?><rss><channel><description>403 Forbidden</description></channel></rss>"));
    }

    #[test]
    fn xyz_audio_unwrap_and_pid() {
        let wrapped = "https://dts-api.xiaoyuzhoufm.com/track/626b46ea9cbbf0451cf5a962/6af9e512fe62f8f52c4ba6fb/media.xyzcdn.net/626b46ea9cbbf0451cf5a962/lqv9test.m4a";
        assert_eq!(
            unwrap_xyz_audio(wrapped),
            "https://media.xyzcdn.net/626b46ea9cbbf0451cf5a962/lqv9test.m4a"
        );
        let direct = "https://media.xyzcdn.net/626b46ea9cbbf0451cf5a962/lqv9test.m4a";
        assert_eq!(unwrap_xyz_audio(direct), direct);
        assert_eq!(extract_xyz_pid("https://www.xiaoyuzhoufm.com/podcast/626b46ea9cbbf0451cf5a962").as_deref(), Some("626b46ea9cbbf0451cf5a962"));
        assert_eq!(extract_xyz_pid(wrapped).as_deref(), Some("626b46ea9cbbf0451cf5a962"));
        assert_eq!(extract_xyz_pid(direct).as_deref(), Some("626b46ea9cbbf0451cf5a962"));
        assert_eq!(extract_xyz_eid(wrapped).as_deref(), Some("6af9e512fe62f8f52c4ba6fb"));
        assert_eq!(extract_xyz_eid("https://www.xiaoyuzhoufm.com/episode/6af9e512fe62f8f52c4ba6fb").as_deref(), Some("6af9e512fe62f8f52c4ba6fb"));
    }

    #[test]
    fn apple_episodes_and_pid_matching() {
        let rows = vec![
            serde_json::json!({
                "wrapperType": "track",
                "collectionName": "张小珺",
                "artistName": "张小珺",
                "artworkUrl600": "https://example.com/show.jpg"
            }),
            serde_json::json!({
                "wrapperType": "podcastEpisode",
                "trackId": 1001,
                "trackName": "157. 测试一期",
                "episodeGuid": "ep-guid-157",
                "releaseDate": "2026-11-18T03:08:54Z",
                "trackTimeMillis": 3600000,
                "episodeUrl": "https://dts-api.xiaoyuzhoufm.com/track/626b46ea9cbbf0451cf5a962/6af9e512fe62f8f52c4ba6fb/media.xyzcdn.net/626b46ea9cbbf0451cf5a962/test157.m4a",
                "artworkUrl600": "https://example.com/ep157.jpg",
                "description": "完整介绍内容"
            }),
        ];
        let eps = parse_apple_episodes("show123", &rows);
        assert_eq!(eps.len(), 1);
        assert_eq!(eps[0].audio_url.as_deref(), Some("https://media.xyzcdn.net/626b46ea9cbbf0451cf5a962/test157.m4a"));
        assert_eq!(eps[0].link.as_deref(), Some("https://www.xiaoyuzhoufm.com/episode/6af9e512fe62f8f52c4ba6fb"));
        assert_eq!(eps[0].duration, Some(3600.0));
        assert!(eps[0].published.is_some());
        assert!(apple_matches_xyz_pid("626b46ea9cbbf0451cf5a962", &[], &rows));
        assert!(!apple_matches_xyz_pid("ffffffffffffffffffffffff", &[], &rows));

        let custom_rows = vec![serde_json::json!({
            "wrapperType": "podcastEpisode",
            "trackName": "Custom Host Ep",
            "episodeGuid": "custom-guid-1",
            "episodeUrl": "https://cdn.example.com/1.mp3"
        })];
        let web_ep = Episode { guid: "custom-guid-1".into(), ..Episode::default() };
        assert!(apple_matches_xyz_pid("ffffffffffffffffffffffff", &[web_ep], &custom_rows));
        assert!(!apple_matches_xyz_pid("ffffffffffffffffffffffff", &[Episode { guid: "other".into(), ..Episode::default() }], &custom_rows));
    }

    #[test]
    fn merge_episodes_dedupes_sorts_and_backfills() {
        let web = vec![
            Episode {
                id: "web-157".into(),
                show_id: "s1".into(),
                guid: "eid-157".into(),
                title: "157".into(),
                published: Some(2000),
                audio_url: Some("https://media.xyzcdn.net/p1/a157.m4a".into()),
                link: Some("https://www.xiaoyuzhoufm.com/episode/eid157".into()),
                notes: Some("short".into()),
                ..Episode::default()
            },
        ];
        let apple = vec![
            // Same episode via unwrapped audio URL despite different guid -> should enrich without duplicating
            Episode {
                id: "apple-dup".into(),
                show_id: "s1".into(),
                guid: "rss-uuid-157".into(),
                title: "157".into(),
                published: Some(2000),
                duration: Some(1800.0),
                audio_url: Some("https://media.xyzcdn.net/p1/a157.m4a".into()),
                notes: Some("much longer description from apple".into()),
                ..Episode::default()
            },
            // Newer episode only on Apple -> should sort first
            Episode {
                id: "apple-158".into(),
                show_id: "s1".into(),
                guid: "rss-uuid-158".into(),
                title: "158".into(),
                published: Some(3000),
                ..Episode::default()
            },
            // Older historical episode backfilled from Apple -> should sort last
            Episode {
                id: "apple-100".into(),
                show_id: "s1".into(),
                guid: "rss-uuid-100".into(),
                title: "100".into(),
                published: Some(1000),
                ..Episode::default()
            },
        ];
        let merged = merge_episodes(web, apple);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].id, "apple-158");
        assert_eq!(merged[1].id, "web-157");
        assert_eq!(merged[1].duration, Some(1800.0));
        assert_eq!(merged[1].notes.as_deref(), Some("much longer description from apple"));
        assert_eq!(merged[2].id, "apple-100");
    }

    /// Network: verify 小宇宙 + Apple Podcasts multi-source merge and warm-cache concurrent path.
    #[tokio::test]
    #[ignore]
    async fn xiaoyuzhou_multi_source_live() {
        let url = "https://www.xiaoyuzhoufm.com/podcast/626b46ea9cbbf0451cf5a962";
        let (show, eps) = xiaoyuzhou_show(url).await.unwrap();
        println!("show={} eps={} top3={:?}", show.title, eps.len(), eps.iter().take(3).map(|e| (&e.title, e.published)).collect::<Vec<_>>());
        assert!(eps.len() > 20, "expected Apple backfill > 20 episodes, got {}", eps.len());
        assert!(eps.iter().any(|e| e.title.contains("157")), "expected ep 157 in merged episodes");
        let cached = XYZ_APPLE_ID.lock().unwrap().get("626b46ea9cbbf0451cf5a962").copied().flatten();
        assert!(cached.is_some(), "expected Apple id to be cached");
        let (_, eps2) = xiaoyuzhou_show(url).await.unwrap();
        assert_eq!(eps2.len(), eps.len());
    }
}
