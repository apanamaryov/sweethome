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
out clean. Consequence: everything that *receives* camera video in this module goes through
ffmpeg only — recording (`recorder/`) and live view (`live/`) both spawn it rather than
talking RTP/RTSP directly. Moving to `gstreamer` or a hand-rolled RTP parser would need its
own investigation; do not assume it is a drop-in swap.

**The archive download route is the exception, and deliberately so.** `/download` in
`router.ts` copies bytes: the init segment, then the `.m4s` files in order, straight into the
response. That is what fragmented MP4 is for, and it is the only correct way here — the
`concat` demuxer opens every file in its list *separately*, so an init segment yields no
packets and a `styp`+`moof`+`mdat` fragment has no streams at all; the "concatenation" it
produced was an empty file served with a 200. Byte copying also removes a process and a
temporary file from the Pi's hot path. Because the copy is byte-wise, an interval that
spans a recording restart (two different init segments) cannot be served at all — the route
answers 400 rather than handing out a file that will not open.

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
cannot be recovered from the filename. The scanner keeps a per-camera watermark (the start of the last indexed segment) and only
looks at playlist entries past it — the playlist is written with `-hls_list_size 0` and
`append_list`, so it holds the whole history, and retention removes the index row but not the
playlist line. `rebuildCamera()` is the disaster-recovery path
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
  them **and they are over an hour old** (`ORPHAN_INIT_MIN_AGE_MS`): the scanner writes the
  init row before it has confirmed the first segment, so without the age guard a retention
  tick landing in that window deletes the header of the *running* recording — after which
  none of that run's segments can ever enter the index. A non-`ENOENT` delete failure is
  counted (`unlinkFailures`) and logged, but does not
  abort the run — one failure must not leave the rest of the eviction batch stuck with
  deleted index rows and orphaned files on disk (or vice versa).

Why a unique `init_<runId>.mp4` per ffmpeg run: if the camera's stream parameters change
(codec, resolution — the user has already done this once), a new run gets a new init and the
playlist emits `EXT-X-DISCONTINUITY`; old segments keep playing against their own init
instead of breaking.

## Live view

`live/session.ts` spawns one ffmpeg per camera on the first subscriber and kills it
`CCTV_LIVE_IDLE_SEC` (15 s) after the last one leaves; multiple viewers of the same camera
share one process. **A viewer that cannot keep up is dropped frames, not buffered**
(`LIVE_MAX_BUFFERED_BYTES` in `module.ts`): `ws` queues unsent data in the heap without any
limit, and a phone that walked out of Wi-Fi holds the socket open for 10–15 minutes — tens of
megabytes per viewer against ~440 MB free on the Pi, with no memory limit in the unit. Spec
§8 says it outright: for a live picture, being current beats being continuous. The command (`recorder/ffmpeg.ts::liveArgs`) fragments MP4 via
`-frag_duration` (500 ms by default in code) so latency does not end up tied to the ~2.9 s
keyframe interval. That value is the one place the design spec explicitly leaves open for
on-stand measurement (spec §8) — if it has since been re-tuned on the Pi, `ffmpeg.test.ts`
pins the current value; trust the test over this document.

## Browser side — what the device taught us

Three things about playback were only learnable on a real iPhone, and all three are load-bearing.

**There is no plain `MediaSource` on iPhone.** Apple ships `ManagedMediaSource` instead, and
only since iOS 17.1. `new MediaSource()` threw straight out of the effect and took the whole
page down with a client-side exception. Both players now pick whichever implementation exists
(`pickMediaSource` in `LivePlayer.tsx`, `Hls.isSupported()` for the archive) and set
`video.disableRemotePlayback = true` — Apple will not open a ManagedMediaSource without it.

**iOS plays exactly one video at a time.** A grid of cameras leaves every frame but one black.
The live page therefore shows one camera with tabs to switch. Bonus: one live ffmpeg on the Pi
instead of one per camera.

**Seeking inside a playlist kills playback on these recordings — permanently.** Move the
position within a long playlist and the picture stops and never comes back, not by autoplay
and not by the play button; the very first start always worked, which is what gives it away.
Reproduced with ffmpeg on the Pi itself, so it is not a Safari quirk. The data is fine: the
same fragments play end to end when concatenated into one file, and a playlist that *starts*
at the wanted moment plays normally. So every jump — timeline click, ±10s/±1min button, time
field — reloads the playlist from that moment and rebuilds the player (a React `key` on the
component, so the `<video>` element itself is new). For the same reason the element carries
**no native controls**: its slider seeks the broken way, and leaving it there is handing the
user a button that breaks playback. The player's own clock shows the recording's real time,
because the player's scale restarts at zero after every jump.

Enlarging on click is a CSS overlay (`.cctv-expanded`), not the Fullscreen API, for the same
reason the native controls are gone — and because the element must not move in the DOM or the
stream dies. The archive's expanded state lives in the *page*, not in `ArchivePlayer`: every
seek remounts the player, so a flag kept inside it would collapse the picture on each jump.

Safari's built-in HLS player is not used even where it exists: it plays only the first
fragment of our playlists. `hls.js` assembles fragments itself and handles them, and on iPhone
it runs on ManagedMediaSource too.

## MCP — what agents get, and the two traps in it

`mcp/tools.ts` registers four read-only tools (`cctv_get_cameras`, `cctv_get_storage`,
`cctv_get_timeline`, `cctv_snapshot`) and the `cctv://cameras` resource into the home's shared
server; `mcp/provider.ts` is the thin `ModuleMcpProvider` wrapper the host picks up. Session
rights are deliberately ignored: everything here reads, and watching is allowed to `viewer`
exactly as it is on the pages (spec §13).

**`cctv_snapshot` is the reason ffmpeg is here at all.** The camera has no snapshot endpoint —
`GetSnapshotUri` times out (see ONVIF above) — so a frame costs a decode. Live grabs open a
second RTSP connection (the recorder keeps its own); archive grabs feed `init + segment`
into ffmpeg's **stdin**, byte-wise, exactly like `/download` does, and seek *after* `-i`
because input seeking does not work on a pipe. Two things about that pipe are load-bearing
and easy to "fix" back into bugs: ffmpeg closes stdin the moment it has its frame, so the
`EPIPE` that follows is normal and must not reject a result that already arrived; and a frame
already collected outweighs a non-zero exit code for the same reason.

**Frames are scaled down before they leave.** The full 1920×2160 picture is hundreds of
kilobytes, and base64 adds a third on top — every call would bloat the agent's context. The
default width is 640, the cap 1920 (`snapshot.ts`), and `grabFrame` kills the process rather
than buffering past `MAX_FRAME_BYTES`. Measured on the Pi against a real camera: a 640×720
frame (both lenses, fully legible) is ~90 KB at `-q:v 8`, ~120 KB at 6, ~150 KB at 4; a live
grab takes about 3.5 s end to end, an archive grab is faster. That is where the defaults come
from — re-measure before changing them.

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
2. **A spawned child process needs an `"error"` listener, always — and its `stderr` must be
   drained.** This is a monolith: an unhandled `"error"` on a `ChildProcess` (bad path to the
   ffmpeg binary, no permission — anything that fails before an `"exit"` would ever fire) is
   an uncaught exception that can take down the whole process, inverter monitoring included,
   not just this module. Both `spawn()` call sites (`recorder/process.ts`, `live/session.ts`)
   have an `"error"` handler that cleans up and reports failure. Both also read `stderr` and
   keep the last line: an unread pipe fills its 64 KB buffer and then **wedges ffmpeg
   permanently** — the picture just freezes with nothing in the log — and that last line is
   the only text there is to show the viewer when the stream dies. The same rule applies to
   `ws` sockets (`module.ts`): an `"error"` event with no listener is a thrown exception, so
   every viewer socket gets one, and it unsubscribes the viewer exactly like `"close"` does.
3. **Playback errors must reach the user, not fade into the next frame.** A black rectangle
   with no explanation is a support ticket, not a UI. Both the live and the archive players
   surface stream/HLS failures as a visible status banner (with the reason where one is
   known — no ffmpeg, no signal, gap in the recording) rather than staying silent and letting
   the next frame quietly paper over it.
