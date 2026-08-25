# modules/cctv — CLAUDE.md

This file provides guidance to Claude Code for the `@sweethome/cctv` module. Root-level
workflow (commands, deploy, git) lives in the repository's top-level `CLAUDE.md`; this file
covers only what is expensive to re-derive: the camera hardware findings and the lessons
from review. The full design — decisions, API, failure modes, acceptance criteria — is
`docs/superpowers/specs/2026-08-24-cctv-design.md` (§2 in particular); this is its condensed
form for day-to-day work on the module.

## Cameras — measured, not assumed (spec §2.1)

Everything below was measured on the actual hardware on 2026-08-24; do not "correct" it from
general RTSP/ONVIF knowledge without re-measuring.

| | |
|---|---|
| Identifies as | ONVIF `macro-video-soft IPCamera`, firmware `2.4` |
| Stream | `rtsp://<ip>:554/live/ch00_0`, **no auth**. The camera answers on almost any path except `live/ch00_1`; we rely on `ch00_0` |
| Resolution | **1920×2160** — two lenses stitched by the camera into one frame (top/bottom). **One stream per camera, not two.** Shown as-is, not cropped (user decision) |
| Codec | H.264 Main profile (`profile-level-id=TQAy` → `avc1.4d0032`), switched from the factory H.265 via the V380 Pro app |
| Frame rate / keyframes | ~14 fps, keyframe (IDR) roughly every **2.9 s** |
| Bitrate | 680–870 kbit/s video + ~16 kbit/s AAC 8 kHz audio; camera-side cap is 2048 kbit/s |
| Economy stream | `live/ch00_1`, 640×720 ~730 kbit/s — not worth using after the H.264 switch (out of scope, spec §19) |

### The packaging trap — why the module only ever uses ffmpeg

The camera glues `SPS + PPS + IDR` into a single NAL unit and fragments it under a NAL
header of **type 7 (SPS) instead of 5 (IDR)**. A strict decoder never recognizes the start of
a keyframe and shows grey garbage instead of a picture — verified with `gstreamer` +
`rtph264depay`. **`ffmpeg` parses this correctly**; recording and frame extraction both come
out clean. Consequence: the entire receive/parse path for camera video in this module goes
through ffmpeg only — recording (`recorder/`), live view (`live/`) and archive concat
(the download route in `router.ts`, using `concatArgs` from `download.ts`) all spawn
ffmpeg rather than talking RTP/RTSP directly. Moving to `gstreamer`
or a hand-rolled RTP parser would need its own investigation; do not assume it is a drop-in
swap.

### ONVIF — read-only, and that is final

Port `8899`; services `device`/`media`/`imaging`/`events`/`ptz`. Recon probed the read side of
this surface — `GetCapabilities`, `GetProfiles`, `GetVideoEncoderConfiguration`,
`GetEventProperties` — and all of it answers without auth, but **the module itself calls none
of these**. `events/onvif.ts` (the motion watcher) only ever calls
`CreatePullPointSubscription` and `PullMessages`; the `tns1:VideoSource/MotionAlarm` topic it
watches for is hard-coded from what `GetEventProperties` showed during recon, not re-queried
at runtime.

**Writing configuration does not work at all.** `SetVideoEncoderConfiguration` returns
`ter:InvalidArgVal / ter:ConfigModify` even when asked to save the settings that are already
in effect — this was verified with a dedicated control test, not inferred. Codec/bitrate/fps
can only be changed from the V380 Pro app by a human. **Never add code that tries to
configure these cameras over ONVIF** — there is nothing on the other end that will accept it.
`GetSnapshotUri` times out — the camera does not hand out snapshots, so there is no shortcut
to a preview frame.

**Motion events are unconfirmed.** PullPoint subscriptions work mechanically
(`CreatePullPointSubscription` → `PullMessages` loop in `events/onvif.ts`), and the camera
does declare the `tns1:VideoSource/MotionAlarm` topic, but no such event was observed in five
minutes of watching a moving subject. `CCTV_MOTION_EVENTS` therefore gates this feature off
independently of everything else: recording, live view and archive playback do not depend on
it in any way, and a failed/empty subscription only means the timeline has no motion marks.

## On-disk layout, the index, and the background timers

Storage root is `CCTV_STORAGE_DIR` (default `/mnt/cctv`), one directory per camera id:

```
<storageDir>/<cam-id>/
  init_<runId>.mp4       one per ffmpeg run — see "why a new init per run" below
  seg_YYYYMMDD_HHMMSS.m4s
  live.m3u8               ffmpeg's own HLS playlist — the source the scanner reads
```

The index is SQLite (`node:sqlite`, same approach as the inverter's stats) at
`server/data/cctv/index.db`, tables `inits` / `segments` / `motion` (schema: spec §7). The
scanner (`index/scanner.ts`) tails each camera's `live.m3u8` for `EXT-X-PROGRAM-DATE-TIME` +
`EXTINF`, which is the only reliable source of segment start time and duration — durations
cannot be recovered from the filename. `rebuildCamera()` is the disaster-recovery path
(index lost or corrupted): it walks the directory and re-derives what it can, picking the
newest init whose run-time is not later than the segment (falls back to lexicographic order
if that time cannot be parsed) so a stream-parameter change never gets misattributed to the
wrong init.

`RecorderManager` (`recorder/manager.ts`) owns two background timers, both plain
`setTimeout` chains re-armed after each tick (so a slow tick cannot overlap the next one):

- **Scan**, every `SCAN_INTERVAL_MS` = 15 s — pulls new segments from each camera's playlist
  into the index. `ENOENT` (file not there yet) is swallowed as normal; any other error
  (`EIO`/`ENOTCONN`/`ESTALE` from the SMB mount dropping) is logged and surfaces through
  `health()` rather than being silently retried forever.
- **Retention**, every `RETENTION_INTERVAL_MS` = 600 s (10 min) — enforces `CCTV_QUOTA_GB`
  by deleting the oldest segments once usage crosses 98% of quota, down to 95% (so it does
  not hammer the disk every tick). Init files are removed only once no segment references
  them. A non-`ENOENT` delete failure is counted (`unlinkFailures`) and logged, but does not
  abort the run — one failure must not leave the rest of the eviction batch stuck with
  deleted index rows and orphaned files on disk (or vice versa).

Why a unique `init_<runId>.mp4` per ffmpeg run: if the camera's stream parameters change
(codec, resolution — the user has already done this once), a new run gets a new init and the
playlist emits `EXT-X-DISCONTINUITY`; old segments keep playing against their own init
instead of breaking.

## Live view

`live/session.ts` spawns one ffmpeg per camera on the first subscriber and kills it
`CCTV_LIVE_IDLE_SEC` (15 s) after the last one leaves; multiple viewers of the same camera
share one process. The command (`recorder/ffmpeg.ts::liveArgs`) fragments MP4 via
`-frag_duration` (500 ms by default in code) so latency does not end up tied to the ~2.9 s
keyframe interval. That value is the one place the design spec explicitly leaves open for
on-stand measurement (spec §8) — if it has since been re-tuned on the Pi, `ffmpeg.test.ts`
pins the current value; trust the test over this document.

## Lessons from review — easy to reintroduce if you write similar code

1. **Recheck the stop flag after every `await` in an async loop.** Deciding "should I still
   be running" only once, before the loop's first `await`, is not enough — `stop()` can land
   while you're waiting on something slow (this module's `storageReady()` hits an SMB mount
   over Wi-Fi and can hang for seconds). Both `RecorderProcess.start()` and
   `RecorderManager.start()` had this bug independently; both now check `if (this.stopped)
   return;` immediately after the `await`, not just before it. `live/hub.ts` has the sibling
   version of this bug: matching a just-killed session back to its map entry by camera id
   alone is wrong once a new session for that id may already have been created — check
   identity, not just the key.
2. **A spawned child process needs an `"error"` listener, always.** This is a monolith:
   an unhandled `"error"` on a `ChildProcess` (bad path to the ffmpeg binary, no permission —
   anything that fails before an `"exit"` would ever fire) is an uncaught exception that can
   take down the whole process, inverter monitoring included, not just this module. Every
   `spawn()` call in this module (`recorder/process.ts`, `live/session.ts`, the download
   route's concat spawn in `router.ts`, using `concatArgs` from `download.ts`) has an
   `"error"` handler that cleans up and reports failure instead of leaving the caller
   hanging or the process dead in the water.
3. **Playback errors must reach the user, not fade into the next frame.** A black rectangle
   with no explanation is a support ticket, not a UI. Both the live and the archive players
   surface stream/HLS failures as a visible status banner (with the reason where one is
   known — no ffmpeg, no signal, gap in the recording) rather than staying silent and letting
   the next frame quietly paper over it.
