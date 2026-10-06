"""Recorded-track engine: pick a track from the mood's library folder and cut it to the video.

The library is a folder of licensed recordings plus a manifest.json written by
tools/build_music_manifest.py. Only tracks the manifest marks `eligible` are ever
played. Nothing is generated: the music is a real recording, trimmed from its start
(minus any digital silence) to the video's length, levelled to a common loudness, and
faded by the same finishing step every engine goes through. The track's credit line is
written into the audio's metadata so it travels with every exported WAV and MP4.
"""
import json
import math
from . import auto, config, media

MOODS = ('warm', 'calm', 'sad', 'anger')
TARGET_LUFS = -20.0          # about where the instrument composer's output sits
MAX_BOOST_DB, MAX_CUT_DB = 18.0, 12.0
END_MARGIN = .5              # a track must outlast the video by this much to avoid looping
EDIT_NOTE = 'Edited: shortened and faded to fit the video.'


class LibraryError(auto.AutoFailure):
    """The library cannot supply a track. `code` is machine readable."""


def load_manifest():
    path = config.LIBRARY_DIR / 'manifest.json'
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def _inside(path):
    try:
        return path.resolve().is_relative_to(config.LIBRARY_DIR.resolve())
    except OSError:
        return False


def playable(manifest=None):
    """Eligible tracks whose files exist inside the library folder."""
    manifest = manifest if manifest is not None else load_manifest()
    found = []
    for t in (manifest or {}).get('tracks', []):
        if t.get('eligible') and t.get('mood') in MOODS:
            path = config.LIBRARY_DIR / t['file']
            if _inside(path) and path.is_file():
                found.append(t)
    return found


def counts():
    out = {m: 0 for m in MOODS}
    for t in playable():
        out[t['mood']] += 1
    return out


def available():
    return any(counts().values())


def _start(track):
    """Skip leading digital silence, but keep a quarter second so a soft attack is not clipped;
    then snap forward to the next beat so the music starts on-beat (when the manifest has beats)."""
    start = max(0.0, float(track.get('features', {}).get('lead_silence_s', 0)) - .25)
    beats = [b for b in ((track.get('features') or {}).get('beats') or [])
             if isinstance(b, (int, float)) and math.isfinite(b)]
    cands = [b for b in beats if b >= start]
    return min(cands) if cands else start


def _hash32(text):
    """FNV-1a with the murmur3 fmix32 final mix, bit-identical to EchoLibrary.hash32
    in video-music/library.js (which JavaScript's 32-bit ops define). Kept in sync
    deliberately: the same seed must pick the same track on the server and in the
    browser. Only defined over BMP characters, like JS charCodeAt; seeds are ASCII."""
    h = 2166136261
    for ch in text:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    h ^= h >> 16
    h = (h * 2246822507) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 3266489909) & 0xFFFFFFFF
    h ^= h >> 16
    return h & 0xFFFFFFFF


# Feature order mirrors tools/build_music_manifest.py FEATURES.
_AFFECT_FEATURES = ('onset_rate', 'rms_db', 'centroid_hz', 'low_ratio', 'flux_mean',
                    'mode_margin', 'dynamic_range_db', 'tempo_bpm', 'pulse_clarity')

# Ideal (valence, arousal, energy) per mood, in library-relative z-space. Tuned by ear, not physics;
# keep in sync with MOOD_TARGETS in video-music/library.js.
_MOOD_TARGETS = {'warm': (1.0, 1.0, 0.8), 'calm': (1.0, -1.0, -0.8),
                 'sad': (-1.0, -1.0, -0.8), 'anger': (-1.0, 1.0, 1.0)}

# How many of the closest fits the seed may choose among; the rest never play for this mood.
_SHORTLIST = 3


def _has_affect(track):
    f = track.get('features') or {}
    return all(isinstance(f.get(k), (int, float)) and math.isfinite(f[k]) for k in _AFFECT_FEATURES)


def _vector(features):
    """Raw feature vector; mirrors _vector() in tools/build_music_manifest.py (log on centroid and flux)."""
    return [features['onset_rate'], features['rms_db'], math.log(features['centroid_hz']), features['low_ratio'],
            math.log(features['flux_mean'] + 1), features['mode_margin'], features['dynamic_range_db'],
            features['tempo_bpm'], features['pulse_clarity']]


def _affect_stats(tracks):
    """Per-feature (mean, population std) over the eligible library, in id order.
    Sequential sums, exactly like the browser, so both sides agree bit-for-bit."""
    vecs = [_vector(t['features']) for t in tracks if _has_affect(t)]
    if not vecs:
        return None
    stats = []
    for i in range(len(_AFFECT_FEATURES)):
        mean = sum(v[i] for v in vecs) / len(vecs)
        var = sum((v[i] - mean) ** 2 for v in vecs) / len(vecs)
        stats.append((mean, math.sqrt(var)))
    return stats


def _affect(track, stats):
    """(valence, arousal, energy) in library-relative z-space. Valence and arousal mirror
    judge() in tools/build_music_manifest.py; energy is sheer intensity (loudness + range + tempo)."""
    z = [(x - mean) / std if std > 1e-9 else 0.0 for x, (mean, std) in zip(_vector(track['features']), stats)]
    return z[5] + .3 * z[2], (z[0] + z[1] + z[2] + z[4] + .5 * z[7]) / 4.5, (z[1] + z[6] + z[7]) / 3


def _ranked(use, mood, stats):
    """Candidates as (distance, track) pairs, closest fit first, ties broken by id.
    None when any candidate lacks measured features: the choice then stays uniform."""
    if stats is None or any(not _has_affect(t) for t in use):
        return None
    target = _MOOD_TARGETS[mood]
    scored = []
    for t in use:
        va, ar, en = _affect(t, stats)
        d = math.sqrt((va - target[0]) ** 2 + (ar - target[1]) ** 2 + (en - target[2]) ** 2)
        scored.append((d, t['id'], t))
    scored.sort(key=lambda s: (s[0], s[1]))
    return [(d, t) for d, _, t in scored]


def choose(mood, duration, seed):
    """Repeatable pick: the same mood, video length and seed always give the same track.

    When every candidate has measured audio features, the seed picks among the closest
    (valence, arousal, energy) fits for the mood instead of uniformly at random."""
    eligible = sorted(playable(), key=lambda t: t['id'])
    pool = [t for t in eligible if t['mood'] == mood]
    if not pool:
        raise LibraryError('library_empty', f'The music library has no approved {mood} tracks. Add some and rebuild the manifest (docs/MUSIC_LIBRARY.md).',
                           {'mood': mood, 'library': counts()})
    fits = [t for t in pool if t['duration'] - _start(t) >= duration + END_MARGIN]
    use = fits or [max(pool, key=lambda t: t['duration'] - _start(t))]
    ranked = _ranked(use, mood, _affect_stats(eligible))
    if ranked is None:
        pick = use[_hash32(f'{seed}|{mood}') % len(use)]
        return pick, {'method': 'seeded random choice among approved tracks long enough for the video', 'candidates': len(pool),
                      'long_enough': len(fits), 'looped': not fits}
    shortlist = ranked[:_SHORTLIST]
    distance, pick = shortlist[_hash32(f'{seed}|{mood}') % len(shortlist)]
    return pick, {'method': 'seeded pick among the closest (valence, arousal, energy) fits for the mood', 'candidates': len(pool),
                  'long_enough': len(fits), 'looped': not fits, 'fit_distance': round(distance, 3)}


def credit_of(track):
    return track.get('credit') or f"{track['title']} ({track.get('license') or 'licence not recorded'})"


def render(brief, folder, check):
    """Write folder/raw.wav (>= the video's length) and return provenance. The shared finishing step does the rest."""
    mood, duration = brief['mood'], brief['duration']
    track, how = choose(mood, duration, brief['seed'])
    source = config.LIBRARY_DIR / track['file']
    start = _start(track)
    cut = folder / 'library-cut.wav'
    args = ['ffmpeg', '-v', 'error', '-y']
    if how['looped']:
        args += ['-stream_loop', '-1']
    args += ['-ss', f'{start:.3f}', '-i', str(source), '-t', f'{duration + .25:.3f}', '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', str(cut)]
    media.run(args, 180, check)
    warnings = []
    if how['looped']:
        warnings.append(f"No approved {mood} track was long enough, so the longest one was looped; listen for the seam.")
    try:
        lufs = media.measure_loudness(cut)['integrated_lufs']
        wanted = TARGET_LUFS - lufs
        gain = max(-MAX_CUT_DB, min(MAX_BOOST_DB, wanted))
        if gain != wanted:
            warnings.append(f'This excerpt is {abs(wanted):.0f} dB away from the target level, more than the {abs(gain):.0f} dB limit, so it will play '
                            f"{'quieter' if wanted > 0 else 'louder'} than other tracks.")
    except Exception:
        lufs, gain = None, 0.0
        warnings.append('Loudness could not be measured, so the track was used at its original level.')
    credit = f'{credit_of(track)}. {EDIT_NOTE}'
    media.run(['ffmpeg', '-v', 'error', '-y', '-i', str(cut), '-af', f'volume={gain:.2f}dB', '-metadata', f"title={track['title']}",
               '-metadata', f"artist={track.get('artist') or ''}", '-metadata', f"copyright={track.get('license') or ''}", '-metadata', f'comment={credit}',
               '-c:a', 'pcm_s16le', str(folder / 'raw.wav')], 120, check)
    cut.unlink(missing_ok=True)
    return {'engine': 'library', 'version': 'library-v1',
            'track': {'id': track['id'], 'title': track['title'], 'artist': track.get('artist'), 'source': track.get('source'),
                      'license': track.get('license'), 'license_url': track.get('license_url'), 'credit': credit_of(track), 'edit_note': EDIT_NOTE,
                      'duration': track['duration'], 'listened': bool(track.get('listened'))},
            'selection': {**how, 'seed': brief['seed'], 'mood': mood, 'start_seconds': round(start, 2)},
            'measured_lufs': lufs, 'gain_db': round(gain, 2), 'target_lufs': TARGET_LUFS, 'warnings': warnings}
