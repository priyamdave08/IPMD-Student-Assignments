"""Move the music files so the folders match music-library/decisions.json. Nothing is ever deleted.

    python tools/apply_decisions.py --dry-run     show what would move
    python tools/apply_decisions.py               do it

- {"mood": "calm"}    the file moves into the calm folder, and is recorded as approved there
- {"exclude": true}   the file moves into music-library/_removed/<old folder>/ (out of the library, still on disk)
- {"approve": true}   stays where it is

Every file's SHA-256 is recorded before and checked after, so a lost or altered file is caught. The decisions as
you saved them are kept in decisions-as-saved.json, and every move is logged in moves-log.txt.
"""
import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

MOODS = ('warm', 'calm', 'sad', 'anger')
AUDIO = ('.mp3', '.wav', '.m4a', '.flac', '.ogg')


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def library_files(lib):
    return sorted(p for m in (*MOODS, '_removed') if (lib / m).is_dir() for p in (lib / m).rglob('*') if p.suffix.lower() in AUDIO)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--library', default='music-library')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    lib = Path(a.library)
    decisions = json.loads((lib / 'decisions.json').read_text(encoding='utf-8')).get('tracks', {})
    moves, problems = [], []
    for rel, d in sorted(decisions.items()):
        src = lib / rel
        if not src.is_file():
            continue
        folder = rel.split('/')[0]
        if d.get('exclude'):
            moves.append((rel, f'_removed/{rel}', 'removed'))
        elif d.get('mood') in MOODS and d['mood'] != folder:
            moves.append((rel, f"{d['mood']}/{src.name}", 'relabelled'))
    for src, dest, _ in moves:
        if (lib / dest).exists():
            problems.append(f'{dest} already exists, so {src} was not moved.')
    for problem in problems:
        print('PROBLEM:', problem)
    print(f"{'Would move' if a.dry_run else 'Moving'} {len(moves)} file(s):")
    for src, dest, kind in moves:
        print(f'  {kind:10} {src}  ->  {dest}')
    if problems:
        sys.exit('Nothing was moved.')
    if a.dry_run or not moves:
        return
    before = {p.relative_to(lib).as_posix(): sha(p) for p in library_files(lib)}
    log = []
    for src, dest, kind in moves:
        (lib / dest).parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(lib / src), str(lib / dest))
        log.append(f'{kind}: {src} -> {dest}  sha256 {before[src][:16]}')
    after = {p.relative_to(lib).as_posix(): sha(p) for p in library_files(lib)}
    expected = {dest_of: before[src_of] for src_of, dest_of in ((m[0], m[1]) for m in moves)}
    moved_sources = {m[0] for m in moves}
    wrong = []
    if len(after) != len(before):
        wrong.append(f'file count changed: {len(before)} before, {len(after)} after')
    if sorted(before.values()) != sorted(after.values()):
        wrong.append('the set of file fingerprints changed')
    for dest, digest in expected.items():
        if after.get(dest) != digest:
            wrong.append(f'{dest} is missing or changed')
    for rel, digest in before.items():
        if rel not in moved_sources and after.get(rel) != digest:
            wrong.append(f'{rel} is missing or changed')
    if wrong:
        print('VERIFICATION FAILED:')
        for w in wrong:
            print('  ', w)
        sys.exit('Check music-library/moves-log.txt and _removed before doing anything else.')
    # The decisions were about the old paths. Record them, then rewrite them for the new places.
    (lib / 'decisions-as-saved.json').write_text(json.dumps({'version': 1, 'tracks': decisions}, indent=2, ensure_ascii=False), encoding='utf-8')
    by_src = {m[0]: m for m in moves}
    rewritten = {}
    for rel, d in decisions.items():
        m = by_src.get(rel)
        if not m:
            rewritten[rel] = d
        elif m[2] == 'relabelled':
            rewritten[m[1]] = {'approve': True}
    (lib / 'decisions.json').write_text(json.dumps({'version': 1, 'tracks': rewritten}, indent=2, ensure_ascii=False), encoding='utf-8')
    header = f'Moves applied {datetime.now():%Y-%m-%d %H:%M}. Nothing was deleted. {len(before)} audio files before and after; every fingerprint verified.\n'
    (lib / 'moves-log.txt').write_text(header + '\n'.join(log) + '\n', encoding='utf-8')
    print(f'Done. {len(before)} files before, {len(after)} after, all fingerprints verified. Log: {lib / "moves-log.txt"}')


if __name__ == '__main__':
    main()
