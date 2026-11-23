//! Output formatting (`human`, `--json`, `--jsonl`, `--quiet`) and stderr progress sink.
use serde::Serialize;
use serde_json::{json, Value};
use subcast_core::{ProgressEvent, ProgressSink};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Human,
    Json,
    Jsonl,
    Quiet,
}

#[derive(Clone, Copy, Debug)]
pub struct Out {
    pub mode: Mode,
}

impl Out {
    pub fn is_structured(&self) -> bool {
        matches!(self.mode, Mode::Json | Mode::Jsonl)
    }

    pub fn print_json<T: Serialize>(&self, value: &T) {
        if let Ok(s) = serde_json::to_string_pretty(value) {
            println!("{s}");
        }
    }

    pub fn emit_jsonl<T: Serialize>(&self, value: &T) {
        if let Ok(s) = serde_json::to_string(value) {
            println!("{s}");
        }
    }

    pub fn ok<T: Serialize>(&self, value: &T, human_fn: impl FnOnce()) {
        match self.mode {
            Mode::Json => self.print_json(value),
            Mode::Jsonl => self.emit_jsonl(&json!({ "type": "result", "data": value })),
            Mode::Quiet => {}
            Mode::Human => human_fn(),
        }
    }

    pub fn message(&self, msg: &str) {
        if matches!(self.mode, Mode::Human) {
            println!("{msg}");
        }
    }

    pub fn print_error(&self, code: i32, kind: &str, message: &str) {
        match self.mode {
            Mode::Json => {
                if let Ok(s) = serde_json::to_string_pretty(&json!({
                    "error": { "code": code, "kind": kind, "message": message }
                })) {
                    eprintln!("{s}");
                }
            }
            Mode::Jsonl => {
                if let Ok(s) = serde_json::to_string(&json!({
                    "type": "error", "code": code, "kind": kind, "message": message
                })) {
                    eprintln!("{s}");
                }
            }
            Mode::Quiet | Mode::Human => {
                eprintln!("error: {message}");
            }
        }
    }
}

pub struct CliSink {
    pub mode: Mode,
}

impl ProgressSink for CliSink {
    fn emit(&self, ev: ProgressEvent) {
        match self.mode {
            Mode::Quiet | Mode::Json => {}
            Mode::Jsonl => {
                if let Ok(line) = serde_json::to_string(&ev) {
                    eprintln!("{line}");
                }
            }
            Mode::Human => {
                let text = match ev {
                    ProgressEvent::Info { stage, message, progress } => {
                        if let Some(p) = progress {
                            format!("[{stage}] {:.0}% {message}", (p * 100.0).clamp(0.0, 100.0))
                        } else {
                            format!("[{stage}] {message}")
                        }
                    }
                    ProgressEvent::Transcribe { stage, detail, .. } => format!("[transcribe:{stage}] {detail}"),
                    ProgressEvent::Model { progress, .. } => format!("[model] {:.0}%", (progress * 100.0).clamp(0.0, 100.0)),
                    ProgressEvent::LocalTts { progress, .. } => format!("[local-tts] {:.0}%", (progress * 100.0).clamp(0.0, 100.0)),
                    ProgressEvent::Download { progress, .. } => format!("[download] {:.0}%", (progress * 100.0).clamp(0.0, 100.0)),
                    ProgressEvent::Align { stage, detail, .. } => format!("[align:{stage}] {detail}"),
                    ProgressEvent::VideoClip { stage, progress, message, .. } => {
                        format!("[clip:{stage}] {:.0}% {message}", (progress * 100.0).clamp(0.0, 100.0))
                    }
                    ProgressEvent::YouTubeStream { episode_id } => format!("[youtube-stream] ready ({episode_id})"),
                    ProgressEvent::YouTubeLogin { done, ok, error } => {
                        format!("[youtube-login] done={done} ok={ok} {:?}", error)
                    }
                    ProgressEvent::AppUpdate { downloaded, total } => {
                        format!("[update] {downloaded}/{total:?}")
                    }
                };
                eprintln!("{text}");
            }
        }
    }
}

pub fn format_duration(secs: f64) -> String {
    let s = secs.max(0.0).round() as u64;
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let sec = s % 60;
    if h > 0 {
        format!("{h}:{m:02}:{sec:02}")
    } else {
        format!("{m}:{sec:02}")
    }
}

pub fn truncate(s: &str, max_chars: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max_chars {
        s.to_string()
    } else if max_chars > 1 {
        let mut out: String = chars[..max_chars - 1].iter().collect();
        out.push('…');
        out
    } else {
        chars[..max_chars].iter().collect()
    }
}

pub fn print_kv(pairs: &[(&str, Value)]) {
    let width = pairs.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
    for (k, v) in pairs {
        let vs = match v {
            Value::String(s) => s.clone(),
            Value::Null => "-".into(),
            other => other.to_string(),
        };
        println!("{k:<width$} : {vs}");
    }
}
