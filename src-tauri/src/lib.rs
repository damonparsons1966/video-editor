mod ffmpeg;

use std::sync::Mutex;

use ffmpeg::{
    build_ffmpeg_args, build_preview_args, output_duration, parse_ffmpeg_probe,
    parse_progress_seconds, preview_cache_path, ExportOptions, MediaInfo,
};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct ExportState {
    child: Mutex<Option<CommandChild>>,
    cancelled: Mutex<bool>,
}

fn kill_active_job(state: &ExportState) {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
}

async fn run_ffmpeg(
    app: AppHandle,
    state: &ExportState,
    args: Vec<String>,
    duration: f64,
    progress_event: &'static str,
    cancelled_message: &'static str,
) -> Result<(), String> {
    if let Ok(mut cancelled) = state.cancelled.lock() {
        *cancelled = false;
    }
    kill_active_job(state);

    let (mut rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(args)
        .spawn()
        .map_err(|e| format!("Could not start FFmpeg: {e}"))?;

    {
        let mut guard = state.child.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }

    let _ = app.emit(progress_event, 0u32);
    let duration = duration.max(0.001);

    let mut stderr = String::new();
    let mut exit_code: Option<i32> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes);
                if let Some(seconds) = parse_progress_seconds(&chunk) {
                    let percent = ((seconds / duration) * 100.0).clamp(0.0, 99.0).round() as u32;
                    let _ = app.emit(progress_event, percent);
                }
            }
            CommandEvent::Stderr(bytes) => {
                stderr.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
            }
            CommandEvent::Error(message) => {
                kill_active_job(state);
                return Err(message);
            }
            _ => {}
        }
    }

    {
        let mut guard = state.child.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }

    let cancelled = state.cancelled.lock().map(|flag| *flag).unwrap_or(false);
    if cancelled {
        return Err(cancelled_message.into());
    }

    match exit_code {
        Some(0) => {
            let _ = app.emit(progress_event, 100u32);
            Ok(())
        }
        Some(code) => {
            let detail = stderr.trim();
            if detail.is_empty() {
                Err(format!("FFmpeg failed with exit code {code}."))
            } else {
                Err(tail_error(detail))
            }
        }
        None => Err("FFmpeg did not finish.".into()),
    }
}

#[tauri::command]
async fn probe_media(app: AppHandle, path: String) -> Result<MediaInfo, String> {
    let (mut rx, _child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(["-hide_banner", "-i", &path])
        .spawn()
        .map_err(|e| format!("Could not start FFmpeg: {e}"))?;

    let mut text = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                text.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Terminated(_) | CommandEvent::Error(_) => break,
            _ => {}
        }
    }

    let info = parse_ffmpeg_probe(&text);
    if !info.has_video {
        return Err("This file does not look like a playable video.".into());
    }
    Ok(info)
}

#[tauri::command]
async fn prepare_preview(
    app: AppHandle,
    state: State<'_, ExportState>,
    path: String,
    duration: Option<f64>,
) -> Result<String, String> {
    let output = preview_cache_path(&path)?;
    if output.is_file() {
        if let Ok(meta) = std::fs::metadata(&output) {
            if meta.len() > 0 {
                return Ok(output.to_string_lossy().into_owned());
            }
        }
    }

    let args = build_preview_args(&path, &output.to_string_lossy());
    run_ffmpeg(
        app,
        &state,
        args,
        duration.unwrap_or(1.0),
        "preview-progress",
        "Preview cancelled.",
    )
    .await?;

    Ok(output.to_string_lossy().into_owned())
}

#[tauri::command]
async fn export_video(
    app: AppHandle,
    state: State<'_, ExportState>,
    options: ExportOptions,
) -> Result<(), String> {
    let args = build_ffmpeg_args(&options)?;
    let duration = output_duration(&options);
    run_ffmpeg(
        app,
        &state,
        args,
        duration,
        "export-progress",
        "Export cancelled.",
    )
    .await
}

#[tauri::command]
fn cancel_export(state: State<'_, ExportState>) -> Result<(), String> {
    if let Ok(mut cancelled) = state.cancelled.lock() {
        *cancelled = true;
    }
    kill_active_job(&state);
    Ok(())
}

fn tail_error(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let start = lines.len().saturating_sub(6);
    lines[start..].join("\n")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(ExportState {
            child: Mutex::new(None),
            cancelled: Mutex::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            probe_media,
            prepare_preview,
            export_video,
            cancel_export
        ])
        .run(tauri::generate_context!())
        .expect("error while running Video Editor");
}
