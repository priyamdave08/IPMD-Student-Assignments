# EchoSphere Video-to-Music: the complete guide

*Written September 25, 2026. Everything here was checked against the merged code (`main`, commit `55f3383`) and the tests we ran. Where something was not checked, this guide says so.*

**How to read this:** if you only have two minutes, read section 1. If you want to *use* it, go to section 5. If you want to *test* it, go to section 6.

---

## 1. The 60-second summary

**What it does.** You give it a video of the EchoSphere robot. It finds the glowing sphere, reads the sphere's colors to decide a mood (Warm, Calm, Sad or Dynamic), picks a matching recorded track from the music library, cuts it to the video's length, and hands you back the music and the video with the music added.

**Why it exists.** The team changed the goal from "make music from a song" to "make music from what the robot's sphere *looks like*", with an API so the robot and the team can call it automatically.

**Where it lives.**

| Piece | Where |
|---|---|
| The code | GitHub: `Ehtiram-Shukurov/echosphere-music` (branch `main`) |
| The original music page | GitHub Pages: `https://ehtiram-shukurov.github.io/echosphere-music/` (unchanged) |
| The API server | A free-credit Oracle Cloud server (address and access key are held by the project owner, not written in this public repo) |

**Honest status in one line.** It works end to end and passes 30 browser tests plus the Python suite. It has been proven on **one demo video and four still images**, not on a wide range of real footage, and the server is a **temporary demo**. The live product is the browser page on GitHub Pages (see section 13).

---

## 2. What we were asked to do, and what we built

**The request.** In your teammate's words (as relayed to us): *video → automatic mood that matches the sphere and environment → generate music → an API to use it.*

**What we had at the start.** A browser music generator: pick a mood or upload a song, and it composes new instrumental music with real instrument samples. It was already live on GitHub Pages.

**What we built, in order.**

1. **Fixed a real bug** in the music generator: uploading different songs always produced the same music, because one internal random seed never changed. Now different references give different music, and the same reference gives the same music.
2. **A local video-to-music app** (Python + a web page): upload a video, mark where the sphere is, read its colors, compose music, download the result.
3. **Hosting preparation:** sign-in with an access key, storage limits, automatic cleanup of old videos, and a container so it can run on any server.
4. **A server on Oracle Cloud**, with a free HTTPS address.
5. **The automatic version:** the server now finds the sphere *by itself*, so nobody has to mark it. One request in, one soundtrack out.
6. **Tests, documentation and evidence** at every step.

**What we did *not* build** (so nobody assumes it exists): the emotional *Regulation* mode, an on-robot (ESP32 chip) version, AI music generation (ACE-Step), an AI vision model (Qwen), per-person accounts, or backups.

---

## 3. How it works (plain English)

```
   your video (MP4)
        │
        ▼
 1. PREPARE      Remove the video's own sound (it must not influence anything).
                 Convert to a standard size and speed.
        │
        ▼
 2. FIND SPHERE  Look through the clip for the glass ball, follow it as the
                 camera moves, and draw a region just inside it.
                 (Skipped if you tell it where the sphere is.)
        │
        ▼
 3. READ SPHERE  Look ONLY inside that region: which colors are there,
                 how bright, how much movement.
        │
        ▼
 4. CHOOSE MOOD  gold → Warm   violet → Calm   blue → Sad   red/orange → Dynamic
                 If the colors don't clearly agree, STOP and say so.
        │
        ▼
 5. COMPOSE      The existing music engine writes a piece of the right length,
                 using real instrument recordings (piano, strings, guitar...).
        │
        ▼
 6. FINISH       Trim to the exact video length, fade in/out, keep the volume
                 safe, check it isn't silent.
        │
        ▼
   music (WAV)  +  video with the music (MP4)
```

**Some important ideas behind it.**

- **Only the sphere is read.** All four sample images show the same smiling face, so a general "what emotion is this?" model would call every one cheerful. EchoSphere expresses feelings through the *sphere's light*, so we read only the inside of the sphere. The robot's face is deliberately ignored.
- **The colors are a product rule, not AI.** Gold means Warm, pale violet means Calm, blue means Sad, red-orange means Dynamic (called Anger earlier in the project). These are EchoSphere's own palette, applied by a fixed rule. There is no trained model.
- **The music is rule-based, not AI-generated.** Each mood is a preset (tempo, key, instruments, brightness, reverb), proposed with AI help from music-emotion research and refined by listening. The engine composes notes from those rules. No generative music model is used, and nothing is copied from any recording.
- **Finding the sphere uses no AI either.** It is ordinary image analysis (looking for a round glass edge with a lit, textured interior), followed by tracking the ball across frames. It runs on a plain CPU and costs nothing.
- **It refuses to guess quietly.** If it can't find the sphere reliably, or the mood is unclear, the job *fails with an explanation* and keeps pictures showing what it looked at. You can then supply the answer yourself.
- **Free by design.** No paid AI service, and the server runs on promotional credit with no payment card.

---

## 4. What is on the server, and how it is protected

- **Where:** an Oracle Cloud virtual machine (Chicago region), Ubuntu 24.04, 64-bit Arm. Docker runs the app; a program called Caddy in front gives it a free HTTPS certificate.
- **The address:** a free DuckDNS name pointing at the server. Ask the project owner for the address; it is intentionally not published here.
- **Access:** one shared **access key**. Requests without it get `401 Authentication required`. In a browser you type the key once and get a temporary sign-in cookie. Programs send `Authorization: Bearer <key>`.
- **Limits:** MP4 only, 10 to 60 seconds, up to 100 MB per video, up to 20 jobs waiting, 20 GB total storage.
- **Cleanup:** a video and its results are deleted after 24 hours of no activity. Jobs that are running are never deleted.
- **Billing:** the Oracle account is on a promotional Free Tier with **no payment method on file**, so there is nothing to charge. The server's shape is *not* the permanently free one, and the promo credit's size and end date were not checked, so **treat the server as temporary**. Details: `docs/DEPLOYMENT_STATUS.md`.

---

## 5. How to use it

You need: the server address, and the access key (ask the project owner; never post the key in chat or commit it to Git).

### Method A: the interactive page (easiest, no code)

1. Open `https://<server-address>/`. Enter the access key when asked.
2. Open `https://<server-address>/docs` in the same browser. This lists every action the API can do.
3. **Start a job.** Open `POST /v1/soundtracks/auto` → **Try it out**. Choose your MP4 as `file`, set `input_mode` to `robot`, and click **Execute**. The reply comes back at once and contains an `id`. Copy it.
4. **Check on it.** Open `GET /v1/soundtracks/{id}` → **Try it out** → paste the id → **Execute**. Look at `state`. Repeat every few seconds until it says `complete` (or `failed`, in which case read `error`).
5. **Download.** Open `GET /v1/soundtracks/{id}/audio` for the music (WAV), or `.../video` for the video with music (MP4). Click **Execute**, then **Download file**.

### Method B: the ready-made script (does all of that for you)

On a computer that has this repository and Python set up (see `docs/LOCAL_SETUP.md`):

```powershell
$env:ECHOSPHERE_API_KEY = "<your access key>"
python scripts/auto_example.py "C:\path\video.mp4" --mode robot --url https://<server-address>
```

It uploads, prints each stage with a time, and saves the WAV, MP4 and the detection pictures into `data/auto-output/`. The key is read from the environment variable, never from the command line.

### Method C: any program or another app

A single upload request starts the job; then poll and download. With the `curl.exe` that ships with Windows:

```powershell
# 1. Start (returns {"id": "...", "status_url": "..."} immediately)
curl.exe -H "Authorization: Bearer $env:ECHOSPHERE_API_KEY" -F "file=@video.mp4" -F "input_mode=robot" https://<server-address>/v1/soundtracks/auto

# 2. Check (repeat until "state" is "complete")
curl.exe -H "Authorization: Bearer $env:ECHOSPHERE_API_KEY" https://<server-address>/v1/soundtracks/<id>

# 3. Download
curl.exe -H "Authorization: Bearer $env:ECHOSPHERE_API_KEY" -o music.wav https://<server-address>/v1/soundtracks/<id>/audio
curl.exe -H "Authorization: Bearer $env:ECHOSPHERE_API_KEY" -o video.mp4 https://<server-address>/v1/soundtracks/<id>/video
```

### The options for `POST /v1/soundtracks/auto`

| Field | Values | What it means |
|---|---|---|
| `file` | an MP4 | Required. 10 to 60 seconds. |
| `input_mode` | `robot` | Full robot footage. The server finds and tracks the sphere. |
| | `sphere` | The video already shows only the sphere. The whole frame is read. |
| | `focus` | You supply the sphere's position yourself (`focus` field, below). |
| `focus` | JSON list of points | Only for `focus` mode. Example: `[{"time":0,"cx":0.5,"cy":0.6,"rx":0.1,"ry":0.18}]` (all positions are fractions of the frame). |
| `mood` | `auto` (default), `warm`, `calm`, `sad`, `anger` | Leave `auto` to read it from the sphere. A value here overrides the reading. |
| `on_ambiguous` | `fail` (default) or `best_guess` | What to do if the colors don't clearly agree. `fail` stops and explains. `best_guess` continues with the closest match and marks it as a guess. |
| `seed` | a number (default 42) | Same video and seed give the same music. Change it for a different version. |

### What comes back when the job finishes

- **`state`:** `queued` → `running` → `complete` (or `failed` / `cancelled`).
- **`stages`:** a list showing progress: `queued`, `importing`, `detecting`, `analyzing`, `deciding`, `composing`, `finishing`, `muxing`.
- **`result.mood`:** `{used, observed, source}` where `source` is `observed` (read from the sphere), `override` (you chose it) or `best_guess`.
- **`result.analysis`:** what the colors looked like. The numbers there are relative color shares, **not probabilities**.
- **On failure:** `error` in plain words plus `result.error_code`:
  - `sphere_not_reliable`: the sphere couldn't be found with confidence. Look at the pictures (below), or use `focus` mode.
  - `ambiguous_mood`: the colors don't clearly point to one feeling. Send a `mood`, or set `on_ambiguous=best_guess`.
  - `invalid_focus`: a supplied point is past the end of the video.

### Seeing what the server picked as "the sphere" (robot mode)

- `GET /v1/videos/{video_id}/detection/overlay`: a video with the selection drawn on it (green = the region that is analysed).
- `GET /v1/videos/{video_id}/detection/sheet`: a picture of eight frames from that video.
- `GET /v1/videos/{video_id}/detection`: the full report with the measured numbers.

These stay available even when a job fails, so a person can check whether it picked the sphere, the face or the background.

### The older, manual route

The web page at the server's main address (and `POST /v1/videos` → `/analysis` → `POST /v1/soundtracks`) lets a person mark the sphere by hand. It still works and is unchanged. Full reference for every route: `docs/API.md`.

---

## 6. How to test it

### 6.1 Two-minute smoke test on the server

1. `https://<server-address>/health` in a browser shows only `{"status":"ok"}`. If it shows more, sign-in is not active.
2. `https://<server-address>/v1/videos` (before signing in) shows *Authentication required*.
3. Run Method A or B above with the demo video. Expected: a `complete` job, a 10-second WAV, and an MP4 with music. The mood for the demo should be **Warm**.

### 6.2 Things that *should* fail, and how

| Try this | Expected |
|---|---|
| Any request without the key | `401` |
| Upload a `.txt` file or a video not ending in `.mp4` | `415` |
| Omit `input_mode` or use a wrong value | `422` with a message |
| `input_mode=focus` with no `focus` | `422` |
| `input_mode=robot` with a `focus` | `422` |
| A video with no visible sphere | job `failed`, `error_code = sphere_not_reliable`, overlay pictures saved |
| The Calm-colored test image as a video | job `failed`, `error_code = ambiguous_mood` (this is the correct behaviour) |
| The same Calm video with `on_ambiguous=best_guess` | completes, marked `best_guess` (and it will probably be **Sad**, which is wrong for it; that is why `fail` is the default) |
| The same request sent twice with the same `Idempotency-Key` header | the same job comes back, no duplicate |

### 6.3 The automated tests (on a computer with the project set up)

```powershell
cd echosphere-video-test
.\.venv\Scripts\python.exe -m pytest -q
```

Expected: **35 passed** (about 5 minutes; it really renders audio and video). They cover the sign-in and limits, the cleanup rules, the sphere detector on synthetic scenes (including one with no sphere), every input mode, the mood rules, retries and the error cases. They ran on Windows and on Linux.

### 6.4 The sphere-detection check on the demo

```powershell
.\.venv\Scripts\python.exe scripts/validate_demo_detection.py "C:\path\EchoSphere Robot Design Demo-Ver 1.mp4"
```

It compares the automatic selection with hand-marked points and saves the overlay video and picture. Result on the demo: sphere found in all sampled frames, average overlap with the hand-marked region **0.82** (worst frame 0.67), average position error about 17 pixels on a 1280-pixel-wide frame.

### 6.5 What a good result looks like

Play the MP4. The music should start at the beginning, end with the video, and *feel* like the mood on screen. Whether it sounds good is a human judgment; the tests cannot say. If the overlay shows the green region on the glass ball (not the face), the detection did its job.

---

## 7. What was verified, and what was not

| Verified | How |
|---|---|
| The whole pipeline, upload to WAV and MP4, on real footage | Ran the demo through the real endpoint: about 25 seconds on a Windows laptop |
| 35 automated tests | Passed on Windows and Linux |
| Sign-in, 401 on missing key, HTTPS, redirect from HTTP | Checked from outside the server |
| The Warm, Sad and Anger images read correctly | Ran each through the automatic endpoint |
| Bad inputs are refused | Automated tests |
| The server was updated and lists the automatic route | The API page on the server shows `POST /v1/soundtracks/auto` |

| **Not** verified | Why it matters |
|---|---|
| Detection on real footage beyond the demo and four still images | The thresholds were set by hand. A moving camera on real footage, a half-hidden sphere, or a second glowing object are untested |
| A video with no sphere in real footage | The only "no sphere" test is a synthetic scene |
| Speed and memory on the Oracle server | The 25 s figure is from a laptop |
| The server running with the developer's laptop switched off, or after a reboot | Should work (it is a separate machine set to restart), but nobody tried |
| How the music *sounds* to other people | Unchanged from the existing composer, and only humans can judge it |

---

## 8. Known problems and limits

1. **Calm versus Sad is the weak spot.** The Calm sample has a deep-blue "sky" inside a pale sphere. The color rule sees blue and leans Sad. The system only *just* caught it as unclear (Calm's share 0.24 against a 0.22 cutoff). Do not rely on it for Calm.
2. **The detector has thin evidence.** It was tuned while looking at the demo. Treat its thresholds as a first draft.
3. **The server is temporary and simple.** One shared key for everyone. No backups. Promo credit whose size and end date are unknown. Updating it is a manual step over SSH.
4. **Two small known bugs.** Cancelling an automatic job before it starts leaves its video marked "queued" (cleanup removes it later). Two identical requests sent at the same instant can give the second one a `409` instead of the first job.
5. **Video limits.** MP4 only, 10 to 60 seconds, 100 MB.

---

## 9. Running and maintaining the server

**Update it** (after new code is merged to `main`). Log in to the server (`ssh`) and run:

```bash
cd ~/echosphere-music && git fetch origin && git checkout main && git pull --ff-only
cd deploy && sg docker -c 'docker compose up -d --build'
sg docker -c 'docker compose ps'
```

The site is down for a few minutes while it rebuilds. To roll back, check out the earlier commit and rebuild.

**Change the access key.** Edit `deploy/.env` on the server (the line `ECHOSPHERE_API_KEY=`), then run `docker compose up -d`. Everyone is signed out.

**Show or find the key.** It lives only in `deploy/.env` on the server. It is not in GitHub.

**Save credit.** Stopping the server in the Oracle console pauses most of the cost. Videos stored on it survive only as long as its disk does.

**Settings** (in `deploy/.env`): `ECHOSPHERE_RETENTION_HOURS` (default 24), `ECHOSPHERE_MAX_STORAGE_GB` (default 20). The full list is in `docs/HOSTING.md`.

---

## 10. Where everything is (the map)

**Documents** (`docs/`)

| File | Read it for |
|---|---|
| `GUIDE.md` (this file) | The whole story, how to use it, how to test it |
| `API.md` | The exact reference for every route and option |
| `LOCAL_SETUP.md` | Running everything on your own computer |
| `HOSTING.md` | The free-hosting comparison and the settings |
| `DEPLOY_ORACLE.md` | How the server was set up, step by step |
| `DEPLOYMENT_STATUS.md` | Where the server runs and how it is billed |
| `VALIDATION.md` | Exactly what was tested and what was not |

**Scripts** (`scripts/`): `auto_example.py` (the automatic endpoint), `api_example.py` (the manual route), `validate_demo_detection.py` (check the sphere detector), `doctor.py` (check a computer is set up correctly).

**Code** (`server/`): `app.py` (the API), `detect.py` (finds the sphere), `analysis.py` (reads the colors), `auto.py` (runs the automatic steps), `worker.py` (does the heavy work), `auth.py` and `retention.py` (sign-in and cleanup).

**Tests** (`tests/`): 35 tests, described in section 6.3.

**The original music page:** `music-page.html` (formerly `index.html`, content unchanged; still on GitHub Pages). The site root now opens `video-music/`.

---

## 11. What could come next

- **More real clips**, especially: a moving camera on real footage, Calm and Sad in different lighting, a video with no visible sphere, a half-hidden sphere. This is the most valuable next step because it shows whether the detector holds up.
- **Better Calm versus Sad separation:** use brightness and saturation as well as color, or have the robot send its intended mood along with the video.
- **A sturdier server:** a permanently free Oracle shape if one becomes available, per-person keys instead of one shared key, backups, and a test with the laptop switched off and after a reboot.
- **Richer music:** the AI music route (ACE-Step) was researched and deliberately deferred. The existing composer can also be improved.
- **The two small bugs** in section 8.
- **The Regulation mode idea and the on-robot version** from the team discussion, if the team wants them.

---

## 12. Update: the music now comes from a library of recorded tracks

*Added after the team asked to drop the music-generation part: "collect music, label it warm/calm/sad/anger, and when the sphere is analysed, give a track from those folders".*

**What changed.** The sphere-reading half is unchanged. The last step, which used to compose music, now **picks a real recorded track** from `music-library/<mood>/`, cuts it to the video's length, levels its volume and fades it. This is the default for `POST /v1/soundtracks/auto`; `engine=composer` still works.

**What is in the library now.** 76 tracks, all by Kevin MacLeod (incompetech.com), 74 of them approved for use: Warm 15, Calm 21, Sad 19, Dynamic 19. Their licence, **CC BY 4.0, allows commercial use but requires the credit** wherever the music is used. Every exported file carries its credit, the result page shows it, and `music-library/CREDITS.md` lists them all. **The product itself must show those credits.**

**How a track is picked.** Each track is scored by how close its feel (brightness, intensity, energy) is to the mood's ideal point, and the seed picks among the three closest. The excerpt starts on a beat: beat positions are pre-measured for every track and stored in the manifest, so the music starts on a musical downbeat instead of mid-phrase.

**What the automatic check found.**
- 3 files were duplicates (2 of them filed under two different moods), and 1 file had no source information, so those are held out.
- Measured tempo, loudness and brightness agree with your folders only about half the time. They are good at spotting a loud, busy track filed as calm, and poor at telling Warm, Calm and Sad apart. So **16 tracks are held for a listen** (two independent checks both said they sound like a different mood) and the rest are used as filed.
- Warm is the thinnest folder (10 usable tracks) because several "Warm" tracks measure as loud, bright and busy.
- Loudness differs by up to about 30 dB between individual tracks, so every excerpt is levelled to -20 LUFS.

**What you do.** Open `music-library/review.html`, play the flagged tracks (30 seconds each), click what each one really is, copy the decisions into `music-library/decisions.json`, and rebuild with `tools/build_music_manifest.py`. Details: [MUSIC_LIBRARY.md](MUSIC_LIBRARY.md).

**Honest limits.** "ok" means nothing measured contradicts the folder, not that a person listened. The excerpt starts on a beat and ends with a fade, not a musical ending. The demo server on Oracle cannot use the library yet: its container does not include the `music-library` folder, so it would refuse this option until that is set up.

---

## 13. Update: a version that runs only on GitHub Pages

*Added after the team said: no cloud, no API, only GitHub, with the video detection we already had choosing a song.*

**What it is.** `video-music/` is a web page that does the whole job inside the visitor's browser: add a video, it finds the sphere, reads the feeling from its light, and plays a song from the music library. There is no server, so it can be hosted on GitHub Pages. The video never leaves the device.

**How it was built.** The sphere finder and the colour rule were ported from Python to JavaScript, then checked against the Python versions on the same demo video and stills. On the demo the browser finds the sphere in every frame and matches the hand-marked outline better than the Python one did (0.85 vs 0.82). A visible green outline shows what was read.

**What to remember.** It is only as good as the colour rule: Calm versus Sad is still the weak spot, so when the light mixes them the page asks. It has been tried on one real demo video, four still images and synthetic scenes, in Chromium. Details and limits: [BROWSER_VERSION.md](BROWSER_VERSION.md).

---

## 14. Update: the browser page follows mood changes, exports video, and falls back to the whole scene

*Added after the manager asked for the pipeline to be "better and different". All in `video-music/`, all running in the browser.*

**Music follows the video's feelings over time.** The timeline is split into stretches where one feeling dominates. Each stretch gets its own energy-matched track, and the tracks crossfade into each other. If you pick a feeling by hand, it collapses to a single track.

**Export video.** A button records the video with its full soundtrack and downloads it as an MP4 (WebM where MP4 is unsupported). The recording is clean of detection outlines, but the credit of the song playing (title, author, licence, link) is drawn along the bottom because the licence requires it; a switch turns it off. It is up to 1080p at 10 Mbps video plus 192 kbps audio, and the file seeks normally in any player. It is a live browser recording, not a studio render, so quality has a ceiling.

**Scene fallback.** If the sphere can't be found reliably, the page reads the whole scene instead — but only when the scene's colors clearly point to one feeling. A snowy blue scene reads Sad; a truly mixed scene still asks you. Picking a feeling by hand, or going back to auto-detect, clears the fallback.

**Energy-matched picking.** Tracks are scored in a shared space of brightness, intensity and energy; the seed picks among the three closest to the feeling's ideal. The same code runs in `server/library.py` and `video-music/library.js`, checked against each other by tests.

**Beat-snapped starts.** Every track's beat positions are pre-measured into the manifest (`features.beats`), and excerpts start on the next beat after the track's opening silence.

---

## 15. Words used in this guide

- **API:** a way for one program to ask another to do something over the internet. Here: "make a soundtrack from this video."
- **Job:** one request being worked on. You get its `id` at once and check back later.
- **Mood:** one of Warm, Calm, Sad, Dynamic. The fourth was called Anger earlier; its id and folder are still `anger`.
- **Sphere / focus:** the glowing glass ball on the robot / the region we read inside it.
- **Overlay:** a picture or video with the selected region drawn on it, so a person can check it.
- **Ambiguous:** the colors don't clearly point to one mood.
- **Heuristic:** a hand-made rule, as opposed to a trained model. Its scores are *not* probabilities.
- **Access key:** the shared password for the server. Keep it out of chat and out of Git.
