# Validation and remaining gates

Recorded September 24, 2026. Baseline: `9b02e0f29cc3f6603ecf08d0d21e213449a99dc7`. The existing `index.html` remains byte-for-byte unchanged.

## Completed here

- Python 3.12 local application; real FFmpeg processing and real Chromium Web Audio composition. No GPU or paid inference service was used.
- Eight automated tests pass. They cover the complete MP4 import/analysis/composer/export API, excluding original audio, manual mood versus observed mood, stable saved downloads, idempotency conflicts, invalid media/focus, origin restrictions, deletion dependencies, cancellation, restart recovery and model connection failures.
- Score validation covers all four moods at 10, 10.005, 30 and 60 seconds: finite ordered events, events fitting the output duration, and identical scores for the same brief/seed. Only the short end-to-end cases are audio-rendered by these tests.
- Qwen and ACE-Step **protocol fixture tests** validate request/response handling, sphere-image input, structured output, unload settings, one-item generation, polling/downloads and unfinished-provider blocking. These are not real model inference tests.
- The supplied 10-second demo passed the browser workflow: upload, eight interpolated sphere focus points, analysis, generation, playback, pause, seek, saved WAV/MP4 download and restoring the same take after reload. Desktop and 390-pixel mobile layout checks passed with no JavaScript errors.
- The provided video produces a Warm palette suggestion using only its selected sphere interior. Cropped evidence was inspected; the robot's face is excluded. Source audio is not used.
- The four supplied stills were inspected as palette calibration references. Warm and Anger are distinguishable; Sad and pale Calm overlap in blue. The latter overlap now marks the result ambiguous and requires a manual choice instead of claiming a confident Sad classification. This is not an independently held-out accuracy evaluation.
- The generated WAV has exactly 441,000 stereo frames at 44,100 Hz (10 seconds). Non-silence, sample peak, RMS, integrated loudness, loudness range and true peak are checked. Final WAV true peak must be at most -1 dBTP. Preview/export derive from this saved master; lossy encoding can alter encoded peaks slightly.
- Headless Chromium in this environment has no H.264/AAC decoder. A WebM preview path was therefore implemented and used for browser playback checks. The MP4 export was checked with FFmpeg; native Chrome/Edge MP4 playback remains a target-browser check.
- Instrument attribution survives final WAV and video metadata. The user videos, screenshots, generated files and model weights are excluded from Git.

The test runner emits a Starlette warning about its current httpx test-client integration. Tests pass; the application itself uses httpx as a model-service client.

## Not yet validated

1. **Qwen3-VL inference on the target laptop.** Verify its actual observations, memory and latency, especially on stylized sphere scenes. Current automatic palette analysis is not a semantic substitute.
2. **ACE-Step output and quality.** Verify installation, non-XL model revision, GPU/offload behavior, absence of vocals, musical coherence and natural endings. No ACE-Step-generated audio is represented as completed in this branch.
3. **User listening approval.** The provided demo is a functional example using the existing instrument engine with a duration-aware visual adapter. It is not evidence that the richer music-quality goal has been met.
4. **Windows and target browser setup.** Setup instructions are included, but this execution environment is Linux. Use `scripts/doctor.py` to check the actual machine.
5. **Broader release gates.** The original proposed multi-clip listening comparison, 20 consecutive valid generation jobs, long-session memory observations, low-disk fault injection, full offline model operation and quality averages are outstanding.
6. **Cloud deployment.** A demo server now runs on Oracle Cloud (see `docs/DEPLOYMENT_STATUS.md`). Remaining: per-person accounts, backups, durable storage, and load and long-run testing.

## Known scope limits

- Focus tracking is manual with linear interpolation. Changes in pose, occlusion or non-linear camera motion may need extra points. Motion measurements include residual camera movement and lighting changes.
- The v6-based score can respond to the measured energy curve. The neural prompt currently communicates overall atmosphere and activity; it does not guarantee event-level timing or exact section changes.
- Export normalizes video to 24 fps and at most 1280 pixels on its longest side. This is a preview-quality workflow, not a full-resolution archival export.
- A crashed active job becomes failed rather than automatically rerun. A cancelled ACE job can continue inside its own service until completion. Unknown provider tasks block further GPU jobs until reconciled.
- No automatic retention or public multi-user access. Downloaded outputs need the included instrument credits where applicable.

The next acceptance step is the actual laptop setup and a short, matched-loudness listening comparison between the composer and ACE-Step on this same clip.

## Automatic video-to-music pipeline (branch `feature/auto-video-api`)

Recorded September 24 to 25, 2026. Added on top of the hosting work: `POST /v1/soundtracks/auto`, a CPU sphere detector with temporal tracking, detection overlays, and an explicit mood-ambiguity policy. This work is merged to `main` and was deployed to the demo server on September 25, 2026.

### What is validated, and how far that goes

**Demo validation (one clip, not general reliability).** The supplied 10-second demo (`EchoSphere Robot Design Demo-Ver 1.mp4`, camera zooming toward a golden sphere in a living room) was run through the detector and compared, at 50 sampled times, with the hand-marked focus points in `docs/demo-focus.example.json`. Command: `python scripts/validate_demo_detection.py <video>`.

| Measure | Result |
|---|---|
| Sphere found in sampled frames (coverage) | 100% |
| Mean overlap with the hand-marked ellipse (IoU) | 0.82 |
| Worst-frame overlap | 0.67 |
| Mean centre error | 16.6 px at 1280 px wide (worst 32.5 px) |
| Automatic radius relative to the hand mark | 0.93 on average |
| Keypoints produced | 8 (limit 16) |
| Detector heuristics | quality 0.95, ambiguous fraction 0.19, uncertainty index 0.39 |

The overlay contact sheet shows the selection on the glass sphere in all eight sampled frames, with the robot's face, the fireplace and the lamps not selected. The manual points came from the same footage and the same person who built the detector, and the detector's scoring was adjusted while looking at this clip. **Treat it as a demo check, not as evidence the detector generalises.**

**Full pipeline, real footage.** Through the one-call endpoint on an isolated local server (no key, composer engine):

| Input | `input_mode` | Outcome | Time |
|---|---|---|---|
| Demo video | robot | Completed, mood Warm (observed); 10.00 s stereo WAV | 25 s (job ID returned in 0.2 s) |
| Warm still as a 10 s video | robot | Completed, Warm (observed) | 22 s |
| Sad still | robot | Completed, Sad (observed) | 15 s |
| Anger still | robot | Completed, Anger (observed) | 20 s |
| Calm still | robot | **Failed with `ambiguous_mood`** (colour shares calm 0.24, sad 0.76) | 21 s |

The four stills are static images turned into video with FFmpeg, on a black background, in portrait. The Calm result is the policy working, but narrowly: the ambiguity rule fires when the second-ranked mood has a share above 0.22, and Calm scored 0.24. It is not robust, and the palette rule still reads a deep-blue interior as Sad. With `on_ambiguous=best_guess` this clip would have been reported as a **Sad best guess**, which is the wrong feeling for it; that is why the default is to fail.

**A failure found and fixed during validation.** The first detector scored saturated colour, so on the pale-violet Calm still it locked onto the small deep-blue patch at the top of the ball and the colour reading came out a confident, wrong "Sad" with no warning. Scoring was changed to recognise the robot body by smoothness (a pale sphere is as bright as the body but full of structure). After the change the selection covers the ball and the demo numbers above were unchanged. A second bug was found by the portrait stills: the overlay video had an odd height, which H.264 rejects. Overlay dimensions are now even, and an overlay failure no longer fails the job.

**Automated tests.** The suite runs `tests/test_detect.py` (synthetic scenes with a moving camera plus a fireplace, a lamp and a dark face; a no-sphere scene is rejected; keypoints satisfy the existing analysis contract) and `tests/test_auto.py` (the three input modes; stages; detection artifacts available for both accepted and rejected jobs; rejection of an unreliable sphere; ambiguity fails by default, `best_guess` is opt-in and reported, an explicit mood overrides and keeps the observation; invalid options refused before anything is stored; idempotent retry; sign-in and queue limit on the new route; cleanup removes the detection files). Synthetic scenes are easier than real footage, so they show the code does what it claims, not that it works on the robot's real camera.

### Not validated

- **Any footage other than the demo and the four stills.** In particular: a moving camera on real footage, a sphere partly hidden, motion blur, several similar circular objects, and clips with no visible sphere. The only no-sphere test is a synthetic scene.
- **Detection thresholds.** Coverage 0.7, quality 0.35, ambiguity 0.35, jitter 0.12 and the two-second gap limit were set by hand. They are not tuned on a range of clips and are not calibrated probabilities. `uncertainty_index` is a heuristic blend, not a probability.
- **Mood accuracy.** The colour rule is a product-palette heuristic tested on the four supplied stills plus one demo. Calm versus Sad remains unresolved.
- **Speed and memory on the hosted server.** Times above are from a Windows laptop.
- **The new endpoint's speed on the deployed server.** It is deployed (the server's API page lists `POST /v1/soundtracks/auto`), but no timed full run on the Oracle server is recorded in this file.
- **Music quality.** Unchanged from the existing composer and not part of this work.

### API review fixes — September 25, 2026

The three review issues on commit `058890e` are fixed:

- Automatic import failures and cancellations update the source video to `failed`, with an error. Failures after a successful import keep the video `ready`.
- Caller-supplied focus timestamps are checked against the normalized video's actual duration before analysis. Out-of-range points fail the job with `invalid_focus`; a point exactly at the endpoint remains valid.
- Matching idempotent retries reuse the saved job before persistent-storage and queue-capacity checks. Changed file contents or options still conflict, and file size/type/nonempty checks still apply. New uploads remain subject to the quota.

Independent verification in the review workspace: **35 tests passed** on Linux/Python 3.12.14, using the pinned requirements, Playwright 1.51.0 Chromium headless shell and system FFmpeg. The suite includes real audio composition and video export. Six new regression cases cover invalid media, cancellation during import, both focus-duration boundaries, retries at full storage/queue capacity, and retry upload validation. The four bug-focused cases fail against the original code. One existing Starlette/httpx test-client deprecation warning remains.

This verifies API behavior, not detector generalization, Calm/Sad accuracy, or Oracle-hosted performance. These fixes are merged and deployed; their behaviour on the Oracle server was not separately measured.

## Music library (branch `feature/music-library`)

Recorded September 28, 2026. The default music for `POST /v1/soundtracks/auto` is now a recorded track picked from `music-library/<mood>/` (the instrument composer remains available with `engine=composer`). Design and how to use it: `docs/MUSIC_LIBRARY.md`.

### What was checked on the 80 supplied tracks

- **Licence evidence.** 79 of 80 files carry the embedded artist tag "Kevin MacLeod" (most also name incompetech.com). The terms were read from incompetech.com's own FAQ on this date: **CC BY 4.0, commercial use allowed, credit required, changes must be stated**. This is inferred from the tag, not proven for each file; it assumes the files came from incompetech.com. One file (`warm/Egmont Overture.mp3`) has no tags at all, so its source is unconfirmed and it is excluded.
- **Duplicates.** Three byte-identical pairs (SHA-256). Two of them (`Midsummer Sky`, `Sapphire Isle`) were filed under both Warm and Calm, which contradicts itself; the third (`The Whip Theme`) was a copy inside Anger. Both cross-folder pairs are held until a mood is chosen.
- **Length.** 39 s to 12 min (average about 3 min); five tracks are shorter than 60 s. The picker prefers tracks long enough for the video and loops only as a last resort, with a warning.
- **Loudness.** The first minute of the tracks spans roughly -40 to -9 LUFS (up to about 30 dB between the quietest and loudest track; the folder medians differ by only about 6 dB). Each excerpt is therefore levelled to -20 LUFS (boost capped at +18 dB, cut at 12 dB, with a warning when a limit applies).

### How well audio measurements agree with your folders (an honest limit)

Tempo, loudness, brightness, note density and major/minor lean were measured on the first 60 s of each unique track (77 files) and compared with the folder each was filed in, two ways: a nearest-average classifier scored leave-one-out, and a valence/arousal quadrant rule that uses no labels.

| Method | Agrees with the folder | Chance |
|---|---|---|
| Nearest average of the folders (leave-one-out) | 49% | 25% |
| Quadrant rule (no labels) | 56% | 25% |

Anger was identified well (14 of 19 by each method). Warm, Calm and Sad were confused with each other, and 8 of the 20 Warm tracks measured like Anger by the nearest-average method (loud, bright, busy). These measurements cannot hear "sad" versus "calm". They are used only to hold back a track when **both** methods name the **same other** mood: 16 tracks, plus the duplicates. **Everything else is "ok" meaning no contradiction was measured, not that a person listened.** With the holds applied, 58 tracks are usable (Warm 10, Calm 14, Sad 16, Anger 18). This is a small sample (20 per folder) and the folder labels themselves are unverified, so treat the percentages as indicative.

### End to end with the real library

Real local server, no key, your library, `engine` left at its default:

| Input | Mood read | Track played | Time |
|---|---|---|---|
| Demo video (robot mode) | Warm | Inner Light (a 576 s track, -7.2 dB) | 21.5 s |
| Warm still as a 10 s video | Warm | Pennsylvania Rose (+8.1 dB) | 25.5 s |
| Sad still | Sad | Lasting Hope (-2.0 dB) | 16.4 s |
| Anger still | Anger | The Cannery (-5.5 dB) | 20.5 s |

For all four the exported WAV is exactly 10.00 s, measures -20.2 to -20.6 LUFS with true peak at most -4.5 dBTP, the MP4 has one H.264 video and one AAC audio stream (the source video's own audio is not used), and the track's credit is present in the metadata of both the WAV and the MP4. The Calm still was not run: it fails as ambiguous unless a mood is given, as before. Direct renders of 10 s and 60 s excerpts for every mood (12 renders) all came out at -20.0 LUFS at the right length.

### Bugs found while building this

- The automatic endpoint had no `engine` field, so a request for `engine=composer` was silently ignored and a library track played. It now accepts and validates `engine` (anything other than `library` or `composer` is a 422).
- A test tone about 32 dB too quiet exposed that a level correction beyond the boost cap happened silently. It now adds a warning to the result.

### Tests

New: `tests/test_library.py` (picker, cutting, levelling, credits in metadata, looping, empty mood, manifest path safety, missing manifest, boost cap warning) and `tests/test_music_manifest.py` (duplicates, conflicts, unknown source, your decisions, extra licence terms, the generated files). `tests/test_auto.py` gained tests for the library default and its credit in the exported files, up-front refusal when the library cannot serve a request, `engine=composer`, and a mood that becomes empty after a job was accepted.

### Not validated

- **Whether any track actually fits its mood.** Nobody has listened to the 58 usable tracks against the sphere; automatic checks cannot judge that. `review.html` exists to make this quick.
- **Detection on more real footage** (unchanged from the earlier section).
- **The Oracle demo server.** It runs older code, and its container does not include the `music-library` folder, so `engine=library` would be refused there.
- **How the level correction and fades sound** on real videos, and the seam where a track had to loop (no such case occurred with this library for videos up to 60 s, except tracks shorter than the video, which the picker avoids).
- **Credits in the product.** The files carry them and `CREDITS.md` lists them, but showing them in the final product is a manual step.


## Browser edition (`video-music/`, September 29, 2026)

The video-reading pipeline was ported to JavaScript so it can run on GitHub Pages with no server; see `BROWSER_VERSION.md`. What was checked, and how far that goes:

**Demo validation (one clip, not general reliability).** The demo video was read in the browser code and compared, at 50 sampled times, with the same hand-marked points used for the Python detector:

| Measure | Browser code | Python detector |
|---|---|---|
| Sphere found in sampled frames | 100% | 100% |
| Mean overlap with the hand-marked ellipse (IoU) | 0.85 | 0.82 |
| Worst-frame overlap | 0.76 | 0.67 |
| Mood read | Warm (0.87 to 0.93 depending on how the video was decoded) | Warm (0.87) |
| Time for 50 frames | about 2.7 s in Node, about 6 s in a browser | about 14 s |

The four supplied stills were read as: Warm (0.73 warm, 0.27 anger), Sad (0.90), Anger (0.96), and Calm as **mixed** (calm 0.23, sad 0.78), so the page asks. Python read Warm 0.90, Sad 0.93, Anger 0.93 and Calm as mixed (0.24 / 0.76). The Warm still reads with more Anger share in the browser than in Python; the mood is the same.

**Ported logic checked against the original.** The colour rule was run on the same pixel sets as `server/analysis.py` and agreed within 0.02 on all eight cases, including its quirk that a pale-violet reading can give a "share" above 1 (pale pixels are counted twice); that quirk was kept for parity.

**Bugs found and fixed while building it.**
- Several overlapping circles inside one textured glass ball were counted as rival objects, so the pale Calm image was rejected. Overlapping candidates are now one object. A first attempt (prefer the enclosing circle when scores are close) removed the real sphere in the demo's early frames and was dropped, because the margin between right and wrong was about 1 to 2 points of score.
- Frames were read from the visible video, so after dozens of seeks the picture on screen could disagree with the outline drawn over it. Frames now come from a hidden copy.
- The song drifted away from the video on a server without range requests; drift correction was made gentler (it no longer interrupts a seek in progress) and the tests use a range-capable server like GitHub Pages.
- The Calm sample landed just under the server's Calm/Sad "mixed" cutoff (0.22) once the video was compressed, so it was silently read as Sad. This page asks from 0.16 (Sad sample measured about 0.10; Calm sample 0.22 to 0.26). That is tuned on two samples, so treat it as a cautious default and not a measured optimum.

**Tests.** 23 JavaScript unit tests and 8 real-browser tests (see `BROWSER_VERSION.md`), all passing on Windows, in Chromium. A separate run against the real demo video in the same browser covered every path listed there, plus a check that the song stays within about 0.1 s of the video and follows a jump to 7 s within 0.02 s.

**Not validated.** Any real robot footage other than the demo and the four stills; Firefox and Safari; real phones (only a phone-sized window); H.264 decoding in the automated tests (the demo MP4 was checked by hand); long videos (60 s or more) end to end in a browser; how the songs and levelling sound on real videos; the page on the live GitHub Pages address (it is not merged yet).
