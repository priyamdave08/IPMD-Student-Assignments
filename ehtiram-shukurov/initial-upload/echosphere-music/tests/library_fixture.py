"""A tiny music library of sine-tone tracks with a hand-written manifest, for tests."""
import json
import subprocess
from pathlib import Path


def make_library(root, durations=(14, 14, 5), levels=(8, -8, 0)):
    """Per mood: three eligible tracks (loud, quiet, and one too short for a 10 s video) plus one
    ineligible track that must never be played. Returns the library folder."""
    root = Path(root)
    base = {'warm': 330, 'calm': 262, 'sad': 220, 'anger': 440}
    tracks = []
    for mood, freq in base.items():
        (root / mood).mkdir(parents=True, exist_ok=True)
        specs = [(f'{mood}-{i}', dur, level, True) for i, (dur, level) in enumerate(zip(durations, levels))] + [(f'{mood}-held', 14, -20, False)]
        for i, (name, dur, level, eligible) in enumerate(specs):
            rel = f'{mood}/{name}.wav'
            title = f'{mood.title()} {name.split("-")[1]}'
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={freq + 20 * i}:duration={dur}', '-af', f'volume={level}dB',
                            '-ar', '44100', '-ac', '2', '-metadata', 'artist=Kevin MacLeod', '-metadata', f'title={title}', str(root / rel)], check=True)
            tracks.append({'id': rel, 'file': rel, 'title': title, 'folder': mood, 'mood': mood, 'duration': float(dur), 'artist': 'Kevin MacLeod',
                           'license': 'CC BY 4.0', 'source': 'incompetech.com', 'license_url': 'https://creativecommons.org/licenses/by/4.0/',
                           'credit': f'{title} Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0',
                           'features': {'lead_silence_s': 0.0}, 'status': 'ok' if eligible else 'review', 'eligible': eligible, 'listened': False})
    (root / 'manifest.json').write_text(json.dumps({'version': 1, 'tracks': tracks}), encoding='utf-8')
    return root
