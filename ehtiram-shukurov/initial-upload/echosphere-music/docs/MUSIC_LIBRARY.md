# Music library

The sphere gives a mood. The library turns that mood into a **real recorded track** instead of generating music. This replaces the instrument composer as the default; the composer is still there (`engine=composer`).

Nothing is generated. For each video the system picks one approved track from the folder for the mood, starts it at the beginning (skipping any digital silence), cuts it to the video's length, levels its volume, fades it in and out, and writes the track's credit into the exported files.

## Folder layout

```
music-library/
  warm/  calm/  sad/  anger/     the tracks, sorted by the mood you filed them under (`anger/` is the Dynamic mood: only its name changed)
  manifest.json                  what the server reads. Generated. Tracked in Git.
  CREDITS.md                     the attribution lines the licence requires. Generated. Tracked in Git.
  decisions.json                 YOUR decisions (approve, relabel, remove). Yours to keep.
  licenses.json                  optional: licence terms for sources other than incompetech.com
  decisions-as-saved.json        a copy of your decisions as you saved them, before files were moved
  moves-log.txt                  which files were moved, and the check that none were lost
  _removed/                      duplicates taken out of the library (never deleted, never committed)
  review.html                    the listening page. Generated. Not tracked.
  .features-cache.json           measurement cache. Generated. Not tracked.
```

The audio files **are** in Git (about 500 MB, 76 tracks), because the licence (CC BY 4.0) allows sharing when the credit goes with them, and `CREDITS.md` and `music-library/README.md` travel in the same folder. Only tracks whose licence could be confirmed are committed; an unknown-source file or a duplicate never is. New audio is ignored by default so nothing is published by accident: after the builder confirms a track's licence, add it on purpose with `git add -f music-library/<mood>/<file>`.

Two things to know before merging this to `main`: the size (about 500 MB) stays in the repository's history for good, and GitHub Pages publishes the whole repository, so the tracks would also be downloadable from the site's address (its limit is 1 GB).

## Adding tracks

1. Drop the files into the folder for their mood (`.mp3`, `.wav`, `.m4a`, `.flac` or `.ogg`).
2. Keep the licence information. The builder reads each file's **artist tag**. Kevin MacLeod's tracks (incompetech.com, CC BY 4.0) are recognised automatically. For any other source, add its terms once to `music-library/licenses.json`:
   ```json
   { "artist name exactly as in the file's tags": {
       "license": "CC0 1.0", "source": "pixabay.com", "url": "https://...",
       "credit": "{title} by Artist Name (pixabay.com), CC0 1.0" } }
   ```
   A track whose source cannot be confirmed is **excluded**, never played.
3. Rebuild:
   ```
   .\.venv\Scripts\python.exe tools/build_music_manifest.py
   ```
   It measures new files, checks them, and rewrites the manifest, credits and review page. Re-running is safe and quick (measurements are cached).

## What the automatic check does, and does not do

For every track it measures the **first 60 seconds** (the part that plays): tempo, loudness, brightness, how busy it is, and whether it leans major or minor. It compares each track with the others in the same folder, using two independent methods (nearest average of the folder's tracks, and a valence/arousal quadrant rule that uses no labels).

**It cannot hear "sad" versus "calm".** On the first 80 tracks the measurements agreed with the folders only about half the time (49% and 56%, against 25% by chance). They separate loud, bright, busy tracks (Anger, and some "Warm" ones) from quiet ones well, and separate Warm from Calm and Sad poorly. So they are used for one thing only: a track is **held back for review** when *both* methods name the *same other* mood. That is a safety net for blatant mismatches, not a verification.

- `ok`: no contradiction was measured. **It does not mean anyone listened.**
- `review`: held back until you decide.
- `conflict`: the exact same file sits in two mood folders. Held until you choose one.
- `excluded`: unknown source or licence, a byte-identical copy, or removed by you.

Only `ok` tracks are ever played. Approving a track (or relabelling it) in `decisions.json` makes it `ok` and marks it `listened`.

## Reviewing quickly

Open `music-library/review.html` in a browser (double-click it; audio plays from the same folder). It lists the flagged tracks first, then three random tracks per mood that raised no flag, as a spot-check. Each card plays the first 30 seconds and has buttons: the mood it really is, or **Remove it**. When done, press **Copy decisions** (or **Download decisions.json**) and save the result as `music-library/decisions.json`. Then run `tools/apply_decisions.py` (add `--dry-run` first to see what it would do): it moves each file into the folder you chose, moves removed ones into `_removed/` (nothing is deleted), checks every file's fingerprint before and after, and rewrites `decisions.json` for the new paths. Finally rebuild with `tools/build_music_manifest.py`. Decisions survive rebuilds.

`decisions.json` looks like this, and can be edited by hand:

```json
{ "version": 1, "tracks": {
    "warm/Some Track.mp3":  { "approve": true },
    "warm/Other Track.mp3": { "mood": "calm" },
    "anger/Bad Track.mp3":  { "exclude": true, "note": "too soft" } } }
```

## How a track is chosen

- **Mood** comes from the sphere (or from the caller: `mood=calm`).
- Among the approved tracks for that mood, those **long enough** for the video are candidates. If none is long enough, the longest is **looped** and a warning is recorded.
- The pick is a **seeded random choice**: the same video, mood and seed always give the same track; a different seed gives a different one. The seed already includes the video and its analysis, so different videos spread across the library.
- Volume is levelled to **-20 LUFS** (about where the instrument composer sits) by measuring the actual excerpt. The boost is capped at +18 dB and the cut at 12 dB; if a track needs more, the result carries a warning. Individual tracks differ by up to about 30 dB in loudness (the folder medians by about 6 dB), so without this some videos would play far quieter than others.
- The shared finishing step then trims to the exact length, fades in and out, limits peaks and checks the result, exactly as for every other engine.

## Credits and the licence

Kevin MacLeod's music is CC BY 4.0: **commercial use is allowed, but the credit is required** and must be easy to find. The requested form is *Title Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0*. Because tracks are shortened and faded, the credits also say so, as the licence asks.

- Every exported WAV and MP4 carries its track's credit in the file metadata.
- The result page shows the credit next to the player.
- `CREDITS.md` lists every non-excluded track. **The product itself (its site, app or video descriptions) must show these credits.** That part is not automated.
- Terms were read from incompetech.com's FAQ on the date recorded in `CREDITS.md`. Re-check them before launch. Kevin MacLeod also sells a licence that removes the credit requirement.
- Not legal advice.

## Using it

- The automatic endpoint defaults to the library: `POST /v1/soundtracks/auto` (see `API.md`). `engine=composer` keeps the old behaviour. The web page has a "Make the music with" choice.
- If the library is missing, empty, or has no approved track for the requested mood, the request is refused with **409** before anything is stored. If it becomes empty after a job was accepted, the job fails with `error_code = library_empty`.
- `GET /health` (with the key) reports `engines.library` and `library_tracks` (approved tracks per mood).

## The browser page

`video-music/` (see [BROWSER_VERSION.md](BROWSER_VERSION.md)) reads the same `manifest.json` and plays only `eligible` tracks. It also uses the 10 s, 30 s and 60 s loudness the builder measures (`lufs_10`, `lufs_30`, `lufs`) to level each song, so rebuild the manifest after adding tracks.

## Known limits

- **Mood labels are not verified by ear** unless you (or a teammate) reviewed them. Automatic `ok` means "nothing measured contradicts the folder".
- **Warm is the thinnest folder.** Several "Warm" tracks measure as loud, bright and busy, which is not what the product means by Warm (comforting, gently joyful). Review them.
- The excerpt starts on a beat (beat positions are pre-measured into the manifest). It is not aligned to events in the video, and the end is a fade, not a musical ending.
- Only the first 60 seconds of a track were measured, but a 60-second video plays exactly that part, so this matches use.
- The Oracle demo server cannot use the library yet: its container is built without the `music-library` folder (it is in `.dockerignore` and not mounted), so `engine=library` would be refused there. Pulling the repository onto the VM would bring the files, but the container would still need them mounted.

## Commands

```
.\.venv\Scripts\python.exe tools/apply_decisions.py --dry-run   show which files would move to match decisions.json
.\.venv\Scripts\python.exe tools/apply_decisions.py             move them (nothing is deleted)
.\.venv\Scripts\python.exe tools/build_music_manifest.py      build or rebuild the manifest, credits and review page
.\.venv\Scripts\python.exe -m pytest -q tests/test_library.py tests/test_music_manifest.py
```
