//! 乔木精读 channels (lex.qiaomu.ai, nopriors.qiaomu.ai, …): curated shows with Chinese titles, Chinese summaries,
//! a Chinese deep-read for each episode and, for many, the original transcript. Each site is static: the episode
//! list is `/data/episodes.json`; an episode page carries the audio, the deep-read and the transcript.
use crate::model::*;
use crate::net;
use anyhow::{anyhow, Result};
use regex::Regex;
use serde::Serialize;

/// `https://lex.qiaomu.ai/...` → `lex`. Not the shared services (rss, api, www…).
pub fn site_id(url: &str) -> Option<String> {
    let c = Regex::new(r"^https?://([a-z0-9-]+)\.qiaomu\.ai(?:/|$)").unwrap().captures(url)?;
    let id = c[1].to_string();
    (!["rss", "api", "www", "xnews", "elon", "blog"].contains(&id.as_str())).then_some(id)
}

/// Square show artwork (the sites' own og images are wide cards).
fn cover_for(id: &str) -> Option<String> {
    let path = match id {
        "lex" => "Podcasts211/v4/ea/42/d7/ea42d7b1-8d4e-dd97-da5d-c508756550ca/mza_16782152345430036863.jpg",
        "allin" => "Podcasts124/v4/c7/d2/92/c7d292ea-44b3-47ff-2f5e-74fa5b23db6c/mza_7005270671777648882.png",
        "nopriors" => "Podcasts221/v4/8f/46/88/8f4688ec-087f-28a1-7f6d-0d401d2e8a00/mza_14043856542292072583.jpg",
        "cogrev" => "Podcasts211/v4/b1/29/0d/b1290dd6-516c-bc2d-53b6-473d18a3dff2/mza_6540782963388625071.jpeg",
        "trainingdata" => "Podcasts221/v4/40/01/bd/4001bd05-9453-3d7f-c034-d815c74d332d/mza_6464974713460854089.png",
        "unsupervised" => "Podcasts221/v4/89/9c/aa/899caaef-e537-c9e8-2e34-788b847b1a15/mza_3258716992355382594.jpg",
        "zhangxiaojun" => "Podcasts221/v4/e6/74/44/e674449c-c2ac-50c4-0099-7e37c330e6c5/mza_16442776193352459849.png",
        "42zhangjing" => "Podcasts126/v4/33/6c/3f/336c3fea-4e5a-9524-6b7d-92c1080a6db9/mza_9247514814536235437.png",
        "latetalk" => "Podcasts211/v4/79/f3/66/79f366d3-dfb2-4c6e-ade6-e95e18261c4f/mza_6811336372335437524.jpg",
        "crossing" => "Podcasts211/v4/d8/14/eb/d814eb12-0a75-e0b4-33a1-c6a2dae2b516/mza_4023160414676912809.png",
        "aialchemy" => "Podcasts116/v4/ad/47/1f/ad471f3e-01ad-b68e-772e-6904f6af6941/mza_15665975703352948829.jpeg",
        "35huan" => "Podcasts126/v4/6e/d0/de/6ed0dedb-d782-a562-e40b-043ce20441d3/mza_5066303992234991879.jpeg",
        "zhixing" => "Podcasts112/v4/b3/96/fc/b396fcc5-6e2b-d34e-8d3d-c849c43b6215/mza_4090324763067558601.jpeg",
        "mianji" => "Podcasts126/v4/a8/d9/5e/a8d95e6e-aba6-3608-9c28-8b8cde840ec4/mza_10150483960934463526.png",
        _ => return None,
    };
    Some(format!("https://is1-ssl.mzstatic.com/image/thumb/{path}/600x600bb.jpg"))
}

/// The show's own name, so the app matches it with its curated Chinese name and cover.
fn title_for(id: &str) -> Option<&'static str> {
    Some(match id {
        "lex" => "Lex Fridman Podcast", "allin" => "All-In Podcast", "nopriors" => "No Priors", "cogrev" => "The Cognitive Revolution",
        "trainingdata" => "Training Data", "unsupervised" => "Unsupervised Learning", "zhangxiaojun" => "张小珺Jùn｜商业访谈录",
        "42zhangjing" => "42章经", "latetalk" => "晚点聊 LateTalk", "crossing" => "十字路口Crossing", "aialchemy" => "AI炼金术",
        "35huan" => "三五环", "zhixing" => "知行小酒馆", "mianji" => "面基",
        _ => return None,
    })
}

pub fn feed_url(id: &str) -> String { format!("https://{id}.qiaomu.ai/") }

fn meta(html: &str, prop: &str) -> Option<String> {
    let re = Regex::new(&format!(r#"<meta[^>]+(?:property|name)="{prop}"[^>]+content="([^"]*)""#)).ok()?;
    re.captures(html).map(|c| crate::transcript::decode_entities(&c[1])).filter(|s| !s.is_empty())
}

pub struct Channel { pub show: Show, pub episodes: Vec<Episode>, pub zh_titles: Vec<(String, String)> }

pub async fn channel(id: &str) -> Result<Channel> {
    let base = feed_url(id);
    let data_url = format!("{base}data/episodes.json");
    let (home, data) = tokio::join!(net::get_text(&base), net::get_text(&data_url));
    let home = home.unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&data?).map_err(|_| anyhow!("精读频道数据格式不对"))?;
    let list = v["episodes"].as_array().cloned().unwrap_or_default();
    if list.is_empty() { return Err(anyhow!("这个精读频道还没有节目")); }
    let title = meta(&home, "og:site_name").or_else(|| meta(&home, "og:title"))
        .or_else(|| Regex::new(r"<title>([^<]+)</title>").unwrap().captures(&home).map(|c| crate::transcript::decode_entities(&c[1])))
        .unwrap_or_else(|| format!("{id}.qiaomu.ai"));
    let abs = |u: &str| if u.starts_with("http") { u.to_string() } else { format!("{}{}", base.trim_end_matches('/'), if u.starts_with('/') { u.to_string() } else { format!("/{u}") }) };
    let show_id = short_hash(&base, 16);
    let show = Show {
        id: show_id.clone(),
        kind: "qiaomu".into(),
        title: title_for(id).map(String::from).unwrap_or_else(|| title.split(" · ").next().unwrap_or(&title).trim().to_string()),
        author: Some("乔木精读".into()),
        cover: cover_for(id).or_else(|| meta(&home, "og:image").map(|u| abs(&u))),
        feed_url: base.clone(),
        link: Some(base.clone()),
        description: meta(&home, "description").or_else(|| meta(&home, "og:description")),
        updated_at: now_ms(),
        unplayed: 0,
    };
    let mut zh_titles = vec![];
    let episodes = list.iter().take(crate::feeds::MAX_EPISODES).filter_map(|e| {
        let slug = e["s"].as_str()?.to_string();
        let t = e["t"].as_str()?.to_string();
        if let Some(zh) = e["zh"].as_str().filter(|z| !z.is_empty() && *z != t) { zh_titles.push((t.clone(), zh.to_string())); }
        let link = e["u"].as_str().map(abs).unwrap_or_else(|| format!("{base}ep/{slug}/"));
        let published = e["d"].as_str().and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()).and_then(|d| d.and_hms_opt(12, 0, 0)).map(|d| d.and_utc().timestamp_millis());
        let video = e["y"].as_str().filter(|y| y.len() == 11).map(String::from);
        Some(Episode {
            id: short_hash(&format!("{show_id}:{slug}"), 20),
            show_id: show_id.clone(),
            guid: slug,
            title: t,
            published,
            duration: e["du"].as_f64(),
            audio_url: None,
            cover: e["c"].as_str().map(abs).or_else(|| video.as_ref().map(|y| format!("https://i.ytimg.com/vi/{y}/hqdefault.jpg"))),
            video_id: video,
            link: Some(link),
            notes: e["ds"].as_str().map(String::from),
            transcript_url: None,
            transcript_type: Some("qiaomu".into()),
            ..Default::default()
        })
    }).collect();
    Ok(Channel { show, episodes, zh_titles })
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Detail { pub audio: Option<String>, pub deep_read: Option<String>, pub transcript: Option<String> }

/// The inner HTML of the first element whose class list contains `class`, tracking nested <div>s / <article>s.
fn inner_html(html: &str, class: &str) -> Option<String> {
    let open = Regex::new(&format!(r#"<(div|article|section|pre)[^>]*class="[^"]*\b{}\b[^"]*"[^>]*>"#, regex::escape(class))).ok()?;
    let m = open.captures(html)?;
    let tag = m[1].to_string();
    let start = m.get(0)?.end();
    let tok = Regex::new(&format!(r"(?i)<(/?){tag}\b[^>]*>")).ok()?;
    let mut depth = 1;
    for t in tok.captures_iter(&html[start..]) {
        depth += if t[1].is_empty() { 1 } else { -1 };
        if depth == 0 { return Some(html[start..start + t.get(0)?.start()].to_string()); }
    }
    None
}

pub async fn detail(link: &str) -> Result<Detail> {
    let html = net::get_text(link).await?;
    let audio = Regex::new(r#"<audio[^>]+src="([^"]+)""#).unwrap().captures(&html).map(|c| crate::transcript::decode_entities(&c[1]))
        .or_else(|| Regex::new(r#"(?:src|href)="(https://[^"]+\.(?:mp3|m4a)[^"]*)""#).unwrap().captures(&html).map(|c| crate::transcript::decode_entities(&c[1])));
    let deep_read = inner_html(&html, "zh-article").map(|h| {
        // The site's own note about AI rewriting is shown by the app; drop scripts and the inline note.
        let h = Regex::new(r"(?is)<script.*?</script>|<style.*?</style>").unwrap().replace_all(&h, "");
        Regex::new(r#"(?is)<p[^>]*class="zh-note"[^>]*>.*?</p>"#).unwrap().replace_all(&h, "").trim().to_string()
    }).filter(|h| h.len() > 40);
    let transcript = inner_html(&html, "transcript-text").map(|t| {
        let t = Regex::new(r"(?s)<[^>]+>").unwrap().replace_all(&t, "");
        crate::transcript::decode_entities(t.trim())
    }).filter(|t| t.len() > 200);
    Ok(Detail { audio, deep_read, transcript })
}

/// Turns an untimed transcript into segments spread across the episode. Header lines ("Machine transcription by…")
/// are dropped. Timing is approximate, so the source is marked as such.
pub fn transcript_segments(text: &str, duration: f64) -> Vec<Segment> {
    let body: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let skip = body.iter().take(3).take_while(|l| l.len() < 160 && (l.contains("Podcast") || l.contains("transcri") || l.contains('#') || l.contains("May contain"))).count();
    let joined = body[skip..].join(" ");
    if joined.is_empty() { return vec![]; }
    crate::transcript::split_timed(&joined, 0.0, duration.max(60.0))
}

// ---- rss.qiaomu.ai sources (乔木改写) ---------------------------------------------------------------
// Feeds the reader follows (Next Token, 半拿铁, Podscribe transcripts of Acquired / Pivot…) where each episode
// may carry a 乔木改写: a Chinese deep-read written from the full transcript.

const RSS: &str = "https://rss.qiaomu.ai";

/// `https://rss.qiaomu.ai/sources/nexttoken` → `nexttoken`.
pub fn rss_source_id(url: &str) -> Option<String> {
    Regex::new(r"^https?://rss\.qiaomu\.ai/sources/([A-Za-z0-9_-]+)/?$").unwrap().captures(url.trim()).map(|c| c[1].to_string())
}
pub fn rss_feed_url(id: &str) -> String { format!("{RSS}/sources/{id}") }

fn norm_title(t: &str) -> String {
    t.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Podscribe episodes have transcripts but no audio: borrow it from the show's own feed, matched by title.
async fn audio_by_title(show_name: &str) -> std::collections::HashMap<String, (String, Option<f64>)> {
    let mut out = std::collections::HashMap::new();
    let Ok(results) = crate::feeds::search_podcasts(show_name, "US").await else { return out };
    let Some(feed) = results.first().map(|r| r.feed_url.clone()) else { return out };
    if let Ok((_, eps)) = crate::feeds::fetch_show(&feed, "podcast").await {
        for e in eps { if let Some(a) = e.audio_url { out.insert(norm_title(&e.title), (a, e.duration)); } }
    }
    out
}

pub async fn rss_channel(id: &str) -> Result<Channel> {
    let sources: serde_json::Value = net::client().get(format!("{RSS}/api/sources")).send().await?.json().await?;
    let meta = sources["sources"].as_array().and_then(|a| a.iter().find(|s| s["id"].as_str() == Some(id)).cloned())
        .ok_or_else(|| anyhow!("rss.qiaomu.ai 上没有这个频道"))?;
    let name = meta["name"].as_str().unwrap_or(id).replace(" · 文稿", "");
    let mut entries: Vec<serde_json::Value> = vec![];
    let mut cursor = String::new();
    for _ in 0..4 {
        let url = format!("{RSS}/api/sources/{id}/entries?limit=100{}", if cursor.is_empty() { String::new() } else { format!("&cursor={}", urlencoding::encode(&cursor)) });
        let page: serde_json::Value = net::client().get(url).send().await?.json().await?;
        entries.extend(page["entries"].as_array().cloned().unwrap_or_default());
        match page["nextCursor"].as_str() { Some(c) if page["hasMore"].as_bool() == Some(true) && !c.is_empty() => cursor = c.to_string(), _ => break }
    }
    if entries.is_empty() { return Err(anyhow!("这个频道还没有节目")); }
    let podscribe = id.starts_with("podscribe-");
    let borrowed = if podscribe { audio_by_title(&name).await } else { Default::default() };
    let feed = rss_feed_url(id);
    let show_id = short_hash(&feed, 16);
    let mut zh_titles = vec![];
    let episodes: Vec<Episode> = entries.iter().take(crate::feeds::MAX_EPISODES).filter_map(|e| {
        let guid = e["id"].as_str()?.to_string();
        let title = e["title"].as_str()?.to_string();
        if let Some(zh) = e["titleZh"].as_str().filter(|z| !z.is_empty() && *z != title) { zh_titles.push((title.clone(), zh.to_string())); }
        let link = e["link"].as_str().map(String::from);
        let (mut audio, mut duration) = (e["audio"]["url"].as_str().map(String::from), None);
        if audio.is_none() { if let Some((a, d)) = borrowed.get(&norm_title(&title)) { audio = Some(a.clone()); duration = *d; } }
        let video = link.as_deref().and_then(crate::feeds::youtube_video_id);
        let transcript_url = if podscribe { link.as_deref().and_then(|l| l.strip_prefix("https://podcasts.happyscribe.com/")).map(|p| format!("https://api.qiaomu.ai/podscribe/v1/episodes/{p}/transcript")) } else { None };
        Some(Episode {
            id: short_hash(&format!("{show_id}:{guid}"), 20),
            show_id: show_id.clone(),
            guid,
            title,
            published: e["publishedTs"].as_i64(),
            duration,
            audio_url: audio,
            video_id: video.clone(),
            link,
            cover: e["image"].as_str().map(String::from).or_else(|| video.map(|v| format!("https://i.ytimg.com/vi/{v}/hqdefault.jpg"))),
            notes: e["summary"].as_str().map(String::from),
            transcript_url,
            transcript_type: Some(if podscribe { "podscribe" } else { "qiaomu-rss" }.into()),
            ..Default::default()
        })
    }).collect();
    let show = Show {
        id: show_id,
        kind: "qiaomu".into(),
        title: title_for(id).map(String::from).unwrap_or(name),
        author: Some("乔木精读".into()),
        cover: cover_for(id).or_else(|| episodes.iter().find_map(|e| e.cover.clone())),
        feed_url: feed.clone(),
        link: meta["siteUrl"].as_str().map(String::from),
        description: meta["description"].as_str().map(String::from),
        updated_at: now_ms(),
        unplayed: 0,
    };
    Ok(Channel { show, episodes, zh_titles })
}

/// The 乔木改写 for an rss.qiaomu.ai entry, as HTML.
pub async fn rss_rewrite(entry_id: &str) -> Result<Option<String>> {
    let v: serde_json::Value = net::client().get(format!("{RSS}/api/entry/{entry_id}/rewrite")).send().await?.json().await?;
    if v["status"].as_str() != Some("ready") { return Ok(None); }
    let html = v["rewrite"]["bodyHtml"].as_str().filter(|h| !h.is_empty()).map(String::from)
        .or_else(|| v["rewrite"]["body"].as_str().map(markdown_html));
    Ok(html.filter(|h| h.len() > 40))
}

fn esc(s: &str) -> String { s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;") }

fn inline(s: &str) -> String {
    let s = esc(s);
    let s = Regex::new(r"\*\*(.+?)\*\*").unwrap().replace_all(&s, "<strong>$1</strong>");
    let s = Regex::new(r"\[([^\]]+)\]\((https?://[^)\s]+)\)").unwrap().replace_all(&s, r#"<a href="$2">$1</a>"#);
    Regex::new(r"`([^`]+)`").unwrap().replace_all(&s, "<code>$1</code>").into_owned()
}

/// Enough Markdown for the rewrites: headings, quotes, lists, paragraphs, bold, links.
pub fn markdown_html(md: &str) -> String {
    let mut out = String::new();
    let mut list = false;
    for block in md.split("\n\n").map(str::trim).filter(|b| !b.is_empty()) {
        let lines: Vec<&str> = block.lines().collect();
        if lines.iter().all(|l| l.trim_start().starts_with("- ") || l.trim_start().starts_with("* ")) {
            if !list { out.push_str("<ul>"); list = true; }
            for l in lines { out.push_str(&format!("<li>{}</li>", inline(l.trim_start()[2..].trim()))); }
            continue;
        }
        if list { out.push_str("</ul>"); list = false; }
        if let Some(h) = block.strip_prefix("### ") { out.push_str(&format!("<h3>{}</h3>", inline(h))); }
        else if let Some(h) = block.strip_prefix("## ") { out.push_str(&format!("<h2>{}</h2>", inline(h))); }
        else if let Some(h) = block.strip_prefix("# ") { out.push_str(&format!("<h2>{}</h2>", inline(h))); }
        else if block.starts_with('>') {
            let q: Vec<String> = lines.iter().map(|l| inline(l.trim_start_matches('>').trim())).collect();
            out.push_str(&format!("<blockquote><p>{}</p></blockquote>", q.join("<br>")));
        } else { out.push_str(&format!("<p>{}</p>", lines.iter().map(|l| inline(l)).collect::<Vec<_>>().join("<br>"))); }
    }
    if list { out.push_str("</ul>"); }
    out
}

/// A Podscribe transcript with real timestamps.
pub async fn podscribe_transcript(url: &str) -> Result<Vec<Segment>> {
    let v: serde_json::Value = net::client().get(url).send().await?.json().await?;
    let segs = v["data"]["transcript"]["segments"].as_array().cloned().unwrap_or_default();
    let mut out: Vec<Segment> = segs.iter().filter_map(|s| {
        let text = s["text"].as_str()?.trim().to_string();
        (!text.is_empty()).then(|| Segment { start: s["start_seconds"].as_f64().unwrap_or(0.0), end: 0.0, text })
    }).collect();
    for i in 0..out.len() { out[i].end = out.get(i + 1).map(|n| n.start).unwrap_or(out[i].start + 8.0); }
    Ok(out)
}
