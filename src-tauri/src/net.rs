//! One HTTP client for the whole app, rebuilt when the proxy setting changes.
//! With no proxy configured, the system proxy (macOS/Windows settings, or HTTP(S)_PROXY) is used.
use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use std::sync::RwLock;
use std::time::Duration;

pub const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) SubCast/0.1";

static CLIENT: Lazy<RwLock<(String, reqwest::Client)>> = Lazy::new(|| RwLock::new((String::new(), build("").unwrap())));

fn build(proxy: &str) -> Result<reqwest::Client> {
    let mut b = reqwest::Client::builder()
        .user_agent(UA)
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(120))
        .gzip(true)
        .brotli(true);
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

pub async fn get_text(url: &str) -> Result<String> {
    let res = client().get(url).send().await?;
    let status = res.status();
    if !status.is_success() {
        return Err(anyhow!("请求失败（{}）：{}", status.as_u16(), url));
    }
    Ok(res.text().await?)
}
