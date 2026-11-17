//! One HTTP client for the whole app, rebuilt when the proxy setting changes.
//! With no proxy configured, the system proxy (macOS/Windows settings, or HTTP(S)_PROXY) is used.
use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use std::sync::RwLock;
use std::time::Duration;

pub const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) SubCast/0.1";

static CLIENT: Lazy<RwLock<(String, reqwest::Client)>> = Lazy::new(|| RwLock::new((String::new(), build("").unwrap())));
/// Ignores every proxy: the fallback when the system proxy (Clash and the like, on 127.0.0.1) isn't running.
static DIRECT: Lazy<reqwest::Client> = Lazy::new(|| base().no_proxy().build().unwrap());

fn base() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent(UA)
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(120))
        // Proxies (Clash and the like) and servers drop idle keep-alive connections; reusing one of those fails with
        // "error sending request". Retire idle connections early and probe live ones.
        .pool_idle_timeout(Duration::from_secs(20))
        .tcp_keepalive(Duration::from_secs(30))
        .gzip(true)
        .brotli(true)
}

fn build(proxy: &str) -> Result<reqwest::Client> {
    let mut b = base();
    if !proxy.trim().is_empty() {
        b = b.proxy(reqwest::Proxy::all(proxy.trim()).map_err(|e| anyhow!("代理地址无效：{e}"))?);
    }
    Ok(b.build()?)
}

pub fn set_proxy(proxy: &str) -> Result<()> {
    let client = build(proxy)?;
    *CLIENT.write().unwrap() = (proxy.trim().to_string(), client);
    Ok(())
}

pub fn proxy() -> String {
    CLIENT.read().unwrap().0.clone()
}

pub fn client() -> reqwest::Client {
    CLIENT.read().unwrap().1.clone()
}

/// A GET with up to two retries on connection-level failures, timeouts, 429 and 5xx (all safe to repeat).
pub async fn get(url: &str) -> Result<reqwest::Response> {
    let mut last: Option<anyhow::Error> = None;
    for attempt in 0..3u64 {
        if attempt > 0 { tokio::time::sleep(Duration::from_millis(400 * attempt * attempt + 200)).await; }
        match client().get(url).send().await {
            Ok(res) if res.status().is_server_error() || res.status().as_u16() == 429 => {
                last = Some(anyhow!("请求失败（{}）：{}", res.status().as_u16(), url));
            }
            Ok(res) if !res.status().is_success() => return Err(anyhow!("请求失败（{}）：{}", res.status().as_u16(), url)),
            Ok(res) => return Ok(res),
            Err(e) if e.is_connect() || e.is_timeout() || e.is_request() => last = Some(describe(e)),
            Err(e) => return Err(describe(e)),
        }
    }
    // With no proxy set in SubCast, requests follow the system proxy. A local proxy app that is restarting or
    // switching refuses the connection ("os error 61") although the site is fine: try once without any proxy.
    if proxy().is_empty() && last.as_ref().is_some_and(|e| refused(&e.to_string())) {
        if let Ok(res) = DIRECT.get(url).send().await {
            if res.status().is_success() { return Ok(res); }
        }
    }
    Err(last.unwrap_or_else(|| anyhow!("请求失败：{url}")))
}

/// reqwest's own message ("error sending request for url …") hides the reason; add the innermost cause.
pub fn describe(e: reqwest::Error) -> anyhow::Error {
    let mut cause: &dyn std::error::Error = &e;
    while let Some(next) = cause.source() { cause = next; }
    let host = e.url().and_then(|u| u.host_str()).unwrap_or("").to_string();
    let why = cause.to_string();
    if refused(&why) { anyhow!("连不上 {host}：连接被拒绝。如果开着代理软件（如 Clash），请确认它在运行，或在 设置 › 通用 里填写代理地址") }
    else if e.is_timeout() { anyhow!("连接 {host} 超时，请检查网络或代理") }
    else if e.is_connect() { anyhow!("连不上 {host}：{why}。请检查网络或代理设置") }
    else if why != e.to_string() { anyhow!("网络请求失败（{host}）：{why}") }
    else { anyhow!("网络请求失败（{host}）") }
}

pub async fn get_text(url: &str) -> Result<String> {
    Ok(get(url).await?.text().await?)
}

pub async fn get_json(url: &str) -> Result<serde_json::Value> {
    Ok(get(url).await?.json().await?)
}

/// "Connection refused" in any of the forms the OS reports it.
fn refused(msg: &str) -> bool { let m = msg.to_lowercase(); m.contains("refused") || m.contains("os error 61") || m.contains("os error 111") || m.contains("os error 10061") || m.contains("连接被拒绝") }


#[cfg(test)]
mod tests {
    /// Run with HTTPS_PROXY=http://127.0.0.1:9 (nothing listening): the request still gets through directly.
    #[tokio::test]
    #[ignore]
    async fn a_dead_system_proxy_falls_back_to_direct() {
        let res = super::get("https://42zhangjing.qiaomu.ai/data/episodes.json").await.unwrap();
        assert!(res.status().is_success());
        let err = super::client().get("https://42zhangjing.qiaomu.ai/").send().await.unwrap_err();
        println!("{}", super::describe(err));
    }
}
