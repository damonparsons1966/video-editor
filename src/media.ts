export const MIN_CLIP_SECONDS = 0.1;
export const MIN_SPEED = 0.1;
export const MAX_SPEED = 2.0;
export const SPEED_STEP = 0.1;

export const VIDEO_EXTENSIONS = ["mp4", "mov", "webm"] as const;
export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac"] as const;

export function extensionOf(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function fileNameOf(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

export function stemOf(path: string): string {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function isVideoPath(path: string): boolean {
  return (VIDEO_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

export function isAudioPath(path: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

export function roundSpeed(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, rounded));
}

export function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalTenths = Math.round(safe * 10);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  const sec = `${s.toString().padStart(2, "0")}.${tenths}`;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${sec}`;
  }
  return `${m.toString().padStart(2, "0")}:${sec}`;
}

export function outputDuration(
  trimStart: number,
  trimEnd: number,
  speed: number,
): number {
  return Math.max(0, (trimEnd - trimStart) / Math.max(speed, MIN_SPEED));
}
