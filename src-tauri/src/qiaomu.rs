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
