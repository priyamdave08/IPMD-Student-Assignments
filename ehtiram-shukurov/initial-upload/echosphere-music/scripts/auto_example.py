"""Upload a video to POST /v1/soundtracks/auto, follow its stages, and download the results.

    python scripts/auto_example.py video.mp4 --mode robot [--mood warm] [--on-ambiguous best_guess]
    python scripts/auto_example.py video.mp4 --mode focus --focus focus.json

The access key (hosted servers) is read from an environment variable, never from an argument.
"""
import argparse
import json
import os
import time
from pathlib import Path
import httpx


def main():
    p = argparse.ArgumentParser()
    p.add_argument('video', type=Path)
    p.add_argument('--mode', choices=['robot', 'sphere', 'focus'], required=True,
                   help='robot: full footage, find the sphere; sphere: the frame is the sphere; focus: you supply coordinates')
    p.add_argument('--focus', type=Path, help='JSON array of focus points (mode=focus)')
    p.add_argument('--mood', default='auto', choices=['auto', 'warm', 'calm', 'sad', 'anger'])
    p.add_argument('--on-ambiguous', default='fail', choices=['fail', 'best_guess'])
    p.add_argument('--engine', default='library', choices=['library', 'composer'],
                   help='library: play a recorded, licensed track; composer: generate with the instrument composer')
    p.add_argument('--seed', type=int, default=42)
    p.add_argument('--url', default='http://127.0.0.1:8765')
    p.add_argument('--key-env', default='ECHOSPHERE_API_KEY')
    p.add_argument('--output', type=Path, default=Path('data/auto-output'))
    a = p.parse_args()
    a.output.mkdir(parents=True, exist_ok=True)
    key = os.environ.get(a.key_env, '')
    data = {'input_mode': a.mode, 'mood': a.mood, 'on_ambiguous': a.on_ambiguous, 'engine': a.engine, 'seed': str(a.seed)}
    if a.focus:
        data['focus'] = a.focus.read_text()
    started = time.monotonic()
    with httpx.Client(base_url=a.url, timeout=300, trust_env=False, headers={'Authorization': f'Bearer {key}'} if key else {}) as c:
        with a.video.open('rb') as f:
            r = c.post('/v1/soundtracks/auto', files={'file': (a.video.name, f, 'video/mp4')}, data=data,
                       headers={'Idempotency-Key': f'auto-{a.video.name}-{a.mode}-{a.mood}-{a.seed}-{int(started)}'})
        if r.status_code != 202:
            raise SystemExit(f'Refused ({r.status_code}): {r.json().get("detail", r.text)}')
        job = r.json()
        print(f'Job {job["id"]} accepted after {time.monotonic() - started:.1f}s')
        last = None
        while True:
            s = c.get(job['status_url']).json()
            if s['phase'] != last:
                print(f'  [{time.monotonic() - started:5.1f}s] {s["state"]:9} {s["phase"]}')
                last = s['phase']
            if s['state'] in ('complete', 'failed', 'cancelled'):
                break
            time.sleep(1)
        (a.output / 'result.json').write_text(json.dumps(s, indent=2), encoding='utf-8')
        if s['state'] != 'complete':
            code = (s.get('result') or {}).get('error_code')
            print(f'\n{s["state"].upper()}: {s.get("error")}  (error_code={code})')
            if s.get('detection_url'):
                for name, path in (('detection-sheet.jpg', '/detection/sheet'), ('detection-overlay.mp4', '/detection/overlay')):
                    d = c.get(f'/v1/videos/{s["video_id"]}{path}')
                    if d.status_code == 200:
                        (a.output / name).write_bytes(d.content)
                        print('Saved', a.output / name)
            raise SystemExit(1)
        for name, path in (('soundtrack.wav', f'/v1/soundtracks/{s["id"]}/audio'), ('soundtrack.mp4', f'/v1/soundtracks/{s["id"]}/video')):
            (a.output / name).write_bytes(c.get(path).content)
        if s.get('detection_url'):
            for name, path in (('detection-sheet.jpg', '/detection/sheet'), ('detection-overlay.mp4', '/detection/overlay')):
                (a.output / name).write_bytes(c.get(f'/v1/videos/{s["video_id"]}{path}').content)
        m = s['result']['mood']
        print(f'\nDone in {time.monotonic() - started:.1f}s. Mood {m["used"]} (source: {m["source"]}). Saved to {a.output.resolve()}')
        provenance = s['result']['provenance']
        if provenance.get('track'):
            t = provenance['track']
            print(f'Played: {t["title"]} (a {t["duration"]:.0f} s track, level change {provenance["gain_db"]:+.1f} dB)')
            print(f'Credit: {t["credit"]}. {t["edit_note"]}')
            for warning in provenance['warnings']:
                print('Warning:', warning)


if __name__ == '__main__':
    main()
