# Local API

Start `python run_local.py`. Interactive OpenAPI documentation: `http://127.0.0.1:8765/docs`.

| Method / path | Behavior |
|---|---|
| GET `/health` | Application, worker, FFmpeg, browser and model-service readiness |
| POST `/v1/videos` | Multipart `file` MP4; returns video ID and import job ID (202) |
| GET `/v1/videos` | Recent local videos |
| GET `/v1/videos/{id}` | Metadata, saved analysis, jobs and preview links |
| POST `/v1/videos/{id}/analysis` | Validated sphere focus points and analyzer; returns job (202) |
| GET `/v1/jobs/{id}` | Durable state, real processing stage, error/result |
| POST `/v1/soundtracks` | Analyzed video, mood/engine/seed; returns job (202) |
| GET `/v1/soundtracks/{id}` | Soundtrack state and saved output links |
| GET `/v1/soundtracks/{id}/audio` | Final WAV |
| GET `/v1/soundtracks/{id}/video` | MP4 with generated soundtrack |
| GET `/v1/soundtracks/{id}/preview` | WebM alternative for codec compatibility |
| GET `/v1/soundtracks/{id}/metadata` | Brief, provenance, score when available, audio measurements |
| DELETE `/v1/jobs/{id}` | Request cancellation for an active job |
| DELETE `/v1/soundtracks/{id}` | Cancel an active take; delete a terminal take on a subsequent request |
| DELETE `/v1/videos/{id}` | Delete source and analyses after active jobs/takes are removed |

Import deliberately stops before analysis: the user must choose a sphere focus first. Dimensions and coordinates refer to the normalized silent preview, not the raw file's encoded rotation. Evidence frames contain only masked sphere crops. The original audio never informs the analysis.

Example analysis body:

```json
{
  "analyzer": "measurements",
  "focus": [
    {"time": 0, "cx": 0.5, "cy": 0.6, "rx": 0.1, "ry": 0.18},
    {"time": 9.9, "cx": 0.5, "cy": 0.55, "rx": 0.22, "ry": 0.39}
  ]
}
```

`cx/cy` are center fractions of frame width/height; `rx/ry` are radius fractions. Points must begin at time zero, be strictly time-ordered, fit inside the frame and number at most 16. Position and radii interpolate linearly. `qwen` is the optional semantic analyzer; `measurements` is explicitly a product-palette heuristic plus motion measurements.

Example soundtrack body:

```json
{"video_id":"<32-character video ID>","mood":"auto","engine":"composer","seed":42}
```

Moods: `auto`, `warm`, `calm`, `sad`, `anger`. Engines: `composer`, `ace`. Automatic generation returns 409 when analysis has no clear mood; choose a manual mood. Manual selection preserves `observed_mood` in provenance. A soundtrack freezes its analysis/brief when submitted, so later analysis does not alter an existing take.

Send a unique `Idempotency-Key` on analysis and generation POST requests. Retrying the same key and payload returns the same job. Reusing it for different inputs returns 409. After a failed job, use a new key for an intentional retry. Upload itself is not idempotent. Queue capacity is 20 active jobs.

States: `queued`, `running`, `complete`, `failed`, `cancelled`. `phase` describes actual work; there are no invented progress percentages. Files are published only after successful finishing. Invalid media can fail asynchronously in its import job. Keep polling until a terminal state.

Browser-independent example:

```powershell
.\.venv\Scripts\python.exe scripts/api_example.py "C:\path\demo.mp4" --focus docs/demo-focus.example.json --engine composer --mood warm --seed 42
```

Use the bundled focus JSON only for the supplied demo. The script uploads, polls, analyzes, generates and downloads WAV/MP4 plus metadata. To exercise both model services, pass `--analyzer qwen --engine ace` after installing them.

Files and SQLite are local in this version. No API secrets belong in the static website. A future cloud adapter can preserve the user-facing workflow, but authentication, durable hosted storage and provider quotas still need implementation and deployment tests.

## Automatic upload-to-soundtrack: `POST /v1/soundtracks/auto`

One request uploads a video and queues a single job that imports it, finds or accepts the sphere, reads its colour and motion, chooses the mood, composes with the existing instrument composer, finishes the audio and muxes the video. It returns **immediately** with a job ID; nothing heavy happens in the request. It uses the same sign-in, queue limit, storage quota, retention cleanup and idempotency handling as the other routes.

Multipart form fields:

| Field | Values | Meaning |
|---|---|---|
| `file` | MP4, 10 to 60 s, up to 100 MB | Required. |
| `input_mode` | `robot`, `sphere`, `focus` | Required. There is no silent default. |
| `focus` | JSON array of focus points | Required for `focus`, refused otherwise. Same points as `/v1/videos/{id}/analysis`; timestamps must not exceed the imported video duration. |
| `mood` | `auto` (default), `warm`, `calm`, `sad`, `anger` | An explicit mood overrides the reading and is recorded as such. |
| `on_ambiguous` | `fail` (default), `best_guess` | What to do when `mood=auto` and the colours do not agree. |
| `engine` | `library` (default), `composer` | `library` plays a recorded, licensed track for the mood (see `MUSIC_LIBRARY.md`). `composer` generates music with the instrument composer. Any other value is refused with 422. |
| `seed` | integer, default 42 | Same input and seed give the same track (library) or composition (composer). |

Input modes:

- **`robot`**: full footage of the robot. The sphere is found and tracked automatically (CPU only, no model, no cost). If the selection is unreliable the job fails with `sphere_not_reliable` instead of guessing.
- **`sphere`**: a video that already shows only the sphere. The whole frame is read.
- **`focus`**: the caller supplies focus coordinates (the same as manual selection in the web page). Manual selection through the page and `/v1/videos/{id}/analysis` is unchanged.

Response (202): `{"id": "<job id>", "video_id": "...", "state": "queued", "status_url": "/v1/soundtracks/<id>"}`. Poll `GET /v1/soundtracks/{id}`. It reports `state`, a human `phase`, and machine-readable `stages`, in order: `queued`, `importing`, `detecting` (robot mode only), `analyzing`, `deciding`, `composing`, `finishing`, `muxing`, each `done`, `active` or `pending`. Download with the existing `/audio`, `/video`, `/preview` and `/metadata` routes.

Mood policy. With `mood=auto` the mood comes from a fixed colour-palette rule over the selected sphere interior. If the top two moods are too close (or too weak), the reading is **ambiguous**:

- `on_ambiguous=fail` (default): the job fails with `result.error_code = "ambiguous_mood"` and the analysis attached, so the caller can retry with an explicit `mood`.
- `on_ambiguous=best_guess`: the job continues with the highest colour share. The result records `mood.source = "best_guess"`, `mood.observed = null`, and a warning in `brief.warnings`.

`result.mood` is always `{used, observed, source}` with `source` one of `observed`, `override`, `best_guess`. `analysis.palette_scores` are relative colour shares from a heuristic rule. **They are not calibrated probabilities**, and the response says so.

Failed jobs stay inspectable. `result.error_code` is one of `sphere_not_reliable`, `ambiguous_mood`, `invalid_focus`, or `library_empty` (the library had no approved track for the mood when the job ran), and `error` holds a readable message. Focus duration is checked after import, so out-of-duration points produce an asynchronous `invalid_focus` failure. A point exactly at the imported duration is allowed. Other failures (bad media, timeouts) have an `error` and no code. Failed or cancelled automatic imports also mark the source video as failed; a later analysis or generation failure leaves an already imported video ready.

### Sphere detection output (robot mode)

- `GET /v1/videos/{video_id}/detection`: the full JSON report (status, reasons, metrics, chosen focus points, per-sample track).
- `GET /v1/videos/{video_id}/detection/overlay`: an MP4 of the clip with the selection drawn on it. Green ellipse: the region that will be analysed. Yellow circle: the tracked sphere. A red `REJECTED` label appears when the selection was refused.
- `GET /v1/videos/{video_id}/detection/sheet`: a JPEG contact sheet of eight frames.

These exist for failed robot jobs too, so a person can see what was selected before trusting or rejecting it. They are deleted with the video.

Detection metrics are heuristics, not probabilities: `coverage` (share of sampled frames with a sphere), `quality` (mean relative match score, 0 to 1), `ambiguous_fraction` (share of frames where a different region scored almost as well), `jitter` (path roughness in sphere radii) and `uncertainty_index` (0 confident to 1 unreliable, a blend of those). A selection is refused when coverage is below 0.7, quality below 0.35, ambiguous_fraction above 0.35, jitter above 0.12, or the sphere is lost for over two seconds. These limits were set by hand and checked only on the clips listed in `docs/VALIDATION.md`.

Example client: `python scripts/auto_example.py video.mp4 --mode robot`. Retrying a request with the same `Idempotency-Key` and the same file and options returns the original job without saving another video. Existing-job lookup and content verification happen before persistent-storage and queue-capacity checks, so matching retries still work at capacity. Multipart request parsing can still use temporary disk space. File type, size and nonempty checks still apply; the same key with different valid input returns 409.

### Music library engine

With `engine=library` (the default for this endpoint) the soundtrack is a real recording from `music-library/<mood>/`, chosen by a seeded random pick among approved tracks long enough for the video, cut from its start, levelled to -20 LUFS and finished like every other engine. The result reports what was played:

- `result.provenance.engine` is `library`; `provenance.track` has `title`, `artist`, `source`, `license`, `credit`, `edit_note`, `duration` and `listened` (whether a person approved it); `provenance.selection` records the seed, the candidate counts and whether the track had to be looped; `provenance.gain_db` and `measured_lufs` record the level change; `provenance.warnings` lists anything unusual (a looped track, a level correction beyond the limit).
- The track's credit line is written into the metadata of the exported `soundtrack.wav` and `soundtrack.mp4`. The credit must also be shown wherever the product uses the music.
- If the library is missing or empty, or has no approved track for a mood you named, the request is refused with **409** before anything is stored. With `mood=auto` the mood is only known after analysis, so an empty mood fails the job with `library_empty` instead.
- `GET /health` (with the key) adds `engines.library` and `library_tracks` (approved tracks per mood).
- The older `POST /v1/soundtracks` route now also accepts `engine=library`; its default is still `composer`.
