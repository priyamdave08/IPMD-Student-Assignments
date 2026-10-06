# Handover: EchoSphere video-to-music

Written 5 October 2026 so someone else can continue the music project. Read this first, then `BROWSER_VERSION.md`.

## What it is

A web page that runs entirely in the browser. You add a video of the EchoSphere robot. The page finds the sphere, reads the colour of its light, decides the mood (Warm, Calm, Sad or Dynamic), picks a matching song from `music-library/`, and plays it with the video. You can download the song or export the video with the song in it (the song's credit is drawn into the picture). Nothing is uploaded. There is no server and no cloud.

- Live page: https://ehtiram-shukurov.github.io/echosphere-music/
- Repository: https://github.com/Ehtiram-Shukurov/echosphere-music
- The page is published by GitHub Pages from `main`. A push shows up on the site in one or two minutes.

## The four moods

Warm, Calm, Sad and **Dynamic**. Dynamic was called Anger earlier in the project. Only the name people see changed: its internal id and its song folder are still `anger`, so the manifest, the tests and the API keep working. The display name is set in `video-music/app.js` (`NAMES`), `video-music/index.html`, and `DISPLAY` in `tools/build_music_manifest.py`. Renaming the id and folder too is possible but touches the manifest, the song-choice hash (which would change which song is picked) and the parity fixtures in `tests/fixtures/choose-parity.json`.

## Run it on your computer

```
python scripts/preview_site.py          then open http://127.0.0.1:8000/video-music/
node --test tests/js/*.test.mjs         JavaScript tests
python -m pytest                        all tests (needs the songs, Chromium for Playwright and ffmpeg)
```

Open the page from a web address, not by double-clicking the file. Python's plain `http.server` cannot seek inside audio, so use `scripts/preview_site.py`.

## Where things are

| Path | What it does |
|---|---|
| `video-music/detect.js` | Finds and follows the sphere (port of `server/detect.py`) |
| `video-music/mood.js` | Colour to mood rule (gold Warm, violet Calm, blue Sad, red or orange Dynamic) |
| `video-music/library.js` | Chooses songs from the manifest: energy matching, beat-aligned start, levelling, per-part playlist |
| `video-music/app.js` | The page: reading, timeline, playback, crossfades, export |
| `music-library/` | 76 songs by Kevin MacLeod in four folders, `manifest.json`, `CREDITS.md` |
| `tools/` | Builds the manifest and the review page, applies listening decisions |
| `server/`, `deploy/` | The earlier server version (API, Oracle VM). Not needed for the page |
| `music-page.html` | The earlier standalone page that composes music. Unchanged |

## Music and licence

All songs are CC BY 4.0 (commercial use allowed, credit required). The page shows the credit under the song, and the exported video carries it in the picture. Keep both. After adding or reviewing songs, rebuild the manifest with `python tools/build_music_manifest.py`, then check how many songs are approved: the automatic mood check compares tracks with the rest of the library, so a rebuild can move a track in or out of "approved". See `MUSIC_LIBRARY.md`.

Two songs are held for a listening review and cannot be played yet: `calm/Adeste Fideles Shorter` and `warm/Sleep_and_Then`. 74 of the 76 songs are approved (Warm 15, Calm 21, Sad 19, Dynamic 19).

## Open points, in the order I would do them

1. **More real robot footage.** The sphere finder and the colour rule were checked on one real demo video, four stills and synthetic clips. Videos of each mood, especially Calm and Sad, are needed. Only a few were available.
2. **Calm versus Sad.** Violet and blue sit next to each other, so they are confused. The page asks when the light is mixed, but a Calm video can still read as Sad.
3. **A video that changes mood.** When the overall light is clearly one mood, each part of the video gets its own song. When two moods are about equal, the page asks for one feeling and ignores the timeline. It could use the timeline instead.
4. **Whole video or find the sphere.** The team described two modes. Today the sphere is found automatically, and if no sphere is found but the scene has a clear colour, the whole scene is read. There is no up-front choice, and no way to say "the whole video is the sphere" before adding the video.
5. **Use from another repository.** The logic is spread through `app.js`. A small module (video in, mood and song out) would let other code call it. The input and output formats were never confirmed.
6. **Export format.** The export is recorded in the browser. Some browsers write an `.mp4` that holds VP9 video and Opus audio, which some players cannot open. Check an export in the players that matter.
7. **Listen to the songs against real videos.** A person has not done this yet.

## Tests

All tests pass: 30 JavaScript tests and the Python suite (browser tests with synthetic videos, library and manifest tests). No product footage is stored in the repository. The tests for the sphere finder use generated scenes.

## The earlier server version

`server/` and `deploy/` are the API version that ran on an Oracle Cloud virtual machine (`DEPLOYMENT_STATUS.md`, `DEPLOY_ORACLE.md`). The team later asked for GitHub only, so it is not used. If that virtual machine still exists, stop or delete it so it does not use credit.
