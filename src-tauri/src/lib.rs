mod ffmpeg;
mod media_server;

use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

use ffmpeg::{
    build_ffmpeg_args, build_preview_args, build_slideshow_args, list_image_files, output_duration,
    parse_ffmpeg_probe, parse_progress_seconds, preview_cache_path, reverse_segment_args,
    same_file, trim_duration, validated_speed, ExportOptions, MediaInfo, SlideshowOptions,
};
use media_server::MediaServer;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const FFMPEG: &str = "/usr/bin/ffmpeg";
const REVERSE_SEGMENT_SECONDS: f64 = 1.0;

#[derive(Default)]
struct ExportState {
    process: Mutex<ProcessState>,
    reverse_preview: Mutex<Option<WorkDir>>,
}

#[derive(Default)]
struct ProcessState {
    running: bool,
    child: Option<CommandChild>,
    cancelled: bool,
}

struct Job<'a> {
    state: &'a ExportState,
    event: &'static str,
    cancelled_message: &'static str,
}

impl<'a> Job<'a> {
    fn start(state: &'a ExportState, preview: bool) -> Result<Self, String> {
        let mut process = state.process.lock().map_err(|e| e.to_string())?;
        if process.running {
            return Err("Another media operation is already running.".into());
        }
        process.running = true;
        process.cancelled = false;
        let (event, cancelled_message) = if preview {
            ("preview-progress", "Preview cancelled.")
        } else {
            ("export-progress", "Export cancelled.")
        };
        Ok(Self {
            state,
            event,
            cancelled_message,
        })
    }

    fn check_cancelled(&self) -> Result<(), String> {
        if self
            .state
            .process
            .lock()
            .map_err(|e| e.to_string())?
            .cancelled
        {
            return Err(self.cancelled_message.into());
        }
        Ok(())
    }
}

impl Drop for Job<'_> {
    fn drop(&mut self) {
        if let Ok(mut process) = self.state.process.lock() {
            process.running = false;
        }
    }
}

struct WorkDir(PathBuf);

impl WorkDir {
    fn create(parent: &Path) -> Result<Self, String> {
        use std::os::unix::fs::DirBuilderExt;

        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        loop {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let dir = parent.join(format!(".video-editor-{}-{id}", std::process::id()));
            match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
                Ok(()) => return Ok(Self(dir)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("Could not create working directory: {error}")),
            }
        }
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn run_ffmpeg(
    app: &AppHandle,
    job: &Job<'_>,
    args: Vec<String>,
    duration: f64,
    progress_start: f64,
    progress_end: f64,
    current_dir: Option<&Path>,
) -> Result<(), String> {
    let mut command = app.shell().command(FFMPEG).args(["-nostdin"]).args(args);
    if let Some(dir) = current_dir {
        command = command.current_dir(dir);
    }

    let mut rx = {
        let mut process = job.state.process.lock().map_err(|e| e.to_string())?;
        if process.cancelled {
            return Err(job.cancelled_message.into());
        }
        let (rx, child) = command
            .spawn()
            .map_err(|e| format!("Could not start FFmpeg at {FFMPEG}: {e}"))?;
        process.child = Some(child);
        rx
    };
    let _ = app.emit(job.event, progress_start.round() as u32);
    let duration = duration.max(0.001);

    let mut stderr = String::new();
    let mut exit_code: Option<i32> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes);
                if let Some(seconds) = parse_progress_seconds(&chunk) {
                    let fraction = (seconds / duration).clamp(0.0, 0.99);
                    let percent = progress_start + fraction * (progress_end - progress_start);
                    let _ = app.emit(job.event, percent.floor() as u32);
                }
            }
            CommandEvent::Stderr(bytes) => {
                stderr.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
            }
            CommandEvent::Error(message) => {
                if let Some(child) = job
                    .state
                    .process
                    .lock()
                    .map_err(|e| e.to_string())?
                    .child
                    .take()
                {
                    let _ = child.kill();
                }
                job.check_cancelled()?;
                return Err(message);
            }
            _ => {}
        }
    }

    job.state.process.lock().map_err(|e| e.to_string())?.child = None;
    job.check_cancelled()?;

    match exit_code {
        Some(0) => {
            let _ = app.emit(job.event, progress_end.floor() as u32);
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

async fn ffmpeg_probe(app: &AppHandle, path: &str) -> Result<MediaInfo, String> {
    let (mut rx, _child) = app
        .shell()
        .command(FFMPEG)
        .args(["-nostdin", "-hide_banner", "-i", path])
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

    Ok(parse_ffmpeg_probe(&text))
}

#[tauri::command]
async fn probe_media(app: AppHandle, path: String) -> Result<MediaInfo, String> {
    let info = ffmpeg_probe(&app, &path).await?;
    if !info.has_video {
        return Err("This file does not look like a playable video.".into());
    }
    Ok(info)
}

#[tauri::command]
async fn probe_audio(app: AppHandle, path: String) -> Result<MediaInfo, String> {
    let info = ffmpeg_probe(&app, &path).await?;
    if !info.has_audio {
        return Err("This file does not look like a playable audio track.".into());
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
    let job = Job::start(&state, true)?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let output = preview_cache_path(&path, &cache)?;
    if output.metadata().is_ok_and(|meta| meta.len() > 0) {
        return Ok(output.to_string_lossy().into_owned());
    }

    let work = WorkDir::create(output.parent().ok_or("Invalid preview directory.")?)?;
    let temporary = work.0.join("preview.mp4");
    let args = build_preview_args(&path, &temporary.to_string_lossy());
    run_ffmpeg(&app, &job, args, duration.unwrap_or(1.0), 0.0, 99.0, None).await?;
    publish_output(&app, &job, &temporary, &output)?;
    Ok(output.to_string_lossy().into_owned())
}

async fn reverse_source(
    app: &AppHandle,
    job: &Job<'_>,
    options: &mut ExportOptions,
    work: &WorkDir,
    preview: bool,
) -> Result<(), String> {
    let duration = trim_duration(options.trim_start, options.trim_end)?;
    let include_audio = options.audio_mode == "keep" && options.has_source_audio;
    // Merge a fractional tail into the first segment so it contains at least one frame.
    let count = ((duration / REVERSE_SEGMENT_SECONDS).floor() as usize).max(1);
    let mut manifest = String::from(
        "ffconcat version 1.0
",
    );
    for index in 0..count {
        let remaining = count - index - 1;
        let start = options.trim_start + remaining as f64 * REVERSE_SEGMENT_SECONDS;
        let end = if index == 0 {
            options.trim_end
        } else {
            start + REVERSE_SEGMENT_SECONDS
        };
        let length = end - start;
        let name = format!("segment-{index}.mkv");
        let args = reverse_segment_args(
            &options.input_path,
            &name,
            start,
            length,
            include_audio,
            preview,
        );
        let percent = |index: usize| index as f64 * 75.0 / count as f64;
        run_ffmpeg(
            app,
            job,
            args,
            length,
            percent(index),
            percent(index + 1),
            Some(&work.0),
        )
        .await?;
        manifest.push_str(&format!(
            "file {name}
duration {length:.6}
"
        ));
    }

    let path = work.0.join("reversed.ffconcat");
    std::fs::write(&path, manifest).map_err(|e| e.to_string())?;
    options.input_path = path.to_string_lossy().into_owned();
    options.trim_start = 0.0;
    options.trim_end = duration;
    options.speed = options.speed.abs();
    Ok(())
}

#[tauri::command]
async fn prepare_reverse_preview(
    app: AppHandle,
    state: State<'_, ExportState>,
    path: String,
    trim_start: f64,
    trim_end: f64,
    has_source_audio: bool,
) -> Result<String, String> {
    let job = Job::start(&state, true)?;
    let work = WorkDir::create(&std::env::temp_dir())?;
    let segments = WorkDir::create(&std::env::temp_dir())?;
    let output = work.0.join("reverse.mp4");
    let mut options = ExportOptions {
        input_path: path,
        output_path: output.to_string_lossy().into_owned(),
        trim_start,
        trim_end,
        speed: -1.0,
        audio_mode: "keep".into(),
        replacement_audio_path: None,
        has_source_audio,
        overlays: Vec::new(),
        base_volume: 100.0,
    };
    reverse_source(&app, &job, &mut options, &segments, true).await?;
    let args = build_ffmpeg_args(&options)?;
    run_ffmpeg(
        &app,
        &job,
        args,
        output_duration(&options),
        75.0,
        99.0,
        None,
    )
    .await?;
    job.check_cancelled()?;
    *state.reverse_preview.lock().map_err(|e| e.to_string())? = Some(work);
    let _ = app.emit(job.event, 100u32);
    Ok(options.output_path)
}

fn publish_output(
    app: &AppHandle,
    job: &Job<'_>,
    temporary: &Path,
    output: &Path,
) -> Result<(), String> {
    job.check_cancelled()?;
    std::fs::rename(temporary, output).map_err(|e| format!("Could not save MP4: {e}"))?;
    let _ = app.emit(job.event, 100u32);
    Ok(())
}

fn output_workspace(output: &Path) -> Result<WorkDir, String> {
    let parent = output.parent().filter(|path| !path.as_os_str().is_empty());
    WorkDir::create(parent.unwrap_or_else(|| Path::new(".")))
}

#[tauri::command]
async fn export_video(
    app: AppHandle,
    state: State<'_, ExportState>,
    mut options: ExportOptions,
) -> Result<(), String> {
    options.speed = validated_speed(options.speed)?;
    trim_duration(options.trim_start, options.trim_end)?;
    let output = PathBuf::from(&options.output_path);
    if same_file(&options.input_path, &options.output_path) {
        return Err("Choose a new file. The original is never overwritten.".into());
    }
    let job = Job::start(&state, false)?;
    let work = output_workspace(&output)?;
    let temporary = work.0.join("output.mp4");
    options.output_path = temporary.to_string_lossy().into_owned();

    let mut progress_start = 0.0;
    if options.speed < 0.0 {
        reverse_source(&app, &job, &mut options, &work, false).await?;
        progress_start = 75.0;
    }
    let args = build_ffmpeg_args(&options)?;
    run_ffmpeg(
        &app,
        &job,
        args,
        output_duration(&options),
        progress_start,
        99.0,
        None,
    )
    .await?;
    publish_output(&app, &job, &temporary, &output)
}

#[tauri::command]
fn list_slideshow_images(folder: String) -> Result<Vec<String>, String> {
    list_image_files(&folder)
}

fn stage_slideshow_images(images: &[String], dir: &Path) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for (i, src) in images.iter().enumerate() {
        let ext = std::path::Path::new(src)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg");
        let name = format!("{:04}.{ext}", i + 1);
        let dest = dir.join(&name);
        if std::fs::hard_link(src, &dest).is_err() {
            std::fs::copy(src, &dest).map_err(|e| format!("Could not copy photo: {e}"))?;
        }
        names.push(name);
    }
    Ok(names)
}

#[tauri::command]
async fn export_slideshow(
    app: AppHandle,
    state: State<'_, ExportState>,
    options: SlideshowOptions,
) -> Result<(), String> {
    let job = Job::start(&state, false)?;
    let output = PathBuf::from(&options.output_path);
    let work = output_workspace(&output)?;
    let temporary = work.0.join("output.mp4");
    let names = stage_slideshow_images(&options.images, &work.0)?;
    let (args, duration) = build_slideshow_args(
        &names,
        "output.mp4",
        options.hold_seconds,
        &options.transition,
        options.fade_seconds,
        &options.audio_mode,
        options.replacement_audio_path.as_deref(),
        &options.overlays,
        options.base_volume,
    )?;
    run_ffmpeg(&app, &job, args, duration, 0.0, 99.0, Some(&work.0)).await?;
    publish_output(&app, &job, &temporary, &output)
}

#[tauri::command]
fn cancel_export(state: State<'_, ExportState>) -> Result<(), String> {
    let mut process = state.process.lock().map_err(|e| e.to_string())?;
    process.cancelled = true;
    if let Some(child) = process.child.take() {
        let _ = child.kill();
    }
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

#[tauri::command]
fn media_url(state: State<'_, MediaServer>, path: String) -> Result<String, String> {
    state.url(&path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(MediaServer::start().map_err(std::io::Error::other)?);
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(ExportState::default())
        .invoke_handler(tauri::generate_handler![
            probe_media,
            media_url,
            probe_audio,
            prepare_preview,
            prepare_reverse_preview,
            list_slideshow_images,
            export_slideshow,
            export_video,
            cancel_export
        ])
        .run(tauri::generate_context!())
        .expect("error while running Video Editor");
}
