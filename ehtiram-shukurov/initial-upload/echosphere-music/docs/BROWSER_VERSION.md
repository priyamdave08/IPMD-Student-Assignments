# The browser edition (`video-music/`)

A page that runs entirely in the visitor's browser, so it can be hosted on GitHub Pages with **no server, no API and no cloud**. You add a video of the EchoSphere robot. The page finds the sphere, reads a feeling from its light, and plays a song from `music-library/` that matches.

Address (live since the merge into `main`; the site root redirects here): `https://ehtiram-shukurov.github.io/echosphere-music/video-music/`

Locally: from the repository root run `python scripts/preview_site.py` and open `http://127.0.0.1:8000/video-music/`. (A web address is required: the page cannot fetch the song list from a double-clicked file. Python's plain `http.server` cannot seek inside audio, so use this script, which behaves like GitHub Pages.)

## What a visitor does

1. **Add a video.** Drop it on the page or choose it. It is opened in the browser and **never uploaded**.
2. **Watch it being read.** The page looks through the video, finds and follows the sphere, then reads the colour of the light inside it. A green outline over the video shows exactly what was read, so you can see it chose the sphere and not the robot's face.
3. **Confirm the feeling.** If the light clearly points to one feeling (gold is Warm, violet is Calm, blue is Sad, red or orange is Dynamic) it is chosen for you. If it is mixed, the page says so and asks. You can change the feeling at any time.
4. **Hear the song.** A song from that feeling's folder is chosen, matched to the video's energy and length. Play them together, jump around in the video, ask for another song, or download the song. The credit for the song is shown under it.
5. **Follow mood changes.** If the feeling changes during the video (warm light, then sad light), the music changes with it: each stretch gets its own energy-matched song, crossfaded together.
6. **Export the video.** Download an MP4 of your video with the full soundtrack baked in: clean picture (no outlines), up to 1080p, with music that fades in and out. The credit for the song playing is drawn along the bottom of the picture, because CC BY 4.0 requires it. A switch under the buttons turns it off; keep it on unless you credit the music another way.

If the sphere cannot be found reliably, the page falls back to reading the whole scene — but only if the scene's colors clearly point to one feeling. Otherwise it says why and lets you mark the sphere yourself by dragging from its middle to its edge (or "the whole picture is the sphere" for a sphere-only video).

## How it works

| Step | Code | What it does |
|---|---|---|
| Read frames | `app.js` | Samples about five frames per second (at most 100) from a hidden copy of the video, scaled to 320 pixels on the long side. |
| Find the sphere | `detect.js` | A port of `server/detect.py`. Circle candidates from edge votes and coloured regions are scored on a rim, a lit and textured coloured interior, contrast with the body, and not being a dark screen; they are refined, then linked across frames by dynamic programming and smoothed. It reports how much of the video it followed and an uncertainty index, and **rejects** an unreliable selection. |
| Read the feeling | `mood.js` | A port of the palette rule in `server/analysis.py`, run over the light inside the tracked sphere. Shares are relative, **not probabilities**. |
| Choose a song | `library.js` | The same rules as `server/library.py`: only approved songs, long enough for the video, repeatable pick, another song on request. The pick is **energy-matched**: each song is scored by how close its feel (brightness, intensity, energy) is to the feeling's ideal, and the song starts on a beat, not at its beginning. |
| Follow mood changes | `app.js` | The video's timeline is split into stretches of one feeling. Each stretch gets its own energy-matched song; songs crossfade into each other. Picking a feeling by hand collapses this to one song. |
| Play | `app.js` | Video (muted; its own sound is never used) and song start together and are kept within about half a second. The song is levelled to about -20 LUFS using the loudness measured for the stretch that plays, limited so it cannot clip, and faded in and out. The animated sphere reacts to the real audio. |
| Export video | `app.js` | Records the video with the soundtrack mixed in, as an MP4 download (WebM where MP4 is not supported). Clean picture with no outlines, up to 1080p at 10 Mbps video and 192 kbps audio. The credit of the song playing (title, author, licence and link) is drawn along the bottom, and changes when the song changes. The file is a normal video: it seeks and plays anywhere. |

Nothing is a trained model. The sphere finder and the colour rule are hand-made heuristics, and they can be wrong.

## Where it differs from the Python version

The port was checked against the Python code (see `VALIDATION.md`), but it is not identical:

- **Circle candidates.** OpenCV's circle search is replaced by an equivalent search along edge normals written for the browser.
- **Rival test.** Circles that overlap each other are treated as one object (a textured glass ball produces several), and only a separate object elsewhere counts as a rival. The Python version measures distance between centres.
- **Calm versus Sad asks earlier.** The server calls a reading "mixed" when the second of Calm/Sad has a share above 0.22. That sat on the edge of what the Calm sample measured (0.22 to 0.26, depending on video compression), so this page uses 0.16. A wrong question costs one click; a silently wrong feeling costs the whole song. `mood.js` explains it.
- The path is used directly instead of being reduced to at most 16 keypoints.

## Songs and credits

The fourth mood is called **Dynamic**. Its internal id and its folder are still `anger` (so files, the manifest and the API keep working); only the name people see changed.

The page reads `music-library/manifest.json` (built by `tools/build_music_manifest.py`) and plays only tracks marked `eligible`. After adding or reviewing songs, rebuild the manifest so the page sees them. Songs are by Kevin MacLeod (incompetech.com), CC BY 4.0: the credit is shown under the song and in *Credits & about*, and must stay visible. The page says the songs are shortened and faded.

## Tests

```
node --test tests/js/*.test.mjs                       JavaScript unit tests (mood, detector, song picking)
.\.venv\Scripts\python.exe -m pytest tests/test_video_music_page.py tests/test_browser_logic.py
```

- `tests/js/` (30 tests): the colour rule against the Python one on the same pixels; the detector on a synthetic robot scene with a dark face, a fireplace, a lamp and a zooming, panning camera; a scene with no sphere; song picking, levelling and fades; energy-matched picking agreeing between the Python and JavaScript versions; beat grids present for every track in the manifest; and a check that **every playable song in the real manifest exists, is credited and licensed, and that every feeling can serve both a 10 s and a 60 s video without looping.**
- `tests/test_video_music_page.py` (8 tests): the real page in headless Chromium, with synthetic videos and a static server that supports range requests like GitHub Pages: reading a warm video, playing with the song staying within half a second of the video (including after a seek), another song and a different feeling, a blue/violet mixture asking instead of guessing, marking the sphere by hand when none is found, a file that is not a video, and a phone-sized screen without sideways scrolling. No product footage is used.

## Known limits

- **Validated on one real demo video and four still images, plus synthetic scenes.** It has not been tried on other real robot footage, a partly hidden sphere, or a second glowing object in the frame.
- **Calm versus Sad is still the weak spot.** The page asks when they mix, but a Calm video can still be read as Sad.
- **Browsers.** Tested in Chromium (desktop and phone-sized). The Chromium used by the automated tests cannot decode H.264, so they use WebM; H.264 MP4 was checked by hand in a desktop browser. Firefox and Safari were not tested. A video the browser cannot decode gives a clear message.
- **Speed.** About 6 to 20 seconds for a 10 second clip on a laptop, mostly finding the frames; longer videos take longer (at most 100 frames are read). The page stays usable while it works.
- **Memory.** About 25 MB of frames for a long video; nothing is sent anywhere.
- **The song starts on a beat** near its beginning (beat positions are pre-measured for every track), then ends with a fade, not a musical ending; it is not aligned to what happens in the video.
- **Export is a live recording**, not a studio render: quality tops out at 1080p / 10 Mbps, and very long videos make large files.
- **Very long videos** need a song at least as long; otherwise the song repeats (the page says so).
