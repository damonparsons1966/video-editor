export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "bmp"] as const;
export const HOLD_SECONDS = [2, 5, 10, 20, 30] as const;
export const FADE_MIN = 0;
export const FADE_MAX = 5;
export const FADE_STEP = 0.5;
export const DEFAULT_FADE_SECONDS = 1.5;
export type HoldSeconds = (typeof HOLD_SECONDS)[number];
export type SlideTransition = "cut" | "fade" | "crossfade";

export function isImagePath(path: string): boolean {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

export function roundFade(value: number): number {
  const stepped = Math.round(value / FADE_STEP) * FADE_STEP;
  return Math.min(FADE_MAX, Math.max(FADE_MIN, stepped));
}

export function maxFadeSeconds(holdSeconds: number, transition: SlideTransition): number {
  if (transition === "cut") {
    return FADE_MAX;
  }
  if (transition === "crossfade") {
    return roundFade(Math.max(0, holdSeconds - FADE_STEP));
  }
  return roundFade(holdSeconds);
}

export function clampFade(
  fadeSeconds: number,
  holdSeconds: number,
  transition: SlideTransition,
): number {
  return Math.min(roundFade(fadeSeconds), maxFadeSeconds(holdSeconds, transition));
}

export function formatFade(seconds: number): string {
  const value = roundFade(seconds);
  return value % 1 === 0 ? `${value.toFixed(0)}s` : `${value.toFixed(1)}s`;
}

export function effectiveFade(
  fadeSeconds: number,
  holdSeconds: number,
  transition: SlideTransition,
): number {
  if (transition === "cut") {
    return 0;
  }
  return clampFade(fadeSeconds, holdSeconds, transition);
}

export function slideshowDuration(
  count: number,
  holdSeconds: number,
  transition: SlideTransition,
  fadeSeconds: number = DEFAULT_FADE_SECONDS,
): number {
  if (count <= 0) {
    return 0;
  }
  if (count === 1 || transition !== "crossfade") {
    return count * holdSeconds;
  }
  const fade = effectiveFade(fadeSeconds, holdSeconds, transition);
  return count * holdSeconds - (count - 1) * fade;
}

export type SlideshowFrame = {
  a: number;
  b: number;
  mix: number;
  opacity: number;
};

export function slideshowFrame(
  time: number,
  count: number,
  holdSeconds: number,
  transition: SlideTransition,
  fadeSeconds: number = DEFAULT_FADE_SECONDS,
): SlideshowFrame {
  if (count <= 0) {
    return { a: 0, b: 0, mix: 0, opacity: 1 };
  }
  const fade = effectiveFade(fadeSeconds, holdSeconds, transition);
  const total = slideshowDuration(count, holdSeconds, transition, fadeSeconds);
  const t = Math.min(Math.max(0, time), Math.max(0, total - 0.001));

  if (count === 1 || transition === "cut" || fade < 0.05) {
    const a = Math.min(count - 1, Math.floor(t / holdSeconds));
    return { a, b: a, mix: 0, opacity: 1 };
  }

  if (transition === "fade") {
    const a = Math.min(count - 1, Math.floor(t / holdSeconds));
    const local = t - a * holdSeconds;
    let opacity = 1;
    if (local < fade) {
      opacity = local / fade;
    } else if (local > holdSeconds - fade) {
      opacity = Math.max(0, (holdSeconds - local) / fade);
    }
    return { a, b: a, mix: 0, opacity };
  }

  const step = Math.max(0.001, holdSeconds - fade);
  const lastStart = (count - 1) * step;
  if (t >= lastStart) {
    return { a: count - 1, b: count - 1, mix: 0, opacity: 1 };
  }
  const i = Math.floor(t / step);
  const local = t - i * step;
  if (i > 0 && local < fade) {
    return { a: i - 1, b: i, mix: local / fade, opacity: 1 };
  }
  return { a: i, b: i, mix: 0, opacity: 1 };
}
