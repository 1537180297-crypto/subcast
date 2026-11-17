//! Streaming chat with the user's own model service: OpenAI-compatible `/chat/completions` (DeepSeek, SiliconFlow,
//! OpenRouter, Ollama, OpenAI, Kimi…) or Anthropic's Messages API. Keys live in the system keychain.
use crate::net;
use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

const KEYRING_SERVICE: &str = "ai.qiaomu.subcast";

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub protocol: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Message {
    pub role: String,
    pub content: String,
}

pub fn set_key(provider: &str, key: &str) -> Result<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, provider)?;
    if key.is_empty() {
        let _ = entry.delete_credential();
    } else {
        entry.set_password(key)?;
    }
    Ok(())
}

pub fn get_key(provider: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, provider).ok()?.get_password().ok()
}

/// OpenCode Go/Zen refuses requests without this header (it drives prompt-cache routing).
/// Any stable value passes; a per-install id from the keychain gives the best cache affinity.
fn opencode_session() -> &'static str {
    static ID: once_cell::sync::Lazy<String> = once_cell::sync::Lazy::new(|| {
        let entry = keyring::Entry::new(KEYRING_SERVICE, "opencode-session").ok();
        if let Some(v) = entry.as_ref().and_then(|e| e.get_password().ok()).filter(|v| !v.is_empty()) { return v; }
        let v = uuid::Uuid::new_v4().to_string();
        if let Some(e) = entry { let _ = e.set_password(&v); }
        v
    });
    &ID
}

fn needs_opencode_session(base_url: &str) -> bool { base_url.contains("opencode.ai") }

fn openai_url(base: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    if b.ends_with("/chat/completions") { b.to_string() } else { format!("{b}/chat/completions") }
}

fn anthropic_url(base: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    let b = if b.is_empty() { "https://api.anthropic.com" } else { b };
    if b.ends_with("/messages") { b.to_string() } else if b.ends_with("/v1") { format!("{b}/messages") } else { format!("{b}/v1/messages") }
}

fn api_error(status: u16, body: &str) -> anyhow::Error {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().or_else(|| v["error"].as_str()).or_else(|| v["message"].as_str()).map(String::from))
        .unwrap_or_else(|| body.chars().take(200).collect());
    match status {
        401 | 403 => anyhow!("API Key 无效或没有权限：{msg}"),
        404 => anyhow!("模型或地址不存在：{msg}"),
        429 => anyhow!("请求太频繁或额度不足：{msg}"),
        _ => anyhow!("模型服务出错（{status}）：{msg}"),
    }
}

/// Streams one reply; `on_delta` gets each piece of text. Returns the whole text.
pub async fn chat(p: &Provider, system: &str, messages: &[Message], max_tokens: u32, json_mode: bool, cancel: &AtomicBool, mut on_delta: impl FnMut(&str)) -> Result<String> {
    let key = get_key(&p.id);
    let anthropic = p.protocol == "anthropic";
    let req = if anthropic {
        let key = key.ok_or_else(|| anyhow!("请先在设置里填写 API Key"))?;
        let msgs: Vec<Value> = messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect();
        net::client()
            .post(anthropic_url(&p.base_url))
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({ "model": p.model, "max_tokens": max_tokens, "system": system, "messages": msgs, "stream": true }))
    } else {
        let mut msgs = vec![json!({"role": "system", "content": system})];
        msgs.extend(messages.iter().map(|m| json!({"role": m.role, "content": m.content})));
        let mut body = json!({ "model": p.model, "messages": msgs, "stream": true, "max_tokens": max_tokens });
        if json_mode { body["response_format"] = json!({"type": "json_object"}); }
        let mut r = net::client().post(openai_url(&p.base_url)).json(&body);
        if needs_opencode_session(&p.base_url) { r = r.header("x-opencode-session", opencode_session()); }
        if let Some(k) = key.filter(|k| !k.is_empty()) { r = r.bearer_auth(k); }
        r
    };
    let res = req.send().await.map_err(|e| anyhow!("连不上模型服务：{e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(api_error(status.as_u16(), &body));
    }
    let mut stream = res.bytes_stream();
    let mut lines = LineBuf::default();
    let mut full = String::new();
    // Reasoning models stream their thinking separately; if that is all that came, say so (usually the
    // length limit ran out while thinking) instead of a bare "nothing returned".
    let (mut thought, mut cut) = (false, false);
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) { return Err(anyhow!("已停止")); }
        lines.push(&chunk.map_err(|e| anyhow!("连接中断：{e}"))?);
        while let Some(line) = lines.next_line() {
            let line = line.trim().to_string();
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" { return finish(full, thought, cut); }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            let piece = if anthropic {
                if v["delta"]["thinking"].is_string() { thought = true; }
                if v["delta"]["stop_reason"].as_str() == Some("max_tokens") { cut = true; }
                match v["type"].as_str() {
                    Some("content_block_delta") => v["delta"]["text"].as_str().map(String::from),
                    Some("error") => return Err(anyhow!("模型服务出错：{}", v["error"]["message"].as_str().unwrap_or("未知错误"))),
                    _ => None,
                }
            } else {
                if let Some(e) = v["error"]["message"].as_str() { return Err(anyhow!("模型服务出错：{e}")); }
                let d = &v["choices"][0]["delta"];
                if d["reasoning_content"].as_str().is_some_and(|x| !x.is_empty()) || d["reasoning"].as_str().is_some_and(|x| !x.is_empty()) { thought = true; }
                if v["choices"][0]["finish_reason"].as_str() == Some("length") { cut = true; }
                d["content"].as_str().map(String::from)
            };
            if let Some(piece) = piece.filter(|p| !p.is_empty()) {
                full.push_str(&piece);
                on_delta(&piece);
            }
        }
    }
    finish(full, thought, cut)
}

fn finish(full: String, thought: bool, cut: bool) -> Result<String> {
    if !full.trim().is_empty() { return Ok(full); }
    if thought || cut { return Err(anyhow!("模型把篇幅都用在了思考上，没有写出正文。请重试，或换一个不带深度思考的模型")); }
    Err(anyhow!("模型没有返回内容"))
}

/// Bytes from a stream, handed out as whole lines. Decoding per network chunk would split a Chinese
/// character (3 bytes in UTF-8) that straddles two chunks into "��"; a line is only decoded once complete.
#[derive(Default)]
struct LineBuf { bytes: Vec<u8> }

impl LineBuf {
    fn push(&mut self, chunk: &[u8]) { self.bytes.extend_from_slice(chunk); }
    fn next_line(&mut self) -> Option<String> {
        let pos = self.bytes.iter().position(|&b| b == b'\n')?;
        let line: Vec<u8> = self.bytes.drain(..=pos).collect();
        Some(String::from_utf8_lossy(&line[..pos]).into_owned())
    }
}

#[cfg(test)]
mod line_buf_tests {
    use super::LineBuf;
    #[test]
    fn a_character_split_across_chunks_stays_whole() {
        let text = "data: 黄仁勋能\n\ndata: [DONE]\n".as_bytes();
        let mut b = LineBuf::default();
        let mut got = Vec::new();
        // Split inside 仁 (bytes 9..12) and again inside 勋.
        for part in [&text[..10], &text[10..14], &text[14..]] {
            b.push(part);
            while let Some(l) = b.next_line() { got.push(l); }
        }
        assert_eq!(got, ["data: 黄仁勋能", "", "data: [DONE]"]);
        assert!(!got.concat().contains('\u{FFFD}'));
    }
}
