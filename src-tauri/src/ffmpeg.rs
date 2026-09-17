const MIN_CLIP_SECS: f64 = 0.1;

fn normalize_path(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub input_path: String,
    pub output_path: String,
    pub trim_start: f64,
    pub trim_end: f64,
    pub speed: f64,
    pub audio_mode: String,
    pub replacement_audio_path: Option<String>,
    pub has_source_audio: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub has_video: bool,
    pub has_audio: bool,
    pub duration: Option<f64>,
    pub video_codec: Option<String>,
    pub previewable: bool,
}

pub fn atempo_chain(speed: f64) -> Vec<f64> {
    if (speed - 1.0).abs() < 0.001 {
        return Vec::new();
    }

    let mut remaining = speed;
    let mut parts = Vec::new();

    while remaining > 2.0 + 1e-6 {
        parts.push(2.0);
        remaining /= 2.0;
    }
    while remaining < 0.5 - 1e-6 {
        parts.push(0.5);
        remaining /= 0.5;
    }
    if (remaining - 1.0).abs() >= 0.001 {
        parts.push(remaining);
    }
    parts
}

fn fmt_tempo(value: f64) -> String {
    format!("{value:.4}").trim_end_matches('0').trim_end_matches('.').to_string()
}

pub fn parse_video_codec(stderr: &str) -> Option<String> {
    for line in stderr.lines() {
        let Some(rest) = line.split("Video:").nth(1) else {
            continue;
        };
        let token = rest
            .split([' ', ',', '('])
            .map(str::trim)
            .find(|part| !part.is_empty())?;
        return Some(token.to_ascii_lowercase());
    }
    None
}

pub fn is_browser_previewable(codec: &str) -> bool {
    matches!(
        codec.to_ascii_lowercase().as_str(),
        "h264" | "avc" | "avc1" | "vp8" | "vp9" | "av1" | "av01" | "theora" | "vp08" | "vp09"
    )
}

pub fn parse_ffmpeg_probe(stderr: &str) -> MediaInfo {
    let has_video = stderr.lines().any(|line| line.contains("Video:"));
    let has_audio = stderr.lines().any(|line| line.contains("Audio:"));
    let duration = stderr.lines().find_map(|line| {
        let line = line.trim();
        let rest = line.strip_prefix("Duration:")?;
        let token = rest.split(',').next()?.trim();
        parse_timestamp(token)
    });
    let video_codec = parse_video_codec(stderr);
    let previewable = video_codec
        .as_deref()
        .map(is_browser_previewable)
        .unwrap_or(false);

    MediaInfo {
        has_video,
        has_audio,
        duration,
        video_codec,
        previewable,
    }
}

pub fn preview_cache_path(source: &str) -> Result<std::path::PathBuf, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::UNIX_EPOCH;

    let meta = std::fs::metadata(source).map_err(|e| e.to_string())?;
    let mut hasher = DefaultHasher::new();
    source.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    if let Ok(modified) = meta.modified() {
        if let Ok(elapsed) = modified.duration_since(UNIX_EPOCH) {
            elapsed.as_secs().hash(&mut hasher);
        }
    }
    let dir = std::env::temp_dir().join("video-editor-previews");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{:x}.mp4", hasher.finish())))
}

pub fn build_preview_args(input_path: &str, output_path: &str) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-y".into(),
        "-i".into(),
        input_path.to_string(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a:0?".into(),
        "-vf".into(),
        "scale=trunc(min(1280\\,iw)/2)*2:-2".into(),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "ultrafast".into(),
        "-crf".into(),
        "28".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-c:a".into(),
        "aac".into(),
        "-ac".into(),
        "2".into(),
        "-b:a".into(),
        "128k".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.to_string(),
    ]
}

pub fn parse_timestamp(value: &str) -> Option<f64> {
    let mut parts = value.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

pub fn parse_progress_seconds(chunk: &str) -> Option<f64> {
    for line in chunk.lines() {
        if let Some(us) = line.trim().strip_prefix("out_time_us=") {
            if let Ok(value) = us.parse::<f64>() {
                if value >= 0.0 {
                    return Some(value / 1_000_000.0);
                }
            }
        }
        if let Some(ms) = line.trim().strip_prefix("out_time_ms=") {
            if let Ok(value) = ms.parse::<f64>() {
                if value >= 0.0 {
                    return Some(value / 1_000.0);
                }
            }
        }
        if let Some(time) = line.trim().strip_prefix("out_time=") {
            if let Some(secs) = parse_timestamp(time.trim()) {
                return Some(secs);
            }
        }
    }
    None
}

pub fn build_ffmpeg_args(opts: &ExportOptions) -> Result<Vec<String>, String> {
    if opts.input_path.trim().is_empty() {
        return Err("Choose a video before saving.".into());
    }
    if opts.output_path.trim().is_empty() {
        return Err("Choose where to save the new MP4.".into());
    }
    if normalize_path(&opts.input_path) == normalize_path(&opts.output_path) {
        return Err("Choose a new file. The original is never overwritten.".into());
    }

    let speed = (opts.speed * 10.0).round() / 10.0;
    if !(0.1..=2.0).contains(&speed) {
        return Err("Speed must be between 0.1x and 2.0x.".into());
    }

    let start = opts.trim_start.max(0.0);
    let end = opts.trim_end;
    if end - start < MIN_CLIP_SECS {
        return Err("Trim range is too short.".into());
    }

    let source_duration = end - start;
    let output_duration = source_duration / speed;
    let audio_mode = opts.audio_mode.as_str();

    let mut args = vec![
        "-hide_banner".into(),
        "-y".into(),
        "-ss".into(),
        format!("{start:.3}"),
        "-t".into(),
        format!("{source_duration:.3}"),
        "-i".into(),
        opts.input_path.clone(),
    ];

    if audio_mode == "replace" {
        let replacement = opts
            .replacement_audio_path
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Choose an audio file to replace the original track.".to_string())?;
        args.extend(["-i".into(), replacement.to_string()]);
    }

    let video_filter = if (speed - 1.0).abs() < 0.001 {
        "null".to_string()
    } else {
        format!("setpts=PTS/{speed}")
    };

    match audio_mode {
        "remove" => {
            args.extend([
                "-filter:v".into(),
                video_filter,
                "-an".into(),
            ]);
        }
        "replace" => {
            let audio_filter = format!(
                "atrim=duration={output_duration:.3},apad=whole_dur={output_duration:.3},asetpts=PTS-STARTPTS"
            );
            args.extend([
                "-filter_complex".into(),
                format!("[0:v]{video_filter}[v];[1:a]{audio_filter}[a]"),
                "-map".into(),
                "[v]".into(),
                "-map".into(),
                "[a]".into(),
            ]);
        }
        "keep" => {
            if opts.has_source_audio {
                let tempos = atempo_chain(speed);
                if tempos.is_empty() {
                    args.extend([
                        "-filter:v".into(),
                        video_filter,
                        "-map".into(),
                        "0:v:0".into(),
                        "-map".into(),
                        "0:a:0?".into(),
                    ]);
                } else {
                    let audio_filter = tempos
                        .iter()
                        .map(|t| format!("atempo={}", fmt_tempo(*t)))
                        .collect::<Vec<_>>()
                        .join(",");
                    args.extend([
                        "-filter_complex".into(),
                        format!("[0:v]{video_filter}[v];[0:a]{audio_filter}[a]"),
                        "-map".into(),
                        "[v]".into(),
                        "-map".into(),
                        "[a]".into(),
                    ]);
                }
            } else {
                args.extend(["-filter:v".into(), video_filter, "-an".into()]);
            }
        }
        other => return Err(format!("Unknown audio mode: {other}")),
    }

    args.extend([
        "-t".into(),
        format!("{output_duration:.3}"),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "23".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-movflags".into(),
        "+faststart".into(),
    ]);

    if audio_mode != "remove" && (audio_mode == "replace" || opts.has_source_audio) {
        args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
    }

    args.extend([
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        opts.output_path.clone(),
    ]);

    Ok(args)
}

pub fn output_duration(opts: &ExportOptions) -> f64 {
    let speed = (opts.speed * 10.0).round() / 10.0;
    ((opts.trim_end - opts.trim_start).max(MIN_CLIP_SECS)) / speed.max(0.1)
}

pub const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp"];
pub const MAX_SLIDESHOW_IMAGES: usize = 80;

fn default_fade_seconds() -> f64 {
    1.5
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideshowOptions {
    pub images: Vec<String>,
    pub output_path: String,
    pub hold_seconds: f64,
    pub transition: String,
    #[serde(default = "default_fade_seconds")]
    pub fade_seconds: f64,
    pub audio_mode: String,
    pub replacement_audio_path: Option<String>,
}

pub fn round_fade(value: f64) -> f64 {
    ((value * 2.0).round() / 2.0).clamp(0.0, 5.0)
}

pub fn parse_fade_seconds(value: f64) -> Result<f64, String> {
    let fade = round_fade(value);
    if (value - fade).abs() > 0.001 {
        return Err("Fade must be between 0 and 5 seconds in 0.5 steps.".into());
    }
    Ok(fade)
}

pub fn effective_fade(requested: f64, hold: f64, transition: &str) -> f64 {
    let fade = round_fade(requested);
    if transition == "cut" || fade < 0.05 {
        return 0.0;
    }
    if transition == "crossfade" {
        let max = round_fade((hold - 0.5).max(0.0));
        return fade.min(max);
    }
    fade.min(hold)
}

pub fn slideshow_output_duration(count: usize, hold: f64, transition: &str, fade: f64) -> f64 {
    if count == 0 {
        return 0.0;
    }
    if count == 1 || transition != "crossfade" {
        return count as f64 * hold;
    }
    let fade = effective_fade(fade, hold, transition);
    count as f64 * hold - (count - 1) as f64 * fade
}

fn scale_pad_filter() -> &'static str {
    "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=yuv420p"
}

fn concat_labels(script: &mut String, labels: impl Iterator<Item = String>, count: usize) {
    for label in labels {
        script.push_str(&label);
    }
    script.push_str(&format!("concat=n={count}:v=1:a=0[vout]\n"));
}

pub fn build_slideshow_filter(
    count: usize,
    hold: f64,
    transition: &str,
    fade_seconds: f64,
) -> Result<String, String> {
    if count == 0 {
        return Err("Choose a folder that contains photos.".into());
    }
    let fade = effective_fade(fade_seconds, hold, transition);
    let scale = scale_pad_filter();
    let mut script = String::new();
    if count == 1 {
        script.push_str(&format!("[0:v]{scale}[vout]\n"));
        return Ok(script);
    }
    for i in 0..count {
        script.push_str(&format!("[{i}:v]{scale}[v{i}];\n"));
    }

    let kind = if fade < 0.05 { "cut" } else { transition };
    match kind {
        "cut" => {
            concat_labels(&mut script, (0..count).map(|i| format!("[v{i}]")), count);
        }
        "fade" => {
            let fade_out_at = (hold - fade).max(0.0);
            for i in 0..count {
                script.push_str(&format!(
                    "[v{i}]fade=t=in:st=0:d={fade:.3},fade=t=out:st={fade_out_at:.3}:d={fade:.3}[f{i}];\n"
                ));
            }
            concat_labels(&mut script, (0..count).map(|i| format!("[f{i}]")), count);
        }
        "crossfade" => {
            let step = (hold - fade).max(0.01);
            let mut last = "v0".to_string();
            for i in 1..count {
                let offset = i as f64 * step;
                let out = if i + 1 == count {
                    "vout".to_string()
                } else {
                    format!("x{i}")
                };
                script.push_str(&format!(
                    "[{last}][v{i}]xfade=transition=fade:duration={fade:.3}:offset={offset:.3}[{out}];\n"
                ));
                last = out;
            }
            if script.ends_with(";\n") {
                script.truncate(script.len() - 2);
                script.push('\n');
            }
        }
        other => return Err(format!("Unknown transition: {other}")),
    }

    Ok(script)
}

pub fn build_slideshow_args(
    staged_names: &[String],
    output_path: &str,
    hold: f64,
    transition: &str,
    fade_seconds: f64,
    audio_mode: &str,
    replacement_audio_path: Option<&str>,
) -> Result<(Vec<String>, f64), String> {
    if staged_names.is_empty() {
        return Err("Choose a folder that contains photos.".into());
    }
    if staged_names.len() > MAX_SLIDESHOW_IMAGES {
        return Err(format!(
            "This folder has too many photos. Use {MAX_SLIDESHOW_IMAGES} or fewer."
        ));
    }
    if ![2.0, 5.0, 10.0, 20.0, 30.0].contains(&hold) {
        return Err("Choose 2, 5, 10, 20, or 30 seconds per photo.".into());
    }
    let fade = parse_fade_seconds(fade_seconds)?;

    let duration = slideshow_output_duration(staged_names.len(), hold, transition, fade);
    let input_t = if transition == "crossfade" && effective_fade(fade, hold, transition) > 0.0 {
        hold + 0.1
    } else {
        hold
    };
    let mut args = vec!["-hide_banner".into(), "-y".into()];
    for name in staged_names {
        args.extend([
            "-loop".into(),
            "1".into(),
            "-framerate".into(),
            "30".into(),
            "-t".into(),
            format!("{input_t:.3}"),
            "-i".into(),
            name.clone(),
        ]);
    }

    if audio_mode == "replace" {
        let replacement = replacement_audio_path
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Choose an audio file to replace the original track.".to_string())?;
        args.extend(["-i".into(), replacement.to_string()]);
    }

    let filter = build_slideshow_filter(staged_names.len(), hold, transition, fade)?;
    args.extend([
        "-filter_complex".into(),
        filter.trim().replace('\n', ""),
        "-map".into(),
        "[vout]".into(),
    ]);

    if audio_mode == "replace" {
        args.extend(["-map".into(), format!("{}:a:0", staged_names.len())]);
        args.extend([
            "-af".into(),
            format!("apad=whole_dur={duration:.3}"),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
        ]);
        args.extend(["-t".into(), format!("{duration:.3}")]);
    } else {
        args.push("-an".into());
        args.extend(["-t".into(), format!("{duration:.3}")]);
    }

    args.extend([
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "23".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_path.to_string(),
    ]);

    Ok((args, duration))
}

pub fn list_image_files(folder: &str) -> Result<Vec<String>, String> {
    let mut images = Vec::new();
    let entries = std::fs::read_dir(folder).map_err(|e| format!("Could not open folder: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
            images.push(path.to_string_lossy().into_owned());
        }
    }
    images.sort_by(|a, b| {
        let an = std::path::Path::new(a)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(a)
            .to_ascii_lowercase();
        let bn = std::path::Path::new(b)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(b)
            .to_ascii_lowercase();
        an.cmp(&bn)
    });
    if images.is_empty() {
        return Err("This folder has no JPG, PNG, WebP, or BMP photos.".into());
    }
    if images.len() > MAX_SLIDESHOW_IMAGES {
        return Err(format!(
            "This folder has {} photos. Use {MAX_SLIDESHOW_IMAGES} or fewer.",
            images.len()
        ));
    }
    Ok(images)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atempo_identity() {
        assert!(atempo_chain(1.0).is_empty());
    }

    #[test]
    fn atempo_slow() {
        let parts = atempo_chain(0.1);
        let product: f64 = parts.iter().product();
        assert!((product - 0.1).abs() < 0.001);
        assert!(parts.iter().all(|v| *v >= 0.5 && *v <= 2.0));
    }

    #[test]
    fn atempo_fast() {
        assert_eq!(atempo_chain(2.0), vec![2.0]);
        assert_eq!(atempo_chain(1.5), vec![1.5]);
    }

    #[test]
    fn progress_from_us() {
        assert_eq!(
            parse_progress_seconds("out_time_us=1500000\nprogress=continue\n"),
            Some(1.5)
        );
    }

    #[test]
    fn hevc_is_not_previewable() {
        let info = parse_ffmpeg_probe(
            "Duration: 00:00:03.00, start: 0.000000\n  Stream #0:0: Video: hevc (Main) (hvc1 / 0x31637668)\n  Stream #0:1: Audio: aac\n",
        );
        assert_eq!(info.video_codec.as_deref(), Some("hevc"));
        assert!(!info.previewable);
        assert!(info.has_audio);
    }

    #[test]
    fn h264_is_previewable() {
        assert!(is_browser_previewable("h264"));
        assert!(!is_browser_previewable("hvc1"));
        assert!(!is_browser_previewable("hevc"));
    }

    #[test]
    fn replace_audio_args_fit_output_duration() {
        let opts = ExportOptions {
            input_path: r"C:\in.mp4".into(),
            output_path: r"C:\out.mp4".into(),
            trim_start: 1.0,
            trim_end: 5.0,
            speed: 2.0,
            audio_mode: "replace".into(),
            replacement_audio_path: Some(r"C:\bed.mp3".into()),
            has_source_audio: true,
        };
        let args = build_ffmpeg_args(&opts).unwrap();
        let joined = args.join(" ");
        assert!(joined.contains("setpts=PTS/2"));
        assert!(joined.contains("atrim=duration=2.000"));
        assert!(joined.contains("-an") == false);
        assert!(args.contains(&"libx264".to_string()));
    }

    #[test]
    fn slideshow_crossfade_is_shorter_than_cut() {
        let cut = slideshow_output_duration(4, 5.0, "cut", 1.5);
        let fade = slideshow_output_duration(4, 5.0, "fade", 1.5);
        let cross = slideshow_output_duration(4, 5.0, "crossfade", 1.5);
        assert_eq!(cut, 20.0);
        assert_eq!(fade, 20.0);
        assert!((cross - 15.5).abs() < 0.001);
    }

    #[test]
    fn slideshow_zero_fade_matches_cut_duration() {
        let cut = slideshow_output_duration(3, 5.0, "cut", 0.0);
        let cross = slideshow_output_duration(3, 5.0, "crossfade", 0.0);
        assert_eq!(cut, 15.0);
        assert_eq!(cross, 15.0);
    }

    #[test]
    fn slideshow_filter_uses_xfade() {
        let filter = build_slideshow_filter(3, 5.0, "crossfade", 1.5).unwrap();
        assert!(filter.contains("xfade=transition=fade:duration=1.500"));
        assert!(filter.contains("[vout]"));
    }

    #[test]
    fn slideshow_args_use_inline_filter_complex() {
        let (args, duration) = build_slideshow_args(
            &["0001.png".into(), "0002.png".into()],
            r"C:\out.mp4",
            2.0,
            "cut",
            1.5,
            "remove",
            None,
        )
        .unwrap();
        assert!((duration - 4.0).abs() < 0.001);
        assert!(args.contains(&"-filter_complex".to_string()));
        assert!(!args.iter().any(|a| a.contains("filter_complex_script")));
        let filter = args
            .windows(2)
            .find(|pair| pair[0] == "-filter_complex")
            .map(|pair| pair[1].as_str())
            .unwrap();
        assert!(filter.contains("concat=n=2:v=1:a=0[vout]"));
        assert!(!filter.contains('\n'));
    }
}
