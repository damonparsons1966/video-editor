import { useEffect, useRef } from "react";
import { formatClock, MIN_CLIP_SECONDS } from "./media";

type DragKind = "in" | "out" | "seek" | null;

type TimelineProps = {
  duration: number;
  currentTime: number;
  trimStart: number;
  trimEnd: number;
  onTrimStart: (time: number) => void;
  onTrimEnd: (time: number) => void;
  onSeek: (time: number) => void;
};

export default function Timeline({
  duration,
  currentTime,
  trimStart,
  trimEnd,
  onTrimStart,
  onTrimEnd,
  onSeek,
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragKind>(null);

  function timeFromClientX(clientX: number): number {
    const track = trackRef.current;
    if (!track || duration <= 0) {
      return 0;
    }
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * duration;
  }

  function applyDrag(clientX: number) {
    const time = timeFromClientX(clientX);
    const kind = dragRef.current;
    if (kind === "in") {
      onTrimStart(Math.min(time, trimEnd - MIN_CLIP_SECONDS));
    } else if (kind === "out") {
      onTrimEnd(Math.max(time, trimStart + MIN_CLIP_SECONDS));
    } else if (kind === "seek") {
      onSeek(Math.min(Math.max(time, trimStart), trimEnd));
    }
  }

  useEffect(() => {
    function onMove(event: PointerEvent) {
      if (!dragRef.current) {
        return;
      }
      applyDrag(event.clientX);
    }

    function onUp() {
      dragRef.current = null;
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  });

  const width = duration > 0 ? 100 : 0;
  const inPct = duration > 0 ? (trimStart / duration) * 100 : 0;
  const outPct = duration > 0 ? (trimEnd / duration) * 100 : 100;
  const playPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="timeline">
      <div className="timeline-times">
        <span>In {formatClock(trimStart)}</span>
        <span>Out {formatClock(trimEnd)}</span>
      </div>
      <div
        ref={trackRef}
        className="timeline-track"
        onPointerDown={(event) => {
          dragRef.current = "seek";
          applyDrag(event.clientX);
        }}
      >
        <div className="timeline-full" style={{ width: `${width}%` }} />
        <div
          className="timeline-range"
          style={{ left: `${inPct}%`, width: `${Math.max(0, outPct - inPct)}%` }}
        />
        <div className="timeline-playhead" style={{ left: `${playPct}%` }} />
        <button
          type="button"
          className="timeline-handle start"
          style={{ left: `${inPct}%` }}
          aria-label="Trim start"
          onPointerDown={(event) => {
            event.stopPropagation();
            dragRef.current = "in";
            applyDrag(event.clientX);
          }}
        />
        <button
          type="button"
          className="timeline-handle end"
          style={{ left: `${outPct}%` }}
          aria-label="Trim end"
          onPointerDown={(event) => {
            event.stopPropagation();
            dragRef.current = "out";
            applyDrag(event.clientX);
          }}
        />
      </div>
    </div>
  );
}
