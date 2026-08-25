# 📹 CCTV — local camera recording and playback

Round-the-clock recording, live view and seekable archive for IP cameras —
entirely inside the home network, with no vendor cloud involved.

## ✨ Features

- **24/7 recording** of every configured camera into one-minute fragments, with
  no re-encoding — a Pi 3B stays essentially idle while doing it.
- **Live view** in the browser at roughly one second of delay, built on
  `MediaSource` rather than HLS (which would cost ten seconds or more).
- **Seekable archive**: one playlist per requested range, so the browser plays a
  whole day as a single continuous video and file boundaries are not felt.
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

- `/cctv` — live view of every camera.
- `/cctv/archive` — day picker, timeline with recorded stretches and motion
  marks, seeking, clip download.
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

## 🔧 Known gaps

Found by the final review, deliberately left for a follow-up — none of them
break recording or playback:

1. **Every download logs a few "possible EventEmitter memory leak" warnings.**
   The route opens one pipeline per fragment and their listeners pile up on the
   response. Noise in the journal only; no leak between requests. One-line fix:
   a single pipeline over an async generator.
2. **A viewer whose socket is already backed up never gets the stream header.**
   The backpressure threshold is applied to the header too, so subscribing to a
   second camera while the first is stalled yields a picture that cannot decode.
   The header is ~1 KB and should bypass the threshold.
3. **Recordings made during a backward clock step are lost from the index** and
   then leak on disk, since retention only ever deletes what the index knows.
   NTP normally steps forward, so this is unlikely here.
4. **A user cancelling a download is logged as an anomaly.** Cosmetic.

Also unverified, because it needs a browser: live-view latency in practice,
archive scrubbing, and clip download. And the live view does not reconnect on
its own after a WebSocket drop — a Wi-Fi blip means reloading the page.

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
