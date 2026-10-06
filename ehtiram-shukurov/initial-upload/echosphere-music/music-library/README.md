# Music library

Recorded tracks the system plays for a mood: `warm/`, `calm/`, `sad/`, `anger/`. The `anger/` folder is the Dynamic mood: it was renamed for display only, so its id and folder stay `anger`.

## These tracks are not covered by this repository's code licence

The music is by **Kevin MacLeod (incompetech.com)** and is licensed under **Creative Commons: By Attribution 4.0** (https://creativecommons.org/licenses/by/4.0/). You may use and share it, including commercially, **as long as you credit it**. The required credit for every track is in [CREDITS.md](CREDITS.md). The files are included here unchanged; when the system plays them it shortens and fades them, and says so.

Only tracks whose source and licence could be confirmed are in this repository. A track with an unknown source, or an exact duplicate of another, is left out. To add music from another source, record its licence terms in `licenses.json` first (see [docs/MUSIC_LIBRARY.md](../docs/MUSIC_LIBRARY.md)).

## What is here

| File | What it is |
|---|---|
| `warm/ calm/ sad/ anger/` | The tracks, filed by mood after a person's review |
| `manifest.json` | What the server reads: each track's credit, length, measurements and whether it may be played |
| `CREDITS.md` | The credit lines that must be shown wherever the music is used |
| `decisions.json` | The mood decisions made in review |
| `decisions-as-saved.json`, `moves-log.txt` | A record of the review and of which files were moved |

Generated locally and not kept in Git: `review.html`, `.features-cache.json`, and a `_removed/` folder holding duplicates that were taken out of the library.
