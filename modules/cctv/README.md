# 📹 CCTV — local camera recording and playback

Round-the-clock recording, live view and seekable archive for IP cameras —
entirely inside the home network, with no vendor cloud involved.

## ✨ Features

- **24/7 recording** of every configured camera into one-minute fragments, with
  no re-encoding — a Pi 3B stays essentially idle while doing it.
- **Live view** in the browser at roughly one second of delay, built on
  `MediaSource` rather than HLS (which would cost ten seconds or more). Cameras
  are shown one at a time — iOS plays only one video at once, so a second frame
  would just stay black; it also leaves one live process on the Pi instead of N.
- **Seekable archive**: jump by clicking the timeline, by the ±10s / ±1min
  buttons, or by typing a time. Every jump reloads the playlist from that
  moment (see Caveats for why), and playback resumes on its own.
- **Gaps stay gaps.** A Wi-Fi drop or a router reboot shows up as an empty
  stretch on the timeline, never as time silently skipped.
- **Self-healing.** Every recorder process is supervised and restarted with a
  growing backoff; a killed process is back within seconds.
- **Quota-based retention.** The archive is trimmed by its own byte budget, not
  by free disk space — other things live on that disk.
- **Clip download** — pick a moment, get an MP4 you can send to someone.
- **Optional motion marks** on the timeline, if the cameras emit ONVIF motion
  events (see Caveats).

## 🗺️ How it works

```
camera ──RTSP──> ffmpeg ──> one-minute .m4s fragments on the storage mount
                              │
                              ├── ffmpeg's own live.m3u8  ──> scanner ──> SQLite index
                              │                                              │
browser <──HLS── playlist built from the index <──────────────────────────────┘
browser <──WebSocket── a second, on-demand ffmpeg (live view only)
```

Recording and live view are separate connections to the camera: opening the live
page never disturbs what is being recorded.

## 🧩 Compatibility

Developed against `macro-video-soft` dual-lens cameras (sold as V380 Pro),
firmware 2.4, but nothing is model-specific: any camera that serves H.264 over
RTSP should work. See [CLAUDE.md](CLAUDE.md) for the hardware findings — several
of them are the kind you only learn by measuring.

**Dual-lens cameras** deliver both lenses glued into a single frame (1920×2160
here). The module stores and shows that frame as-is; it does not split it.

## 📦 Requirements on the Pi

Two things this module needs that nothing else in the project does:

1. **An external `ffmpeg`** — `sudo apt install ffmpeg`. All video passes through
   it; Node alone cannot handle these streams.
2. **A storage mount** for the video, separate from anything else on that disk.

`deploy.sh` checks for `ffmpeg` before restarting the service and fails with a
clear message if it is missing.

## ⚙️ Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `CCTV_CAMERAS` | — | `id=host,id=host`; empty disables the module |
| `CCTV_ENABLED` | `true` | master switch |
| `CCTV_STORAGE_DIR` | `/mnt/cctv` | where fragments are written |
| `CCTV_QUOTA_GB` | `500` | archive budget; oldest fragments are evicted |
| `CCTV_SEGMENT_SEC` | `60` | fragment length |
| `CCTV_FFMPEG` | `ffmpeg` | path to the binary |
| `CCTV_LIVE_IDLE_SEC` | `15` | how long a live process outlives its last viewer |
| `CCTV_MOTION_EVENTS` | `true` | subscribe to ONVIF motion events |
| `CCTV_DOWNLOAD_MAX_MIN` | `30` | largest downloadable interval |

Give the cameras fixed addresses on the router: if an address changes, recording
stops until the config is updated.

## 🖥️ Web interface

- `/cctv` — live view, one camera at a time with tabs to switch.
- `/cctv/archive` — camera and day pickers, a time field to jump straight to a
  moment, the player with its own controls (±1min / ±10s / play, and a clock
  showing the real time of the frame), a timeline with recorded stretches and
  motion marks, and clip download.
- A status card on the home overview: cameras recording, space used, archive
  depth.

Both pages are open to `admin` and `viewer` alike.

## 🌐 API

All under `/api/cctv`, behind the host's usual session or Bearer auth.

| Method | Path | Purpose |
|---|---|---|
| GET | `/cameras` | cameras, recording state, last segment |
| GET | `/timeline?cam&from&to` | recorded stretches, gaps, motion marks |
| GET | `/playlist.m3u8?cam&from&to` | playlist for the player |
| GET | `/segment/:id`, `/init/:id` | fragment delivery (`Range`, immutable) |
| GET | `/download?cam&from&to` | interval as a single MP4 |
| GET | `/storage` | used, quota, archive depth |
| WS | `/ws/cctv` | live view: `{type:"subscribe",cam}` |

Fragment paths come from the index by numeric id — nothing from the request ever
reaches the filesystem.

## 🧪 What's been verified

On a live Pi 3B with two cameras: recording runs for both, the index fills, a
killed recorder process restarts on its own and the new run gets its own stream
header, memory has headroom, and byte-concatenated fragments open in a real
player. Roughly 15 GB per day for two cameras at night, so a 500 GB budget holds
about a month.

In a real browser (iPhone, Safari): live view plays, cameras switch, the archive
plays and keeps playing after a jump, the timeline and the time field both move
playback, and the clock shows the recording's own time.

## ⚠️ Caveats

- **Motion marks are unconfirmed.** The cameras advertise the event type and the
  subscription mechanism works, but no motion event has ever arrived — possibly
  detection is off in the vendor app, possibly they only report to their cloud.
  The feature is optional by design: without events the timeline simply has none.
- **Downloaded clips report a wrong duration.** Timestamps run from the start of
  the recording, so a clip taken from the middle shows a longer duration than it
  has. It plays correctly; only the scrubber length is off.
- **Seeking is accurate to about three seconds** — the cameras' keyframe
  interval, not something this module can improve.
- **One camera on screen at a time.** iOS refuses to play a second video at
  once, so the live page switches cameras with tabs rather than showing a grid.
- **Seeking is a reload, not a scrub.** Moving the position inside a long
  playlist stops playback on these recordings for good — it cannot be resumed,
  not even with the play button. Every jump therefore loads a fresh playlist
  starting at the wanted moment, and the player is rebuilt from scratch. That is
  also why the `<video>` element carries no native controls: its slider seeks
  the broken way. The recordings themselves are fine — the same content plays
  end to end when served as one file.
- **Live view needs iOS 17.1 or newer on an iPhone.** Apple ships no plain
  `MediaSource` there, only `ManagedMediaSource`; on anything older the page
  says so instead of failing.

## 🔧 Known gaps

Found by the final review, deliberately left for a follow-up — none of them
break recording or playback:

1. **Every download logs a few "possible EventEmitter memory leak" warnings.**
   The route opens one pipeline per fragment and their listeners pile up on the
   response. Noise in the journal only; no leak between requests. One-line fix:
   a single pipeline over an async generator.
2. **A viewer whose socket is already backed up never gets the stream header.**
   The backpressure threshold is applied to the header too, so a stalled socket
   yields a picture that cannot decode. The header is ~1 KB and should bypass
   the threshold. Less likely now that only one camera streams at a time, but
   still there.
3. **Recordings made during a backward clock step are lost from the index** and
   then leak on disk, since retention only ever deletes what the index knows.
   NTP normally steps forward, so this is unlikely here.
4. **A user cancelling a download is logged as an anomaly.** Cosmetic.

The live view still does not reconnect on its own after a WebSocket drop — a
Wi-Fi blip means reloading the page. Clip download has not been exercised from
the UI yet, though the concatenation it relies on is verified.

## 🗂️ Structure

```
src/
  config.ts            cameras and paths from env
  index/               SQLite index: schema, scanner, spans, retention
  recorder/            ffmpeg arguments, supervised process, manager
  live/                on-demand live sessions and their subscribers
  events/onvif.ts      optional motion-event subscription
  playlist.ts          playlist generation from the index
  router.ts            REST API
  module.ts            assembly into the host's module contract
```

Design: [`docs/superpowers/specs/2026-08-24-cctv-design.md`](../../docs/superpowers/specs/2026-08-24-cctv-design.md).
Hardware findings and review lessons: [CLAUDE.md](CLAUDE.md).
