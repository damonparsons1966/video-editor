import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import Timeline from "./Timeline";
import {
  AUDIO_EXTENSIONS,
  fileNameOf,
  formatClock,
  isAudioPath,
  isVideoPath,
  MIN_CLIP_SECONDS,
  outputDuration,
  roundSpeed,
  stemOf,
  VIDEO_EXTENSIONS,
} from "./media";
import "./App.css";

type AudioMode = "keep" | "remove" | "replace";

type MediaInfo = {
  hasVideo: boolean;
  hasAudio: boolean;
  duration: number | null;
  videoCodec: string | null;
  previewable: boolean;
};

function DropHint({
  dragging,
  onOpen,
}: {
  dragging: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={`dropzone ${dragging ? "dragging" : ""}`}
      onClick={onOpen}
    >
      <strong>Open or drop a video</strong>
      <span>MP4, MOV, or WebM</span>
    </button>
  );
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const loadGeneration = useRef(0);
  const usingProxy = useRef(false);

  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [audioMode, setAudioMode] = useState<AudioMode>("keep");
  const [hasSourceAudio, setHasSourceAudio] = useState(true);
  const [replacementPath, setReplacementPath] = useState<string | null>(null);
  const [replacementUrl, setReplacementUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportPercent, setExportPercent] = useState(0);
  const [preparingPreview, setPreparingPreview] = useState(false);
  const [previewPercent, setPreviewPercent] = useState(0);

  const outDuration = useMemo(
    () => outputDuration(trimStart, trimEnd, speed),
    [trimStart, trimEnd, speed],
  );

  function pausePlayback() {
    videoRef.current?.pause();
    audioRef.current?.pause();
    setPlaying(false);
  }

  function syncReplacementAudio(force = false) {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio || audioMode !== "replace") {
      return;
    }
    const target = Math.max(0, (video.currentTime - trimStart) / speed);
    if (force || Math.abs(audio.currentTime - target) > 0.12) {
      audio.currentTime = target;
    }
  }

  async function makePreview(path: string, durationSecs: number | null, generation: number) {
    setPreparingPreview(true);
    setPreviewPercent(0);
    setError(null);
    try {
      const proxyPath = await invoke<string>("prepare_preview", {
        path,
        duration: durationSecs,
      });
      if (generation !== loadGeneration.current) {
        return;
      }
      usingProxy.current = true;
      setVideoUrl(convertFileSrc(proxyPath));
    } catch (cause) {
      if (generation !== loadGeneration.current) {
        return;
      }
      const message = typeof cause === "string" ? cause : "Could not prepare a preview.";
      if (message !== "Preview cancelled.") {
        setError(message);
      }
    } finally {
      if (generation === loadGeneration.current) {
        setPreparingPreview(false);
      }
    }
  }

  async function loadVideo(path: string) {
    if (!isVideoPath(path)) {
      setError("This file type isn't supported. Use MP4, MOV, or WebM.");
      return;
    }

    const generation = ++loadGeneration.current;
    pausePlayback();
    usingProxy.current = false;
    setError(null);
    setVideoPath(path);
    setVideoUrl(null);
    setCurrentTime(0);
    setTrimStart(0);
    setTrimEnd(0);
    setDuration(0);
    setSpeed(1);
    setAudioMode("keep");
    setReplacementPath(null);
    setReplacementUrl(null);
    setHasSourceAudio(true);
    setPreparingPreview(false);

    try {
      const info = await invoke<MediaInfo>("probe_media", { path });
      if (generation !== loadGeneration.current) {
        return;
      }
      setHasSourceAudio(info.hasAudio);
      if (info.duration && Number.isFinite(info.duration)) {
        setDuration(info.duration);
        setTrimEnd(info.duration);
      }
      if (info.previewable) {
        setVideoUrl(convertFileSrc(path));
      } else {
        await makePreview(path, info.duration, generation);
      }
    } catch (cause) {
      if (generation !== loadGeneration.current) {
        return;
      }
      console.warn("probe_media failed", cause);
      setVideoUrl(convertFileSrc(path));
    }
  }

  async function openVideoDialog() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: [...VIDEO_EXTENSIONS] }],
    });
    if (typeof selected === "string") {
      await loadVideo(selected);
    }
  }

  async function chooseReplacementAudio() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Audio", extensions: [...AUDIO_EXTENSIONS] }],
    });
    if (typeof selected !== "string") {
      return;
    }
    if (!isAudioPath(selected)) {
      setError("Use an MP3, WAV, M4A, or AAC audio file.");
      return;
    }
    setError(null);
    setReplacementPath(selected);
    setReplacementUrl(convertFileSrc(selected));
    setAudioMode("replace");
    if (videoRef.current) {
      videoRef.current.muted = true;
    }
  }

  function setMode(mode: AudioMode) {
    if (mode === "replace" && !replacementPath) {
      void chooseReplacementAudio();
      return;
    }
    setAudioMode(mode);
    if (mode !== "replace") {
      audioRef.current?.pause();
    }
    if (videoRef.current) {
      videoRef.current.muted = mode !== "keep";
    }
  }

  async function togglePlay() {
    const video = videoRef.current;
    if (!video || duration <= 0) {
      return;
    }

    if (!video.paused) {
      pausePlayback();
      return;
    }

    if (video.currentTime < trimStart || video.currentTime >= trimEnd - 0.04) {
      video.currentTime = trimStart;
      setCurrentTime(trimStart);
    }

    video.playbackRate = speed;
    video.muted = audioMode !== "keep";

    try {
      await video.play();
      if (audioMode === "replace" && audioRef.current) {
        audioRef.current.currentTime = Math.max(
          0,
          (video.currentTime - trimStart) / speed,
        );
        await audioRef.current.play();
      }
      setPlaying(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not play this file.");
      pausePlayback();
    }
  }

  function seekTo(time: number) {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const clamped = Math.min(Math.max(time, trimStart), Math.max(trimStart, trimEnd - 0.01));
    video.currentTime = clamped;
    setCurrentTime(clamped);
    syncReplacementAudio(true);
  }

  function changeSpeed(next: number) {
    const value = roundSpeed(next);
    setSpeed(value);
    if (videoRef.current) {
      videoRef.current.playbackRate = value;
    }
    syncReplacementAudio(true);
  }

  function updateTrimStart(time: number) {
    const next = Math.min(Math.max(0, time), trimEnd - MIN_CLIP_SECONDS);
    setTrimStart(next);
    seekTo(next);
  }

  function updateTrimEnd(time: number) {
    const next = Math.max(Math.min(duration, time), trimStart + MIN_CLIP_SECONDS);
    setTrimEnd(next);
    seekTo(next);
  }

  async function saveAs() {
    if (!videoPath || exporting) {
      return;
    }
    if (audioMode === "replace" && !replacementPath) {
      setError("Choose an audio file to replace the original track.");
      return;
    }

    const selectedPath = await save({
      defaultPath: `${stemOf(videoPath)}-edited.mp4`,
      filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
    });
    if (typeof selectedPath !== "string") {
      return;
    }
    const outputPath = selectedPath.toLowerCase().endsWith(".mp4")
      ? selectedPath
      : `${selectedPath}.mp4`;
    if (outputPath.replace(/\//g, "\\").toLowerCase() === videoPath.replace(/\//g, "\\").toLowerCase()) {
      setError("Choose a new file. The original is never overwritten.");
      return;
    }

    setError(null);
    setExporting(true);
    setExportPercent(0);
    pausePlayback();

    try {
      await invoke("export_video", {
        options: {
          inputPath: videoPath,
          outputPath,
          trimStart,
          trimEnd,
          speed,
          audioMode,
          replacementAudioPath: replacementPath,
          hasSourceAudio,
        },
      });
      setExportPercent(100);
    } catch (cause) {
      const message = typeof cause === "string" ? cause : "Save failed.";
      if (message !== "Export cancelled.") {
        setError(message);
      }
    } finally {
      setExporting(false);
    }
  }

  async function cancelExport() {
    await invoke("cancel_export");
    setExporting(false);
  }

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.playbackRate = speed;
      video.muted = audioMode !== "keep";
    }
  }, [speed, audioMode, videoUrl]);

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenPreview: (() => void) | undefined;
    let unlistenDrop: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      try {
        unlistenProgress = await listen<number>("export-progress", (event) => {
          setExportPercent(event.payload);
        });
        unlistenPreview = await listen<number>("preview-progress", (event) => {
          setPreviewPercent(event.payload);
        });
        unlistenDrop = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDragging(true);
          } else if (event.payload.type === "leave") {
            setDragging(false);
          } else if (event.payload.type === "drop") {
            setDragging(false);
            const path = event.payload.paths[0];
            if (path) {
              void loadVideo(path);
            }
          }
        });
      } catch (cause) {
        console.warn("Tauri event setup failed", cause);
      }
      if (cancelled) {
        unlistenProgress?.();
        unlistenPreview?.();
        unlistenDrop?.();
      }
    })();

    return () => {
      cancelled = true;
      unlistenProgress?.();
      unlistenPreview?.();
      unlistenDrop?.();
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.code !== "Space") {
        return;
      }
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") {
        return;
      }
      event.preventDefault();
      void togglePlay();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <main className={`app ${dragging ? "file-drag" : ""}`}>
      <header className="topbar">
        <div>
          <h1>Video Editor</h1>
          <p>
            {videoPath
              ? fileNameOf(videoPath)
              : "Trim, change speed, replace audio, then Save As a new MP4."}
          </p>
        </div>
        <div className="topbar-actions">
          <button type="button" onClick={() => void openVideoDialog()}>
            Open…
          </button>
          <button
            type="button"
            className="primary"
            disabled={!videoPath || exporting || preparingPreview}
            onClick={() => void saveAs()}
          >
            Save As…
          </button>
        </div>
      </header>

      {videoPath ? (
        <section className="workspace">
          <div className="preview-wrap">
            {videoUrl ? (
            <video
              ref={videoRef}
              src={videoUrl}
              playsInline
              preload="auto"
              onLoadedMetadata={(event) => {
                const clip = event.currentTarget.duration || 0;
                setDuration(clip);
                setTrimStart(0);
                setTrimEnd(clip);
                event.currentTarget.playbackRate = speed;
                if (clip > 0) {
                  event.currentTarget.currentTime = 0.001;
                }
              }}
              onLoadedData={(event) => {
                if (
                  event.currentTarget.videoWidth === 0 &&
                  videoPath &&
                  !usingProxy.current &&
                  !preparingPreview
                ) {
                  void makePreview(videoPath, duration || null, loadGeneration.current);
                }
              }}
              onTimeUpdate={(event) => {
                const time = event.currentTarget.currentTime;
                if (time < trimStart) {
                  event.currentTarget.currentTime = trimStart;
                  setCurrentTime(trimStart);
                  return;
                }
                if (time >= trimEnd) {
                  event.currentTarget.currentTime = trimEnd;
                  setCurrentTime(trimEnd);
                  pausePlayback();
                  return;
                }
                setCurrentTime(time);
                syncReplacementAudio();
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onError={() =>
                setError("This video could not be previewed. Try another MP4, MOV, or WebM file.")
              }
            />
            ) : null}
            <audio
              ref={audioRef}
              className="hidden-audio"
              src={replacementUrl ?? undefined}
              preload="auto"
            />
          </div>

          <Timeline
            duration={duration}
            currentTime={currentTime}
            trimStart={trimStart}
            trimEnd={Math.max(trimEnd, trimStart + MIN_CLIP_SECONDS)}
            onTrimStart={updateTrimStart}
            onTrimEnd={updateTrimEnd}
            onSeek={seekTo}
          />

          <div className="controls">
            <button
              type="button"
              className="play"
              disabled={!videoUrl || preparingPreview}
              onClick={() => void togglePlay()}
            >
              {playing ? "Pause" : "Play"}
            </button>
            <div className="clock">
              <span>
                {formatClock(Math.max(0, currentTime - trimStart))} /{" "}
                {formatClock(trimEnd - trimStart)}
              </span>
              <span className="muted">
                Output {formatClock(outDuration)}
                {speed !== 1 ? ` at ${speed.toFixed(1)}x` : ""}
              </span>
            </div>

            <div className="speed">
              <span>Speed</span>
              <button type="button" onClick={() => changeSpeed(speed - 0.1)}>
                −
              </button>
              <strong>{speed.toFixed(1)}x</strong>
              <button type="button" onClick={() => changeSpeed(speed + 0.1)}>
                +
              </button>
            </div>
          </div>

          <div className="audio-bar">
            <span>Audio</span>
            <div className="segmented">
              <button
                type="button"
                className={audioMode === "keep" ? "active" : ""}
                onClick={() => setMode("keep")}
                disabled={!hasSourceAudio}
              >
                Keep original
              </button>
              <button
                type="button"
                className={audioMode === "remove" ? "active" : ""}
                onClick={() => setMode("remove")}
              >
                Remove
              </button>
              <button
                type="button"
                className={audioMode === "replace" ? "active" : ""}
                onClick={() => setMode("replace")}
              >
                Replace…
              </button>
            </div>
            {audioMode === "replace" && replacementPath ? (
              <span className="audio-name" title={replacementPath}>
                {fileNameOf(replacementPath)}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setReplacementPath(null);
                    setReplacementUrl(null);
                    setMode("keep");
                  }}
                >
                  Clear
                </button>
              </span>
            ) : (
              <span className="muted">
                {hasSourceAudio
                  ? "Replacement audio is fitted to the saved length."
                  : "This video has no audio track."}
              </span>
            )}
          </div>
        </section>
      ) : (
        <DropHint dragging={dragging} onOpen={() => void openVideoDialog()} />
      )}

      {error ? <p className="error">{error}</p> : null}

      {preparingPreview ? (
        <div className="export-overlay">
          <div className="export-card">
            <h2>Preparing preview…</h2>
            <p className="muted">This file needs a lightweight H.264 copy so it can be shown here.</p>
            <div className="progress">
              <div className="progress-bar" style={{ width: `${previewPercent}%` }} />
            </div>
            <p>{previewPercent}%</p>
            <button
              type="button"
              onClick={() => {
                void invoke("cancel_export");
                setPreparingPreview(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {exporting ? (
        <div className="export-overlay">
          <div className="export-card">
            <h2>Saving MP4…</h2>
            <div className="progress">
              <div className="progress-bar" style={{ width: `${exportPercent}%` }} />
            </div>
            <p>{exportPercent}%</p>
            <button type="button" onClick={() => void cancelExport()}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
