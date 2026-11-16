const COMMANDS: &[&str] = &["add_subscription", "refresh_show", "refresh_all", "list_shows", "list_episodes", "recent_episodes", "get_episode", "remove_show", "set_progress", "search_podcasts", "load_transcript", "fetch_official_transcript", "transcribe", "cancel_job", "asr_models", "download_model", "delete_model", "get_blob", "set_blob", "get_settings", "set_settings", "set_api_key", "has_api_key", "llm_chat"];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS))).expect("failed to run tauri-build");
}
