import { fileNameOf, formatClock } from "./media";
import { formatFade } from "./slideshow";
import {
  FADE_MAX,
  FADE_MIN,
  FADE_STEP,
  MAX_AUDIO_OVERLAYS,
  START_STEP,
  VOLUME_MAX,
  VOLUME_MIN,
  VOLUME_STEP,
  clampTrackFade,
  formatVolume,
  roundVolume,
  type OverlayTrack,
} from "./audioTracks";

type AudioOverlaysProps = {
  tracks: OverlayTrack[];
  outputDuration: number;
  existingVolume: number;
  hasExisting: boolean;
  disabled?: boolean;
  onAdd: () => void;
  onExistingVolume: (value: number) => void;
  onChange: (id: string, patch: Partial<OverlayTrack>) => void;
  onRemove: (id: string) => void;
};

function VolumeStepper({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="stepper">
      <span>{label}</span>
      <button
        type="button"
        disabled={disabled || value <= VOLUME_MIN}
        onClick={() => onChange(roundVolume(value - VOLUME_STEP))}
      >
        −
      </button>
      <strong>{formatVolume(value)}</strong>
      <button
        type="button"
        disabled={disabled || value >= VOLUME_MAX}
        onClick={() => onChange(roundVolume(value + VOLUME_STEP))}
      >
        +
      </button>
    </div>
  );
}

export default function AudioOverlays({
  tracks,
  outputDuration,
  existingVolume,
  hasExisting,
  disabled = false,
  onAdd,
  onExistingVolume,
  onChange,
  onRemove,
}: AudioOverlaysProps) {
  const maxStart = Math.max(0, outputDuration - 0.1);

  return (
    <div className="overlay-block">
      <div className="audio-bar">
        <span>Extra tracks</span>
        <button
          type="button"
          disabled={disabled || tracks.length >= MAX_AUDIO_OVERLAYS}
          onClick={onAdd}
        >
          Add track…
        </button>
        {hasExisting && tracks.length > 0 ? (
          <VolumeStepper
            label="Existing volume"
            value={existingVolume}
            disabled={disabled}
            onChange={onExistingVolume}
          />
        ) : (
          <span className="muted">
            Layered on top of the original audio, so you can add a backing track and then a voice.
          </span>
        )}
      </div>
      {tracks.map((track) => (
        <div key={track.id} className="overlay-card">
          <div className="overlay-head">
            <span className="audio-name" title={track.path}>
              {fileNameOf(track.path)}
            </span>
            <button type="button" className="link" disabled={disabled} onClick={() => onRemove(track.id)}>
              Remove
            </button>
          </div>
          <div className="overlay-controls">
            <div className="stepper">
              <span>Start</span>
              <button
                type="button"
                disabled={disabled || track.startSeconds <= 0}
                onClick={() =>
                  onChange(track.id, { startSeconds: Math.max(0, track.startSeconds - START_STEP) })
                }
              >
                −
              </button>
              <strong>{formatClock(track.startSeconds)}</strong>
              <button
                type="button"
                disabled={disabled || track.startSeconds >= maxStart}
                onClick={() =>
                  onChange(track.id, {
                    startSeconds: Math.min(maxStart, track.startSeconds + START_STEP),
                  })
                }
              >
                +
              </button>
            </div>
            <div className="stepper">
              <span>Fade in</span>
              <button
                type="button"
                disabled={disabled || track.fadeIn <= FADE_MIN}
                onClick={() => onChange(track.id, { fadeIn: clampTrackFade(track.fadeIn - FADE_STEP) })}
              >
                −
              </button>
              <strong>{formatFade(track.fadeIn)}</strong>
              <button
                type="button"
                disabled={disabled || track.fadeIn >= FADE_MAX}
                onClick={() => onChange(track.id, { fadeIn: clampTrackFade(track.fadeIn + FADE_STEP) })}
              >
                +
              </button>
            </div>
            <VolumeStepper
              label="Volume"
              value={track.volume}
              disabled={disabled}
              onChange={(value) => onChange(track.id, { volume: value })}
            />
            <div className="stepper">
              <span>Fade out</span>
              <button
                type="button"
                disabled={disabled || track.fadeOut <= FADE_MIN}
                onClick={() => onChange(track.id, { fadeOut: clampTrackFade(track.fadeOut - FADE_STEP) })}
              >
                −
              </button>
              <strong>{formatFade(track.fadeOut)}</strong>
              <button
                type="button"
                disabled={disabled || track.fadeOut >= FADE_MAX}
                onClick={() => onChange(track.id, { fadeOut: clampTrackFade(track.fadeOut + FADE_STEP) })}
              >
                +
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
