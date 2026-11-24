# Video Editor

A lightweight Ubuntu desktop editor built with Tauri 2, React, and FFmpeg.

- Open or drag in an MP4, MOV, or WebM video and trim the start and end.
- Set playback and export speed from −2.0× to +2.0× in 0.1× steps. Negative speeds play the trim range backwards. At 0.0× the preview is paused and Save As is disabled.
- Keep, remove, or replace the original audio. Add up to eight audio overlays with independent start times, fades, and volume.
- Build a 1080p slideshow from a photo folder with cuts, fades, or crossfades.
- Save a new H.264/AAC MP4 while preserving the source video.

The first time you press **Play** at a negative speed, the editor generates a lower-resolution reverse preview for the selected trim range. It reuses the preview while the range stays the same. Kept source audio reverses with the video. Replacement audio and overlays play forward. Reverse exports use the original video at 30 frames per second. They process short segments to limit memory use and need temporary disk space next to the output.

## Install on Ubuntu

For a package built on this Ubuntu release and CPU architecture, run the following from the package’s folder and substitute the actual filename.

```bash
sudo apt install './Video Editor_0.1.0_amd64.deb'
```

Launch **Video Editor** from the applications menu. The package uses Ubuntu’s FFmpeg and installs the required playback dependencies through APT.

## Build from source

Use Node.js 22.12 or later with npm. Install stable Rust and Cargo with [rustup](https://rust-lang.org/install/) if `cargo --version` fails. After installing Rust, open a new terminal or run `source "$HOME/.cargo/env"` in your current terminal.

From the project folder, install Ubuntu's native build and playback dependencies and the project's Node dependencies.

```bash
sudo apt update
sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev ffmpeg gstreamer1.0-libav gstreamer1.0-plugins-good
npm ci
```

Run the application in development mode.

```bash
npm run tauri dev
```

Build the Debian package for the current architecture.

```bash
npm run tauri build
```

The installer is written to `src-tauri/target/release/bundle/deb/`. Build on the oldest Ubuntu release you intend to support.

The last Windows version is preserved in Git at commit `d787975`.
