import { convertFileSrc } from "@tauri-apps/api/core";
import { slideshowFrame, type SlideTransition } from "./slideshow";

type SlideshowPreviewProps = {
  images: string[];
  holdSeconds: number;
  transition: SlideTransition;
  fadeSeconds: number;
  currentTime: number;
};

export default function SlideshowPreview({
  images,
  holdSeconds,
  transition,
  fadeSeconds,
  currentTime,
}: SlideshowPreviewProps) {
  const frame = slideshowFrame(
    currentTime,
    images.length,
    holdSeconds,
    transition,
    fadeSeconds,
  );
  const urlA = images[frame.a] ? convertFileSrc(images[frame.a]) : "";
  const urlB = images[frame.b] ? convertFileSrc(images[frame.b]) : urlA;
  const showBlend = frame.mix > 0.001 && frame.a !== frame.b;

  return (
    <div className="slideshow-stage">
      {urlA ? (
        <img
          src={urlA}
          alt=""
          className="slideshow-image"
          style={{ opacity: showBlend ? 1 - frame.mix : frame.opacity }}
        />
      ) : null}
      {showBlend && urlB ? (
        <img
          src={urlB}
          alt=""
          className="slideshow-image"
          style={{ opacity: frame.mix }}
        />
      ) : null}
    </div>
  );
}
