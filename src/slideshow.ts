export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "bmp"] as const;
export const HOLD_SECONDS = [2, 5, 10, 20, 30] as const;
export type HoldSeconds = (typeof HOLD_SECONDS)[number];
export type SlideTransition = "cut" | "fade" | "crossfade";

export function isImagePath(path: string): boolean {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

export function fadeDuration(holdSeconds: number): number {
  return holdSeconds <= 2 ? 0.4 : 0.5;
}

export function slideshowDuration(
  count: number,
  holdSeconds: number,
  transition: SlideTransition,
): number {
  if (count <= 0) {
    return 0;
  }
  if (count === 1 || transition !== "crossfade") {
    return count * holdSeconds;
  }
  const fade = fadeDuration(holdSeconds);
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
): SlideshowFrame {
  if (count <= 0) {
    return { a: 0, b: 0, mix: 0, opacity: 1 };
  }
  const total = slideshowDuration(count, holdSeconds, transition);
  const t = Math.min(Math.max(0, time), Math.max(0, total - 0.001));
  const fade = fadeDuration(holdSeconds);

  if (count === 1 || transition === "cut") {
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
