# Video Editor

A lightweight Windows 10+ editor. Open an MP4, MOV, or WebM file, trim it, change speed, replace or remove audio, then Save As a new MP4. You can also build a 1080p slideshow from a folder of photos.

It is built as a small Tauri 2 desktop app so it can run on a typical 5–6 year old laptop. Chromium cannot preview HEVC (common on phones); the app builds a temporary H.264 preview for playback and still exports from the original file.

## Features

- Open or drag-and-drop MP4, MOV, WebM
- Playback with speed from 0.1x to 2.0x in 0.1 steps
- Trim start and end on a timeline
- Keep, remove, or replace the audio track
- Build a slideshow from a folder of photos (2–30 seconds each, cut / fade / crossfade, fade length 0–5s)
- Save As a new H.264/AAC MP4 (never overwrites the original)

## Prerequisites

- Windows 10 or later (WebView2 is included)
- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/tools/install) (MSVC toolchain)
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **Desktop development with C++** workload

## Setup

```powershell
npm install
powershell -ExecutionPolicy Bypass -File .\scripts\fetch-ffmpeg.ps1
```

The fetch script places `ffmpeg.exe` at `src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe`. That file is not in git (it is over GitHub’s 100 MB limit).

## Run

```powershell
npm run tauri dev
```

## Build an installer

```powershell
npm run tauri build
```

The NSIS installer is written under `src-tauri\target\release\bundle\nsis\`. After installing, launch **Video Editor** from the Start menu.
