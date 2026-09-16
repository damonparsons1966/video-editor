import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import Timeline from "./Timeline";
import SlideshowPreview from "./SlideshowPreview";
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
import {
  HOLD_SECONDS,
  slideshowDuration,
  type HoldSeconds,
  type SlideTransition,
} from "./slideshow";
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
  onOpenVideo,
  onOpenPhotos,
}: {
  dragging: boolean;
  onOpenVideo: () => void;
  onOpenPhotos: () => void;
}) {
  return (
    <div className={`dropzone dropzone-split ${dragging ? "dragging" : ""}`}>
      <strong>Open a video or a folder of photos</strong>
      <span>MP4, MOV, WebM — or JPG, PNG, WebP, BMP</span>
      <div className="dropzone-actions">
        <button type="button" onClick={onOpenVideo}>
          Open video…
        </button>
        <button type="button" className="primary" onClick={onOpenPhotos}>
          Open photos…
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const loadGeneration = useRef(0);
  const usingProxy = useRef(false);
  const slideshowClock = useRef({ origin: 0, from: 0 });

  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [slideshowFolder, setSlideshowFolder] = useState<string | null>(null);
  const [slideshowImages, setSlideshowImages] = useState<string[]>([]);
  const [holdSeconds, setHoldSeconds] = useState<HoldSeconds>(5);
  const [transition, setTransition] = useState<SlideTransition>("cut");
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

  const isSlideshow = slideshowImages.length > 0;
  const hasProject = Boolean(videoPath || isSlideshow);

  const slideshowLength = useMemo(
    () => slideshowDuration(slideshowImages.length, holdSeconds, transition),
    [slideshowImages.length, holdSeconds, transition],
  );

  const outDuration = useMemo(() => {
    if (isSlideshow) {
      return slideshowLength;
    }
    return outputDuration(trimStart, trimEnd, speed);
  }, [isSlideshow, slideshowLength, trimStart, trimEnd, speed]);

  function pausePlayback() {
    videoRef.current?.pause();
    audioRef.current?.pause();
    setPlaying(false);
  }

  function resetEditor() {
    pausePlayback();
    usingProxy.current = false;
    setError(null);
    setVideoPath(null);
    setVideoUrl(null);
    setSlideshowFolder(null);
    setSlideshowImages([]);
    setCurrentTime(0);
    setTrimStart(0);
    setTrimEnd(0);
    setDuration(0);
    setSpeed(1);
    setReplacementPath(null);
    setReplacementUrl(null);
    setPreparingPreview(false);
  }

  function syncReplacementAudio(force = false) {
    const audio = audioRef.current;
    if (!audio || audioMode !== "replace") {
      return;
    }
    const target = isSlideshow
      ? Math.max(0, currentTime)
      : Math.max(0, ((videoRef.current?.currentTime ?? currentTime) - trimStart) / speed);
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
    resetEditor();
    setVideoPath(path);
    setAudioMode("keep");
    setHasSourceAudio(true);

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

  async function loadSlideshow(folder: string, images: string[]) {
    const generation = ++loadGeneration.current;
    resetEditor();
    setSlideshowFolder(folder);
    setSlideshowImages(images);
    setHoldSeconds(5);
    setTransition("cut");
    setAudioMode("remove");
    setHasSourceAudio(false);
    const length = slideshowDuration(images.length, 5, "cut");
    setDuration(length);
    setTrimEnd(length);
    setCurrentTime(0);
    if (generation !== loadGeneration.current) {
      return;
    }
  }

  async function openDroppedPath(path: string) {
    if (isVideoPath(path)) {
      await loadVideo(path);
      return;
    }
    try {
      const images = await invoke<string[]>("list_slideshow_images", { folder: path });
      await loadSlideshow(path, images);
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "Drop a video file or a folder of photos.");
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

  async function openPhotoFolderDialog() {
    const selected = await open({
      directory: true,
      multiple: false,
    });
    if (typeof selected !== "string") {
      return;
    }
    try {
      const images = await invoke<string[]>("list_slideshow_images", { folder: selected });
      await loadSlideshow(selected, images);
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "Could not open that photo folder.");
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
    if (mode === "keep" && isSlideshow) {
      return;
    }
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
    if (isSlideshow) {
      if (playing) {
        pausePlayback();
        return;
      }
      const startAt = currentTime >= slideshowLength - 0.04 ? 0 : currentTime;
      setCurrentTime(startAt);
      slideshowClock.current = { origin: performance.now(), from: startAt };
      if (audioMode === "replace" && audioRef.current) {
        audioRef.current.currentTime = startAt;
        try {
          await audioRef.current.play();
        } catch {
          // Preview still works without audio.
        }
      }
      setPlaying(true);
      return;
    }

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
    if (isSlideshow) {
      const clamped = Math.min(Math.max(time, 0), Math.max(0, slideshowLength - 0.01));
      setCurrentTime(clamped);
      slideshowClock.current = { origin: performance.now(), from: clamped };
      if (audioRef.current && audioMode === "replace") {
        audioRef.current.currentTime = clamped;
      }
      return;
    }
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
    if (exporting) {
      return;
    }
    if (audioMode === "replace" && !replacementPath) {
      setError("Choose an audio file to put under the video.");
      return;
    }

    if (isSlideshow && slideshowFolder) {
      const selectedPath = await save({
        defaultPath: `${stemOf(slideshowFolder) || "slideshow"}-photos.mp4`,
        filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
      });
      if (typeof selectedPath !== "string") {
        return;
      }
      const outputPath = selectedPath.toLowerCase().endsWith(".mp4")
        ? selectedPath
        : `${selectedPath}.mp4`;
      setError(null);
      setExporting(true);
      setExportPercent(0);
      pausePlayback();
      try {
        await invoke("export_slideshow", {
          options: {
            images: slideshowImages,
            outputPath,
            holdSeconds,
            transition,
            audioMode,
            replacementAudioPath: replacementPath,
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
      return;
    }

    if (!videoPath) {
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
    if (!isSlideshow) {
      return;
    }
    const length = slideshowDuration(slideshowImages.length, holdSeconds, transition);
    setDuration(length);
    setTrimStart(0);
    setTrimEnd(length);
    setCurrentTime((time) => Math.min(time, Math.max(0, length - 0.01)));
  }, [isSlideshow, slideshowImages.length, holdSeconds, transition]);

  useEffect(() => {
    if (!isSlideshow || !playing) {
      return;
    }
    let frame = 0;
    const tick = (now: number) => {
      const next = slideshowClock.current.from + (now - slideshowClock.current.origin) / 1000;
      if (next >= slideshowLength) {
        setCurrentTime(slideshowLength);
        audioRef.current?.pause();
        setPlaying(false);
        return;
      }
      setCurrentTime(next);
      if (audioMode === "replace" && audioRef.current) {
        const drift = Math.abs(audioRef.current.currentTime - next);
        if (drift > 0.25) {
          audioRef.current.currentTime = next;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isSlideshow, playing, slideshowLength, audioMode]);

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
              void openDroppedPath(path);
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
            {isSlideshow && slideshowFolder
              ? `${fileNameOf(slideshowFolder)} · ${slideshowImages.length} photos`
              : videoPath
                ? fileNameOf(videoPath)
                : "Edit a video, or build a slideshow from a folder of photos."}
          </p>
        </div>
        <div className="topbar-actions">
          <button type="button" onClick={() => void openVideoDialog()}>
            Open video…
          </button>
          <button type="button" onClick={() => void openPhotoFolderDialog()}>
            Open photos…
          </button>
          <button
            type="button"
            className="primary"
            disabled={!hasProject || exporting || preparingPreview}
            onClick={() => void saveAs()}
          >
            Save As…
          </button>
        </div>
      </header>

      {hasProject ? (
        <section className="workspace">
          <div className="preview-wrap">
            {isSlideshow ? (
              <SlideshowPreview
                images={slideshowImages}
                holdSeconds={holdSeconds}
                transition={transition}
                currentTime={currentTime}
              />
            ) : videoUrl ? (
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

          {isSlideshow ? (
            <div className="timeline">
              <div className="timeline-times">
                <span>{slideshowImages.length} photos</span>
                <span>{formatClock(slideshowLength)}</span>
              </div>
              <div
                className="timeline-track"
                onPointerDown={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
                  seekTo(ratio * slideshowLength);
                }}
              >
                <div
                  className="timeline-range"
                  style={{ left: "0%", width: "100%" }}
                />
                <div
                  className="timeline-playhead"
                  style={{
                    left: `${slideshowLength > 0 ? (currentTime / slideshowLength) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          ) : (
            <Timeline
              duration={duration}
              currentTime={currentTime}
              trimStart={trimStart}
              trimEnd={Math.max(trimEnd, trimStart + MIN_CLIP_SECONDS)}
              onTrimStart={updateTrimStart}
              onTrimEnd={updateTrimEnd}
              onSeek={seekTo}
            />
          )}

          <div className="controls">
            <button
              type="button"
              className="play"
              disabled={(!videoUrl && !isSlideshow) || preparingPreview}
              onClick={() => void togglePlay()}
            >
              {playing ? "Pause" : "Play"}
            </button>
            <div className="clock">
              <span>
                {formatClock(isSlideshow ? currentTime : Math.max(0, currentTime - trimStart))} /{" "}
                {formatClock(isSlideshow ? slideshowLength : trimEnd - trimStart)}
              </span>
              <span className="muted">
                Output {formatClock(outDuration)}
                {!isSlideshow && speed !== 1 ? ` at ${speed.toFixed(1)}x` : ""}
              </span>
            </div>

            {isSlideshow ? (
              <div className="speed slideshow-opts">
                <span>Each photo</span>
                <div className="segmented">
                  {HOLD_SECONDS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={holdSeconds === value ? "active" : ""}
                      onClick={() => setHoldSeconds(value)}
                    >
                      {value}s
                    </button>
                  ))}
                </div>
              </div>
            ) : (
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
            )}
          </div>

          {isSlideshow ? (
            <div className="audio-bar">
              <span>Transition</span>
              <div className="segmented">
                {(["cut", "fade", "crossfade"] as SlideTransition[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={transition === value ? "active" : ""}
                    onClick={() => setTransition(value)}
                  >
                    {value === "cut" ? "Cut" : value === "fade" ? "Fade in/out" : "Crossfade"}
                  </button>
                ))}
              </div>
              <span className="muted">Applies to every photo</span>
            </div>
          ) : null}

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
                {isSlideshow ? "Silence" : "Remove"}
              </button>
              <button
                type="button"
                className={audioMode === "replace" ? "active" : ""}
                onClick={() => setMode("replace")}
              >
                {isSlideshow ? "Add audio…" : "Replace…"}
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
                    setMode(isSlideshow ? "remove" : "keep");
                  }}
                >
                  Clear
                </button>
              </span>
            ) : (
              <span className="muted">
                {isSlideshow
                  ? "Optional music is fitted to the slideshow length."
                  : hasSourceAudio
                    ? "Replacement audio is fitted to the saved length."
                    : "This video has no audio track."}
              </span>
            )}
          </div>
        </section>
      ) : (
        <DropHint
          dragging={dragging}
          onOpenVideo={() => void openVideoDialog()}
          onOpenPhotos={() => void openPhotoFolderDialog()}
        />
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
            <h2>{isSlideshow ? "Saving slideshow…" : "Saving MP4…"}</h2>
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
