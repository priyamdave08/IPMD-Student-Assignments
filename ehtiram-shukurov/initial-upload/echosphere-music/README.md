# EchoSphere Music

A single self-contained web page that turns an emotion — Warm, Calm, Anger, or Sad — into an original piece of instrumental music, expressed through a living sphere of light.

Bring a reference track and either let the page read its mood automatically or pick one yourself; either way, only a handful of musical descriptors (tempo, key, brightness, density) are ever read from the upload. No reference audio is uploaded anywhere or mixed into the output — everything is analyzed locally in your browser, and every note you hear is composed fresh.

## Running it

It's one HTML file with everything embedded — instrument samples included, no build step, no server, no external script dependencies besides Google Fonts. Open `music-page.html` directly in a browser, or visit the deployed page.

## Instrument credits

Instrument recordings from [tonejs-instruments by Nathaniel Brosowsky](https://github.com/nbrosowsky/tonejs-instruments), licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Original sources: piano and violin — VSCO 2 Community Edition (Versilian Studios); cello — flcellogrl (Freesound); electric guitar — Karoryfer. Recordings are sequenced, pitch-shifted, enveloped, and mixed; drums are synthesized. The same credits are embedded in the page itself and in every exported WAV.

## Status

**Start with the [complete guide](docs/GUIDE.md):** what was built, how it works, how to use it and how to test it, in plain language.

- **`music-page.html`** is the standalone music page above (formerly `index.html`, content unchanged). **`index.html`** now just opens the video page `video-music/`, which is what GitHub Pages serves.
- **Video-to-music.** Give it a video of the EchoSphere robot and it finds the sphere, reads its colours to choose a mood, and picks an energy-matched track from the music library, cut to the video's length with a beat-snapped start. The one-call endpoint is `POST /v1/soundtracks/auto`; the older manual route (`video.html`, or `/v1/videos` then `/analysis` then `/v1/soundtracks`) still works.
- **Runs locally** with `python run_local.py` ([Local setup](docs/LOCAL_SETUP.md)), or on a server behind an access key ([Hosting](docs/HOSTING.md), [Oracle guide](docs/DEPLOY_ORACLE.md)). A demo server exists; where it runs and how it is billed is in [Deployment status](docs/DEPLOYMENT_STATUS.md). Its address and key are not published here.
- **Music library.** By default the soundtrack is now a real, licensed recording picked from `music-library/<mood>/` (not generated music). The tracks (Kevin MacLeod, CC BY 4.0, about 500 MB) are included in the repository with their credits; see [Music library](docs/MUSIC_LIBRARY.md) and [music-library/README.md](music-library/README.md). The credits in `music-library/CREDITS.md` must be shown wherever the music is used.
- **Browser edition (no server).** `video-music/` is a page that runs entirely in the browser, so it can live on GitHub Pages: add a video, it finds the sphere, reads the feeling, and plays a matching song from the music library. It follows mood changes over time with crossfaded tracks, and can export the video with its soundtrack as an MP4. See [Browser edition](docs/BROWSER_VERSION.md).
- **API reference:** [API](docs/API.md). **What was tested and what was not:** [Validation](docs/VALIDATION.md).
- **Honest limits:** proven on one demo video and four still images, not on a wide range of real footage; Calm versus Sad is weak; the demo server is temporary and uses one shared key.

No uploaded videos, generated media, model weights or credentials are committed.
