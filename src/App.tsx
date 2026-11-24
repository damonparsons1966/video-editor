import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import Timeline from "./Timeline";
import SlideshowPreview from "./SlideshowPreview";
import AudioOverlays from "./AudioOverlays";
import {
  DEFAULT_VOLUME,
  MAX_AUDIO_OVERLAYS,
  clampTrackFade,
  newOverlayId,
  overlayLocalTime,
  overlayVolume,
  roundStart,
  roundVolume,
  volumeGain,
  type OverlayTrack,
} from "./audioTracks";
import {
  AUDIO_EXTENSIONS,
  fileNameOf,
  formatClock,
  isAudioPath,
  isVideoPath,
  MAX_SPEED,
  MIN_CLIP_SECONDS,
  MIN_SPEED,
  outputDuration,
  roundSpeed,
  SPEED_STEP,
  stemOf,
  VIDEO_EXTENSIONS,
} from "./media";
import {
  DEFAULT_FADE_SECONDS,
  FADE_MIN,
  FADE_STEP,
  HOLD_SECONDS,
  clampFade,
  formatFade,
  maxFadeSeconds,
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

function mediaUrl(path: string) {
  return invoke<string>("media_url", { path });
}

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
  const overlayAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const loadGeneration = useRef(0);
  const mediaJobActive = useRef(false);
  const usingProxy = useRef(false);
  const playReverseWhenReady = useRef(false);
  const stoppingAtEnd = useRef(false);
  const slideshowClock = useRef({ origin: 0, from: 0 });

  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [reversePreview, setReversePreview] = useState<{
    url: string;
    start: number;
    end: number;
  } | null>(null);
  const [slideshowFolder, setSlideshowFolder] = useState<string | null>(null);
  const [slideshowImages, setSlideshowImages] = useState<string[]>([]);
  const [holdSeconds, setHoldSeconds] = useState<HoldSeconds>(5);
  const [transition, setTransition] = useState<SlideTransition>("cut");
  const [fadeSeconds, setFadeSeconds] = useState(DEFAULT_FADE_SECONDS);
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
  const [overlays, setOverlays] = useState<OverlayTrack[]>([]);
  const [baseVolume, setBaseVolume] = useState(DEFAULT_VOLUME);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportPercent, setExportPercent] = useState(0);
  const [preparingPreview, setPreparingPreview] = useState(false);
  const [previewPercent, setPreviewPercent] = useState(0);

  const isSlideshow = slideshowImages.length > 0;
  const hasProject = Boolean(videoPath || isSlideshow);
  const reverseActive = speed <= 0 && reversePreview !== null
    && reversePreview.start === trimStart && reversePreview.end === trimEnd;
  const previewUrl = reverseActive ? reversePreview.url : videoUrl;
  const jobsBusy = preparingPreview || exporting;

  useEffect(() => {
    mediaJobActive.current = jobsBusy;
  }, [jobsBusy]);

  function sourceTimeOf(mediaTime: number) {
    return reverseActive ? trimEnd - mediaTime : mediaTime;
  }

  function seekVideo(video: HTMLVideoElement, sourceTime: number) {
    const time = reverseActive ? trimEnd - sourceTime : sourceTime;
    video.currentTime = Math.max(0, Math.min(time, video.duration || duration));
  }

  const slideshowLength = useMemo(
    () => slideshowDuration(slideshowImages.length, holdSeconds, transition, fadeSeconds),
    [slideshowImages.length, holdSeconds, transition, fadeSeconds],
  );

  const outDuration = useMemo(() => {
    if (isSlideshow) {
      return slideshowLength;
    }
    return outputDuration(trimStart, trimEnd, speed);
  }, [isSlideshow, slideshowLength, trimStart, trimEnd, speed]);

  function previewOutputTime(sourceTime = currentTime): number {
    if (isSlideshow) {
      return Math.max(0, sourceTime);
    }
    if (speed === 0) {
      return 0;
    }
    const elapsed = speed < 0 ? trimEnd - sourceTime : sourceTime - trimStart;
    return Math.max(0, elapsed / Math.abs(speed));
  }

  function pauseOverlayAudio() {
    overlayAudioRefs.current.forEach((audio) => audio.pause());
  }

  function syncOverlays(outputTime: number, force = false) {
    overlays.forEach((track) => {
      const audio = overlayAudioRefs.current.get(track.id);
      if (!audio) {
        return;
      }
      const local = overlayLocalTime(outputTime, track);
      audio.volume = overlayVolume(outputTime, track, outDuration);
      if (local == null) {
        if (!audio.paused) {
          audio.pause();
        }
        return;
      }
      if (force || Math.abs(audio.currentTime - local) > 0.12) {
        audio.currentTime = local;
      }
      if (playing && audio.paused) {
        void audio.play().catch(() => {
          // Preview still works without this track.
        });
      }
    });
  }

  async function playOverlays(outputTime: number) {
    syncOverlays(outputTime, true);
    await Promise.all(
      overlays.map(async (track) => {
        const audio = overlayAudioRefs.current.get(track.id);
        if (!audio || overlayLocalTime(outputTime, track) == null) {
          return;
        }
        try {
          await audio.play();
        } catch {
          // Preview still works without this track.
        }
      }),
    );
  }

  function pausePlayback() {
    videoRef.current?.pause();
    audioRef.current?.pause();
    pauseOverlayAudio();
    setPlaying(false);
  }

  function stopAtRangeEnd() {
    stoppingAtEnd.current = true;
    pausePlayback();
    const pin = reverseActive ? trimStart : Math.max(trimStart, trimEnd - 0.001);
    const video = videoRef.current;
    if (video) {
      seekVideo(video, pin);
    }
    setCurrentTime(pin);
  }

  function resetEditor() {
    pausePlayback();
    stoppingAtEnd.current = false;
    usingProxy.current = false;
    playReverseWhenReady.current = false;
    setError(null);
    setVideoPath(null);
    setVideoUrl(null);
    setReversePreview(null);
    setSlideshowFolder(null);
    setSlideshowImages([]);
    setCurrentTime(0);
    setTrimStart(0);
    setTrimEnd(0);
    setDuration(0);
    setSpeed(1);
    setReplacementPath(null);
    setReplacementUrl(null);
    setOverlays([]);
    setBaseVolume(DEFAULT_VOLUME);
    setPreparingPreview(false);
  }

  function syncReplacementAudio(force = false, time = currentTime) {
    const audio = audioRef.current;
    if (!audio || audioMode !== "replace") {
      return;
    }
    const target = Math.min(previewOutputTime(time), audio.duration || Infinity);
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
      const url = await mediaUrl(proxyPath);
      if (generation !== loadGeneration.current) {
        return;
      }
      usingProxy.current = true;
      setVideoUrl(url);
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

  async function makeReversePreview(path: string) {
    const generation = loadGeneration.current;
    setPreparingPreview(true);
    setPreviewPercent(0);
    setError(null);
    try {
      const file = await invoke<string>("prepare_reverse_preview", {
        path,
        trimStart,
        trimEnd,
        hasSourceAudio,
      });
      const url = await mediaUrl(file);
      if (generation === loadGeneration.current) {
        playReverseWhenReady.current = true;
        if (currentTime <= trimStart + 0.01) {
          setCurrentTime(trimEnd);
        }
        setReversePreview({ url, start: trimStart, end: trimEnd });
      }
    } catch (cause) {
      const message = typeof cause === "string" ? cause : "Could not prepare a reverse preview.";
      if (generation === loadGeneration.current && message !== "Preview cancelled.") {
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
      if (!info.previewable) {
        await makePreview(path, info.duration, generation);
        return;
      }
      const url = await mediaUrl(path);
      if (generation === loadGeneration.current) {
        setVideoUrl(url);
      }
    } catch (cause) {
      if (generation === loadGeneration.current) {
        setError(typeof cause === "string" ? cause : "Could not open this video.");
      }
    }
  }

  async function loadSlideshow(folder: string, images: string[]) {
    const generation = ++loadGeneration.current;
    resetEditor();
    setSlideshowFolder(folder);
    setSlideshowImages(images);
    setHoldSeconds(5);
    setTransition("cut");
    setFadeSeconds(DEFAULT_FADE_SECONDS);
    setAudioMode("remove");
    setHasSourceAudio(false);
    const length = slideshowDuration(images.length, 5, "cut", DEFAULT_FADE_SECONDS);
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
    try {
      const url = await mediaUrl(selected);
      setError(null);
      setReplacementPath(selected);
      setReplacementUrl(url);
      setAudioMode("replace");
      if (videoRef.current) {
        videoRef.current.muted = true;
      }
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "Could not open this audio file.");
    }
  }

  async function addOverlayTrack() {
    if (overlays.length >= MAX_AUDIO_OVERLAYS) {
      setError(`Use ${MAX_AUDIO_OVERLAYS} or fewer extra audio tracks.`);
      return;
    }
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
    try {
      const [info, url] = await Promise.all([
        invoke<MediaInfo>("probe_audio", { path: selected }),
        mediaUrl(selected),
      ]);
      const durationSecs = info.duration && Number.isFinite(info.duration) ? info.duration : null;
      setError(null);
      setOverlays((current) => [
        ...current,
        {
          id: newOverlayId(),
          path: selected,
          url,
          duration: durationSecs,
          startSeconds: 0,
          fadeIn: 0,
          fadeOut: 0,
          volume: DEFAULT_VOLUME,
        },
      ]);
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "Could not open this audio file.");
    }
  }

  function updateOverlay(id: string, patch: Partial<OverlayTrack>) {
    setOverlays((current) =>
      current.map((track) => {
        if (track.id !== id) {
          return track;
        }
        const next = { ...track, ...patch };
        next.startSeconds = roundStart(next.startSeconds, Math.max(0, outDuration - 0.1));
        next.fadeIn = clampTrackFade(next.fadeIn);
        next.fadeOut = clampTrackFade(next.fadeOut);
        next.volume = roundVolume(next.volume);
        return next;
      }),
    );
  }

  function removeOverlay(id: string) {
    overlayAudioRefs.current.get(id)?.pause();
    overlayAudioRefs.current.delete(id);
    setOverlays((current) => current.filter((track) => track.id !== id));
  }

  function serializedOverlays() {
    return overlays.map((track) => ({
      path: track.path,
      startSeconds: track.startSeconds,
      fadeIn: track.fadeIn,
      fadeOut: track.fadeOut,
      duration: track.duration,
      volume: track.volume,
    }));
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
    if (jobsBusy || (!isSlideshow && speed === 0)) {
      return;
    }
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
      await playOverlays(startAt);
      setPlaying(true);
      return;
    }

    const video = videoRef.current;
    if (duration <= 0) {
      return;
    }
    if (video && !video.paused) {
      pausePlayback();
      return;
    }
    if (speed < 0 && !reverseActive && videoPath) {
      await makeReversePreview(videoPath);
      return;
    }
    if (!video || video.readyState < HTMLMediaElement.HAVE_METADATA) {
      return;
    }

    stoppingAtEnd.current = false;
    let time = sourceTimeOf(video.currentTime);
    if (time < trimStart || time > trimEnd || (reverseActive
      ? time <= trimStart + 0.01
      : time >= trimEnd - 0.01)) {
      time = reverseActive ? trimEnd : trimStart;
      seekVideo(video, time);
      setCurrentTime(time);
    }

    video.playbackRate = Math.abs(speed);
    video.muted = audioMode !== "keep";
    const outputTime = previewOutputTime(time);
    try {
      const startVideo = video.play();
      if (audioMode === "replace" && audioRef.current) {
        const audio = audioRef.current;
        audio.currentTime = Math.min(outputTime, audio.duration || Infinity);
        void audio.play().catch(() => {
          // The video can still play if the audio is unavailable.
        });
      }
      await Promise.all([startVideo, playOverlays(outputTime)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not play this file.");
      pausePlayback();
    }
  }

  function seekTo(time: number) {
    stoppingAtEnd.current = false;
    if (isSlideshow) {
      const clamped = Math.min(Math.max(time, 0), Math.max(0, slideshowLength - 0.01));
      setCurrentTime(clamped);
      slideshowClock.current = { origin: performance.now(), from: clamped };
      if (audioRef.current && audioMode === "replace") {
        audioRef.current.currentTime = clamped;
      }
      syncOverlays(clamped, true);
      return;
    }
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const clamped = Math.min(Math.max(time, trimStart), trimEnd);
    seekVideo(video, clamped);
    setCurrentTime(clamped);
    syncReplacementAudio(true, clamped);
    syncOverlays(previewOutputTime(clamped), true);
  }

  function changeSpeed(next: number) {
    const value = roundSpeed(next);
    if (value === speed) {
      return;
    }
    if (value === 0 || Math.sign(value) !== Math.sign(speed)) {
      playReverseWhenReady.current = false;
      pausePlayback();
      stoppingAtEnd.current = false;
    }
    setSpeed(value);
  }

  function changeFade(next: number) {
    setFadeSeconds(clampFade(next, holdSeconds, transition));
  }

  function updateTrimStart(time: number) {
    const next = Math.min(Math.max(0, time), trimEnd - MIN_CLIP_SECONDS);
    setTrimStart(next);
    stoppingAtEnd.current = false;
    if (reverseActive) {
      pausePlayback();
    } else if (videoRef.current) {
      seekVideo(videoRef.current, next);
    }
    setCurrentTime(next);
  }

  function updateTrimEnd(time: number) {
    const next = Math.max(Math.min(duration, time), trimStart + MIN_CLIP_SECONDS);
    setTrimEnd(next);
    stoppingAtEnd.current = false;
    if (reverseActive) {
      pausePlayback();
    } else if (videoRef.current) {
      seekVideo(videoRef.current, next);
    }
    setCurrentTime(next);
  }

  async function saveAs() {
    if (jobsBusy || (!isSlideshow && speed === 0)) {
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
            fadeSeconds,
            audioMode,
            replacementAudioPath: replacementPath,
            overlays: serializedOverlays(),
            baseVolume,
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
          overlays: serializedOverlays(),
          baseVolume,
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
  }

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.playbackRate = Math.abs(speed) || 1;
      video.muted = audioMode !== "keep";
      video.volume = audioMode === "keep" ? volumeGain(baseVolume) : 1;
    }
    if (audioRef.current) {
      audioRef.current.volume = volumeGain(baseVolume);
    }
  }, [speed, audioMode, previewUrl, baseVolume]);

  useEffect(() => {
    if (!isSlideshow) {
      return;
    }
    const length = slideshowDuration(slideshowImages.length, holdSeconds, transition, fadeSeconds);
    setDuration(length);
    setTrimStart(0);
    setTrimEnd(length);
    setCurrentTime((time) => Math.min(time, Math.max(0, length - 0.01)));
  }, [isSlideshow, slideshowImages.length, holdSeconds, transition, fadeSeconds]);

  useEffect(() => {
    setFadeSeconds((current) => clampFade(current, holdSeconds, transition));
  }, [holdSeconds, transition]);

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
        pauseOverlayAudio();
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
      syncOverlays(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isSlideshow, playing, slideshowLength, audioMode, overlays, outDuration]);

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
            if (path && !mediaJobActive.current) {
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
          <button type="button" disabled={jobsBusy} onClick={() => void openVideoDialog()}>
            Open video…
          </button>
          <button type="button" disabled={jobsBusy} onClick={() => void openPhotoFolderDialog()}>
            Open photos…
          </button>
          <button
            type="button"
            className="primary"
            disabled={!hasProject || jobsBusy || (!isSlideshow && speed === 0)}
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
                fadeSeconds={fadeSeconds}
                currentTime={currentTime}
              />
            ) : previewUrl ? (
              <video
                key={previewUrl}
                ref={videoRef}
                src={previewUrl}
                playsInline
                preload="auto"
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  const clip = video.duration;
                  const fullSource = !usingProxy.current && trimStart === 0 && trimEnd === duration;
                  if (!reverseActive && Number.isFinite(clip) && (duration <= 0 || fullSource)) {
                    setDuration(clip);
                    setTrimEnd(clip);
                  }
                  seekVideo(video, currentTime);
                }}
                onLoadedData={(event) => {
                  if (event.currentTarget.videoWidth === 0 && videoPath
                    && !reverseActive && !usingProxy.current && !jobsBusy) {
                    void makePreview(videoPath, duration || null, loadGeneration.current);
                  }
                }}
                onCanPlay={() => {
                  if (reverseActive && playReverseWhenReady.current) {
                    playReverseWhenReady.current = false;
                    void togglePlay();
                  }
                }}
                onTimeUpdate={(event) => {
                  if (stoppingAtEnd.current) {
                    return;
                  }
                  const time = sourceTimeOf(event.currentTarget.currentTime);
                  if (!event.currentTarget.paused
                    && (reverseActive ? time <= trimStart : time >= trimEnd)) {
                    stopAtRangeEnd();
                    return;
                  }
                  setCurrentTime(Math.min(trimEnd, Math.max(trimStart, time)));
                  if (speed !== 0) {
                    syncReplacementAudio(false, time);
                    syncOverlays(previewOutputTime(time));
                  }
                }}
                onEnded={stopAtRangeEnd}
                onPlay={() => setPlaying(true)}
                onPause={() => {
                  audioRef.current?.pause();
                  pauseOverlayAudio();
                  setPlaying(false);
                }}
                onError={() => {
                  if (videoPath && !reverseActive && !usingProxy.current && !jobsBusy) {
                    void makePreview(videoPath, duration || null, loadGeneration.current);
                  } else {
                    setError("This video could not be previewed.");
                  }
                }}
              />
            ) : null}
            <audio
              ref={audioRef}
              className="hidden-audio"
              src={replacementUrl ?? undefined}
              preload="auto"
            />
            {overlays.map((track) => (
              <audio
                key={track.id}
                className="hidden-audio"
                src={track.url}
                preload="auto"
                ref={(element) => {
                  if (element) {
                    overlayAudioRefs.current.set(track.id, element);
                  } else {
                    overlayAudioRefs.current.delete(track.id);
                  }
                }}
              />
            ))}
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
            <div className="transport">
              <button
                type="button"
                disabled={(!previewUrl && !isSlideshow) || jobsBusy}
                onClick={() => seekTo(isSlideshow ? 0 : speed < 0 ? trimEnd : trimStart)}
              >
                Start
              </button>
              <button
                type="button"
                className="play"
                disabled={jobsBusy || (!isSlideshow && (speed === 0 || (!previewUrl && speed > 0)))}
                onClick={() => void togglePlay()}
              >
                {playing ? "Pause" : "Play"}
              </button>
            </div>
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
                <button
                  type="button"
                  aria-label="Decrease speed"
                  disabled={jobsBusy || speed <= MIN_SPEED}
                  onClick={() => changeSpeed(speed - SPEED_STEP)}
                >
                  −
                </button>
                <strong>{speed.toFixed(1)}x</strong>
                <button
                  type="button"
                  aria-label="Increase speed"
                  disabled={jobsBusy || speed >= MAX_SPEED}
                  onClick={() => changeSpeed(speed + SPEED_STEP)}
                >
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
              {transition === "cut" ? (
                <span className="muted">Applies to every photo</span>
              ) : (
                <div className="stepper">
                  <span>Length</span>
                  <button
                    type="button"
                    disabled={fadeSeconds <= FADE_MIN}
                    onClick={() => changeFade(fadeSeconds - FADE_STEP)}
                  >
                    −
                  </button>
                  <strong>{formatFade(fadeSeconds)}</strong>
                  <button
                    type="button"
                    disabled={fadeSeconds >= maxFadeSeconds(holdSeconds, transition)}
                    onClick={() => changeFade(fadeSeconds + FADE_STEP)}
                  >
                    +
                  </button>
                </div>
              )}
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

          <AudioOverlays
            tracks={overlays}
            outputDuration={outDuration}
            existingVolume={baseVolume}
            hasExisting={audioMode === "replace" || (audioMode === "keep" && hasSourceAudio)}
            disabled={exporting || preparingPreview}
            onAdd={() => void addOverlayTrack()}
            onExistingVolume={setBaseVolume}
            onChange={updateOverlay}
            onRemove={removeOverlay}
          />
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
            <p className="muted">Creating a lightweight copy for playback.</p>
            <div className="progress">
              <div className="progress-bar" style={{ width: `${previewPercent}%` }} />
            </div>
            <p>{previewPercent}%</p>
            <button
              type="button"
              onClick={() => void invoke("cancel_export")}
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
