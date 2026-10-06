"""The library builder: duplicates, unknown sources, conflicts and your decisions."""
import json
import shutil
import subprocess
import sys
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import build_music_manifest as builder  # noqa: E402


def tone(path, freq, artist='Kevin MacLeod', title=None, seconds=6):
    path.parent.mkdir(parents=True, exist_ok=True)
    args = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={freq}:duration={seconds}', '-af', 'volume=-20dB', '-ar', '44100']
    if artist:
        args += ['-metadata', f'artist={artist}']
    if title:
        args += ['-metadata', f'title={title}']
    subprocess.run(args + [str(path)], check=True)


@pytest.fixture(scope='module')
def base(tmp_path_factory):
    """Two tracks per mood, plus every special case."""
    root = tmp_path_factory.mktemp('lib') / 'music-library'
    for i, mood in enumerate(builder.MOODS):
        for j in range(2):
            tone(root / mood / f'{mood}-{j}.wav', 200 + 60 * i + 25 * j, title=f'{mood} {j}')
    shutil.copy(root / 'warm' / 'warm-0.wav', root / 'warm' / 'warm-0 (1).wav')            # same-folder copy
    shutil.copy(root / 'sad' / 'sad-0.wav', root / 'calm' / 'shared.wav')                  # the same file in two folders...
    shutil.copy(root / 'sad' / 'sad-0.wav', root / 'sad' / 'shared.wav')                   # ...so it is a conflict
    tone(root / 'anger' / 'mystery.wav', 777, artist=None)                                # no artist tag: source unknown
    tone(root / 'calm' / 'other-artist.wav', 555, artist='Somebody Else')                 # not a licence we know
    return root


def rebuild(root):
    return {t['id']: t for t in builder.build(root)[1]}


def test_duplicates_conflicts_and_unknown_sources(base):
    t = rebuild(base)
    assert t['warm/warm-0 (1).wav']['status'] == 'excluded' and 'Byte-identical copy' in t['warm/warm-0 (1).wav']['reasons'][0]
    assert t['warm/warm-0.wav']['status'] != 'excluded'
    assert t['calm/shared.wav']['status'] == t['sad/shared.wav']['status'] == 'conflict'
    assert not t['calm/shared.wav']['eligible']
    assert t['anger/mystery.wav']['status'] == 'excluded' and 'could not be confirmed' in t['anger/mystery.wav']['reasons'][0]
    assert 'no artist tag' in t['anger/mystery.wav']['license_evidence'] and 'Somebody Else' in t['calm/other-artist.wav']['license_evidence']
    assert t['calm/other-artist.wav']['status'] == 'excluded'
    known = t['warm/warm-0.wav']
    assert known['license'] == 'CC BY 4.0' and known['credit'].startswith('warm 0 Kevin MacLeod (incompetech.com)')


def test_choosing_a_mood_for_a_duplicate_resolves_the_conflict(base):
    (base / 'decisions.json').write_text(json.dumps({'version': 1, 'tracks': {'sad/shared.wav': {'approve': True}}}))
    try:
        t = rebuild(base)
        assert t['sad/shared.wav']['status'] == 'ok' and t['sad/shared.wav']['listened']
        assert t['calm/shared.wav']['status'] == 'excluded' and 'you chose sad/shared.wav' in t['calm/shared.wav']['reasons'][0]
    finally:
        (base / 'decisions.json').unlink()


def test_relabel_and_remove_decisions(base):
    (base / 'decisions.json').write_text(json.dumps({'version': 1, 'tracks': {
        'warm/warm-1.wav': {'mood': 'calm'}, 'anger/anger-1.wav': {'exclude': True, 'note': 'too soft'}}}))
    try:
        t = rebuild(base)
        assert t['warm/warm-1.wav']['mood'] == 'calm' and t['warm/warm-1.wav']['folder'] == 'warm' and t['warm/warm-1.wav']['listened']
        assert t['anger/anger-1.wav']['status'] == 'excluded' and 'too soft' in t['anger/anger-1.wav']['reasons'][0]
    finally:
        (base / 'decisions.json').unlink()


def test_outputs_are_written_and_only_eligible_tracks_are_marked_playable(base):
    library, tracks = builder.build(base)
    manifest = builder.write_manifest(library, tracks)
    builder.write_credits(library, tracks)
    cards, spot = builder.write_review(library, tracks)
    assert json.loads((base / 'manifest.json').read_text())['tracks']
    assert all(t['eligible'] == (t['status'] == 'ok') for t in manifest['tracks'])
    credits = (base / 'CREDITS.md').read_text()
    assert 'By Attribution 4.0' in credits and 'Edited: shortened and faded' in credits
    assert 'mystery' not in credits and 'Somebody Else' not in credits           # excluded tracks are not credited
    page = (base / 'review.html').read_text()
    assert 'shared.wav' in page and cards >= 1 and 'Copy decisions' in page


def test_recording_another_sources_terms_makes_its_tracks_usable_and_credited(base):
    (base / 'licenses.json').write_text(json.dumps({'somebody else': {'license': 'CC0 1.0', 'source': 'example.org', 'url': 'https://example.org/cc0',
                                                                       'credit': '{title} by Somebody Else (example.org), CC0 1.0'}}))
    try:
        t = rebuild(base)['calm/other-artist.wav']
        assert t['status'] != 'excluded' and t['license'] == 'CC0 1.0'
        assert t['credit'].endswith('by Somebody Else (example.org), CC0 1.0') and 'you supplied those terms' in t['license_evidence']
    finally:
        (base / 'licenses.json').unlink()


def test_beats_find_the_onset_grid():
    import numpy as np
    from music_features import _beats
    flux = np.random.RandomState(0).rand(1000) * 0.01
    flux[5::22] = 10.0                                        # strong onsets every 22 frames (~120 bpm)
    beats = _beats(flux, 120)
    assert beats[:3] == [0.116, 0.627, 1.138]
    assert all(b2 > b1 for b1, b2 in zip(beats, beats[1:])) and len(beats) > 40
    assert _beats(np.zeros(10), 120) == [] and _beats(flux, 0) == []
