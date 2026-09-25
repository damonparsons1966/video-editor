import { FADE_MAX, FADE_MIN, FADE_STEP, roundFade } from "./slideshow";

export const MAX_AUDIO_OVERLAYS = 8;
export const START_STEP = 0.1;
export const VOLUME_MIN = 5;
export const VOLUME_MAX = 100;
export const VOLUME_STEP = 5;
export const DEFAULT_VOLUME = 100;

export type OverlayTrack = {
  id: string;
  path: string;
  duration: number | null;
  startSeconds: number;
  fadeIn: number;
  fadeOut: number;
  volume: number;
};

export function roundVolume(value: number): number {
  const stepped = Math.round(value / VOLUME_STEP) * VOLUME_STEP;
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, stepped));
}

export function volumeGain(percent: number): number {
  return roundVolume(percent) / 100;
}

export function formatVolume(percent: number): string {
  return `${roundVolume(percent)}%`;
}

export function newOverlayId(): string {
  return `ov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function roundStart(value: number, maxSeconds: number): number {
  const stepped = Math.round(value / START_STEP) * START_STEP;
  const max = Math.max(0, maxSeconds);
  return Math.min(max, Math.max(0, stepped));
}

export function clampTrackFade(value: number): number {
  return Math.min(FADE_MAX, Math.max(FADE_MIN, roundFade(value)));
}

export function overlayLocalTime(outputTime: number, track: OverlayTrack): number | null {
  const local = outputTime - track.startSeconds;
  if (local < 0) {
    return null;
  }
  if (track.duration != null && local >= track.duration) {
    return null;
  }
  return local;
}

export function overlayVolume(outputTime: number, track: OverlayTrack, outputDuration: number): number {
  const local = overlayLocalTime(outputTime, track);
  if (local == null) {
    return 0;
  }
  const clipEnd =
    track.duration == null
      ? Math.max(0, outputDuration - track.startSeconds)
      : Math.min(track.duration, Math.max(0, outputDuration - track.startSeconds));
  if (clipEnd <= 0 || local >= clipEnd) {
    return 0;
  }

  let gain = 1;
  if (track.fadeIn > 0 && local < track.fadeIn) {
    gain = local / track.fadeIn;
  }
  if (track.fadeOut > 0 && local > clipEnd - track.fadeOut) {
    gain = Math.min(gain, Math.max(0, (clipEnd - local) / track.fadeOut));
  }
  return Math.min(1, Math.max(0, gain)) * volumeGain(track.volume);
}

export { FADE_MAX, FADE_MIN, FADE_STEP };
