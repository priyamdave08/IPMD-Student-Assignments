"""Step 1 of the library check: read every track (tags, hash, features) into a cache. Safe to re-run; it only measures new or changed files.

    python tools/scan_music.py [--library music-library]
"""
import argparse
import hashlib
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import music_features  # noqa: E402

MOODS = ('warm', 'calm', 'sad', 'anger')
AUDIO = ('.mp3', '.wav', '.m4a', '.flac', '.ogg')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def measure(args):
    path, digest = args
    try:
        return digest, {'probe': music_features.probe(path), 'features': music_features.analyze(path)}
    except Exception as e:  # a broken file must not stop the batch
        return digest, {'error': f'{type(e).__name__}: {e}'}


def scan(library):
    library = Path(library)
    cache_path = library / '.features-cache.json'
    cache = json.loads(cache_path.read_text(encoding='utf-8')) if cache_path.exists() else {}
    files = [p for m in MOODS if (library / m).is_dir() for p in sorted((library / m).rglob('*')) if p.suffix.lower() in AUDIO]
    hashed = [(p, sha256(p)) for p in files]
    stale = lambda d: d not in cache or 'error' in cache[d] or 'lufs_10' not in cache[d].get('features', {})       # older cache entries lack the short-excerpt loudness
    todo = [(p, d) for p, d in hashed if stale(d)]
    seen = set()
    todo = [(p, d) for p, d in todo if not (d in seen or seen.add(d))]
    if todo:
        print(f'Measuring {len(todo)} new file(s) ({len(files) - len(todo)} cached)...', flush=True)
        with ProcessPoolExecutor(max_workers=4) as pool:
            for i, (digest, result) in enumerate(pool.map(measure, todo), 1):
                cache[digest] = result
                if i % 10 == 0 or i == len(todo):
                    print(f'  {i}/{len(todo)}', flush=True)
        cache_path.write_text(json.dumps(cache), encoding='utf-8')
    return library, hashed, cache


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--library', default='music-library')
    a = p.parse_args()
    library, hashed, cache = scan(a.library)
    bad = [(p.name, cache[d]['error']) for p, d in hashed if 'error' in cache[d]]
    print(f'{len(hashed)} files, {len(bad)} failed')
    for name, error in bad:
        print('  FAILED', name, error)
