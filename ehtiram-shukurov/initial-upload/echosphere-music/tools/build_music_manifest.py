"""Build the music library's manifest, credits and review page from its folders.

    python tools/build_music_manifest.py [--library music-library]

Reads music-library/{warm,calm,sad,anger}/*.mp3, measures each track, checks the licence
evidence and the mood label, and writes:
  manifest.json   what the server reads (only tracks marked "eligible" are ever played)
  CREDITS.md      the attribution lines that must ship with the product
  review.html     a page for listening to the few tracks that need a person, with one-click decisions

Your decisions live in music-library/decisions.json and survive a rebuild.

What the automatic mood check is, and is not: two independent, crude checks (tempo, loudness,
brightness, major/minor lean). A track is held for review only when BOTH name the same OTHER
mood. That catches blatant mismatches. It cannot hear "sad" versus "calm", and "ok" means
"no contradiction measured", not "listened to".
"""
import argparse
import html
import json
import math
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path
from urllib.parse import quote

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scan_music  # noqa: E402

MOODS = scan_music.MOODS
TARGET_LUFS = -20.0
DISPLAY = {'anger': 'Dynamic'}   # the fourth mood is called Dynamic; its id and folder stay 'anger'
LICENSES = {
    'kevin macleod': {
        'license': 'CC BY 4.0', 'source': 'incompetech.com', 'artist': 'Kevin MacLeod',
        'url': 'https://creativecommons.org/licenses/by/4.0/',
        'credit': '{title} Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0',
    },
}
EDITED = 'Edited: shortened and faded to fit the video.'
FEATURES = ['onset_rate', 'rms_db', 'centroid_hz', 'low_ratio', 'flux_mean', 'mode_margin', 'dynamic_range_db', 'tempo_bpm', 'pulse_clarity']


def _vector(f):
    return np.array([f['onset_rate'], f['rms_db'], math.log(f['centroid_hz']), f['low_ratio'], math.log(f['flux_mean'] + 1),
                     f['mode_margin'], f['dynamic_range_db'], f['tempo_bpm'], f['pulse_clarity']])


def judge(tracks):
    """Fill in `checks` for every track. Uses only tracks with one unambiguous folder to fit."""
    fit = [t for t in tracks if t['fit']]
    if len(fit) < 2:
        for t in tracks:
            t['checks'] = {'centroid_mood': t['folder'], 'quadrant_mood': t['folder'], 'centroid_agrees': True, 'quadrant_agrees': True, 'both_name_other_mood': False}
        return tracks
    X = np.array([_vector(t['features']) for t in fit])
    mean, std = X.mean(0), X.std(0) + 1e-9
    z = lambda t: (_vector(t['features']) - mean) / std
    Z = {id(t): z(t) for t in tracks}
    labels = np.array([MOODS.index(t['folder']) for t in fit])
    for t in tracks:
        others = [i for i, u in enumerate(fit) if u is not t]
        idx = np.array(others, dtype=int)
        members = [[i for i in idx if labels[i] == k] for k in range(4)]
        cents = [np.mean([Z[id(fit[i])] for i in m], axis=0) if m else None for m in members]
        d = np.array([((c - Z[id(t)]) ** 2).sum() if c is not None else np.inf for c in cents])
        centroid_mood = MOODS[int(np.argmin(d))]
        v = Z[id(t)]
        arousal = (v[0] + v[1] + v[2] + v[4] + .5 * v[7]) / 4.5     # onset rate, loudness, brightness, spectral change, tempo
        valence = v[5] + .3 * v[2]                                   # major lean, brightness
        quadrant_mood = 'warm' if valence >= 0 and arousal >= 0 else 'calm' if valence >= 0 else 'sad' if arousal < 0 else 'anger'
        t['checks'] = {'centroid_mood': centroid_mood, 'quadrant_mood': quadrant_mood,
                       'centroid_agrees': centroid_mood == t['folder'], 'quadrant_agrees': quadrant_mood == t['folder'],
                       'both_name_other_mood': centroid_mood == quadrant_mood != t['folder']}
    return tracks


def _title(path, tags):
    title = (tags.get('title') or '').strip()
    if title:
        return title
    stem = path.stem
    return ' '.join(stem.replace('_', ' ').split())


def load_licenses(library):
    """Built-in terms plus any you record in music-library/licenses.json, keyed by the artist name in the file's tags.

    licenses.json example:
      {"some artist": {"license": "CC0 1.0", "source": "pixabay.com", "url": "https://...", "credit": "{title} by Some Artist (pixabay.com), CC0"}}
    """
    table = {k: {**v, 'custom': False} for k, v in LICENSES.items()}
    path = library / 'licenses.json'
    if path.exists():
        for artist, info in json.loads(path.read_text(encoding='utf-8')).items():
            table[artist.strip().lower()] = {'license': info['license'], 'source': info['source'], 'artist': info.get('artist', artist),
                                             'url': info.get('url'), 'credit': info['credit'], 'custom': True}
    return table


def load_decisions(library):
    path = library / 'decisions.json'
    if path.exists():
        return json.loads(path.read_text(encoding='utf-8')).get('tracks', {})
    return {}


def build(library):
    library, hashed, cache = scan_music.scan(library)
    decisions = load_decisions(library)
    licenses = load_licenses(library)
    groups = defaultdict(list)
    for path, digest in hashed:
        groups[digest].append(path)
    tracks = []
    for path, digest in hashed:
        entry = cache[digest]
        if 'error' in entry:
            tracks.append({'id': path.relative_to(library).as_posix(), 'file': path.relative_to(library).as_posix(), 'folder': path.parent.name, 'mood': path.parent.name,
                           'status': 'excluded', 'reasons': ['Could not be read: ' + entry['error']], 'eligible': False, 'fit': False, 'sha256': digest})
            continue
        rel = path.relative_to(library).as_posix()
        tags = entry['probe']['tags']
        artist = (tags.get('artist') or tags.get('album_artist') or '').strip()
        lic = licenses.get(artist.lower())
        title = _title(path, tags)
        same = sorted(groups[digest], key=lambda p: (len(p.stem), p.as_posix()))
        folders = {p.parent.name for p in same}
        track = {
            'id': rel, 'file': rel, 'title': title, 'folder': path.parent.name, 'mood': path.parent.name,
            'duration': entry['probe']['duration'], 'sha256': digest,
            'artist': lic['artist'] if lic else (artist or None),
            'license': lic['license'] if lic else None, 'source': lic['source'] if lic else None,
            'license_url': lic['url'] if lic else None,
            'credit': lic['credit'].format(title=title) if lic else None,
            'license_evidence': (f'embedded artist tag "{artist}" matched an entry in licenses.json (you supplied those terms)' if lic and lic['custom']
                                 else f"embedded artist tag \"{artist}\" (licence terms read from {lic['source']}'s own FAQ)" if lic
                                 else f'no known licence for the artist tag "{artist}"' if artist else 'none: the file has no artist tag'),
            'features': entry['features'], 'reasons': [], 'fit': len(folders) == 1 and same[0] == path,
        }
        if len(same) > 1:
            if len(folders) > 1:
                track['conflict'] = [p.relative_to(library).as_posix() for p in same]
            elif same[0] != path:
                track['duplicate_of'] = same[0].relative_to(library).as_posix()
        tracks.append(track)
    ok_tracks = [t for t in tracks if 'features' in t]
    judge([t for t in ok_tracks])
    for t in ok_tracks:
        d = decisions.get(t['id'], {})
        t['decision'] = d or None
        status, reasons = 'ok', []
        if not t['license']:
            status, reasons = 'excluded', ['Source and licence could not be confirmed. Re-download it from its source, record its terms in music-library/licenses.json, or remove it.']
        if t.get('duplicate_of'):
            status, reasons = 'excluded', [f"Byte-identical copy of {t['duplicate_of']}."]
        if 'mood' in d and d['mood'] in MOODS:
            t['mood'] = d['mood']
        if d.get('exclude'):
            status, reasons = 'excluded', ['Removed by your decision.' + (f" {d['note']}" if d.get('note') else '')]
        elif status == 'ok' and t.get('conflict'):
            chosen = [p for p in t['conflict'] if decisions.get(p, {}).get('approve') or decisions.get(p, {}).get('mood')]
            if chosen and t['id'] not in chosen:
                status, reasons = 'excluded', [f'The same file is in more than one mood folder; you chose {chosen[0]}.']
            elif not chosen:
                status, reasons = 'conflict', ['The exact same file is in more than one mood folder (' + ', '.join(t['conflict']) + '). Decide which mood it is.']
        if status == 'ok' and t['checks']['both_name_other_mood'] and not (d.get('approve') or 'mood' in d):
            status = 'review'
            reasons = [f"Two independent checks both say this sounds more like {t['checks']['centroid_mood']} than {t['folder']}. Listen and decide."]
        t['status'], t['reasons'] = status, reasons
        t['eligible'] = status == 'ok'
        t['listened'] = bool(d.get('approve') or 'mood' in d)
    for t in tracks:
        t.pop('fit', None)
    tracks.sort(key=lambda t: (t['mood'], t['title'] if 'title' in t else t['id']))
    return library, tracks


def write_manifest(library, tracks):
    counts = {m: sum(1 for t in tracks if t['eligible'] and t['mood'] == m) for m in MOODS}
    manifest = {'version': 1, 'generated': date.today().isoformat(), 'target_lufs': TARGET_LUFS, 'moods': list(MOODS),
                'eligible_per_mood': counts,
                'status_counts': {s: sum(1 for t in tracks if t['status'] == s) for s in ('ok', 'review', 'conflict', 'excluded')},
                'note': 'Only tracks with eligible=true are ever played. "ok" means no contradiction was measured, not that anyone listened. '
                        'listened=true means you approved or relabelled it.',
                'tracks': tracks}
    (library / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding='utf-8')
    return manifest


def write_credits(library, tracks):
    used = [t for t in tracks if t['status'] != 'excluded' and t['credit']]
    lines = ['# Music credits', '',
             'These credit lines are **required** by the licence (CC BY 4.0) wherever the music is used, and must be easy to find. '
             'Every soundtrack the system exports also carries its track\'s credit in the file\'s metadata.', '',
             f'{EDITED} That statement must accompany the credits, because CC BY asks you to say what you changed.', '',
             'Licence: https://creativecommons.org/licenses/by/4.0/', '']
    for mood in MOODS:
        rows = [t for t in used if t['mood'] == mood]
        lines += [f'## {DISPLAY.get(mood, mood.capitalize())} ({len(rows)})', '']
        lines += [f"- {t['credit']}" for t in rows]
        lines.append('')
    lines += ['## Source', '', 'Kevin MacLeod, incompetech.com. Terms as stated on https://incompetech.com/music/royalty-free/faq.html '
              f'(read {date.today().isoformat()}); re-check them before launch.', '']
    (library / 'CREDITS.md').write_text('\n'.join(lines), encoding='utf-8')


def _why(t, means):
    f = t['features']
    m = means[t['folder']]
    parts = []
    if f['lufs'] > m['lufs'] + 3:
        parts.append(f"louder than most {t['folder']} tracks ({f['lufs']:.0f} vs {m['lufs']:.0f} LUFS)")
    elif f['lufs'] < m['lufs'] - 3:
        parts.append(f"quieter than most {t['folder']} tracks ({f['lufs']:.0f} vs {m['lufs']:.0f} LUFS)")
    if f['centroid_hz'] > m['centroid_hz'] * 1.35:
        parts.append(f"brighter ({f['centroid_hz'] / 1000:.1f} kHz vs {m['centroid_hz'] / 1000:.1f})")
    elif f['centroid_hz'] < m['centroid_hz'] * .7:
        parts.append(f"darker ({f['centroid_hz'] / 1000:.1f} kHz vs {m['centroid_hz'] / 1000:.1f})")
    if f['onset_rate'] > m['onset_rate'] * 1.4:
        parts.append(f"busier ({f['onset_rate']:.1f} vs {m['onset_rate']:.1f} notes/s)")
    elif f['onset_rate'] < m['onset_rate'] * .6:
        parts.append(f"sparser ({f['onset_rate']:.1f} vs {m['onset_rate']:.1f} notes/s)")
    return '; '.join(parts) or 'measurements are close to the folder averages'


def write_review(library, tracks, seed=7):
    means = {}
    for m in MOODS:
        sub = [t['features'] for t in tracks if t['folder'] == m and 'features' in t and t['status'] != 'excluded']
        means[m] = {k: float(np.mean([f[k] for f in sub])) for k in ('lufs', 'centroid_hz', 'onset_rate')}
    cards, seen_conflict = [], set()
    for t in tracks:
        if t['status'] in ('review', 'conflict'):
            if t['status'] == 'conflict':
                key = tuple(t['conflict'])
                if key in seen_conflict:
                    continue
                seen_conflict.add(key)
            cards.append(t)
    rng = np.random.default_rng(seed)
    passed = [t for t in tracks if t['status'] == 'ok' and not t.get('decision')]
    spot = []
    for m in MOODS:
        pool = [t for t in passed if t['mood'] == m]
        for i in rng.choice(len(pool), size=min(3, len(pool)), replace=False) if pool else []:
            spot.append(pool[int(i)])
    def card(t, kind):
        rel = quote(t['file'])
        group = t.get('conflict') or [t['id']]
        why = t['reasons'][0] if t['status'] == 'conflict' else _why(t, means)
        looks = t['checks']['centroid_mood'] if t['checks']['both_name_other_mood'] else None
        buttons = ''.join(f'<button data-mood="{m}">{DISPLAY.get(m, m.capitalize())}</button>' for m in MOODS)
        note = f'<div class="looks">Automatic check says it sounds more like <b>{looks}</b>.</div>' if looks else ''
        return (f'<article class="card" data-group="{html.escape(json.dumps(group))}" data-folder="{t["folder"]}" data-kind="{kind}">'
                f'<h3>{html.escape(t["title"])} <span class="tag">in {t["folder"]}</span></h3>{note}'
                f'<div class="facts">{html.escape(why)}. Length {int(t["duration"])} s.</div>'
                f'<audio controls preload="none" src="{rel}#t=0,30"></audio>'
                f'<div class="choices"><span>This is:</span>{buttons}<button data-mood="__remove" class="rm">Remove it</button></div></article>')
    body = ''.join(card(t, 'flag') for t in cards) or '<p class="none">Nothing was flagged.</p>'
    spot_html = ''.join(card(t, 'spot') for t in spot)
    existing = json.dumps(load_decisions(library))
    page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Music library review</title><style>
body{{font:16px/1.5 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:24px 16px 120px;background:#0f0e13;color:#e6e2ec}}
h1{{font-size:26px;margin:0 0 8px}}h2{{margin:34px 0 4px;font-size:19px}}p{{color:#b9b3c4;margin:6px 0}}
.card{{background:#1a1822;border:1px solid #302c3a;border-radius:12px;padding:14px 16px;margin:12px 0}}
.card h3{{margin:0;font-size:17px}}.tag{{font-size:12px;font-weight:400;color:#9c95aa;border:1px solid #403a4d;border-radius:99px;padding:1px 8px;margin-left:6px}}
.facts,.looks{{font-size:14px;color:#b9b3c4;margin:6px 0}}.looks{{color:#f2c46a}}audio{{width:100%;margin:8px 0}}
.choices{{display:flex;flex-wrap:wrap;gap:6px;align-items:center}}.choices span{{font-size:14px;color:#9c95aa;margin-right:2px}}
button{{font:inherit;font-size:14px;padding:6px 12px;border-radius:8px;border:1px solid #4a4458;background:#231f2c;color:#e6e2ec;cursor:pointer}}
button.on{{background:#ffd166;color:#1a1500;border-color:#ffd166}}button.rm.on{{background:#e0606f;border-color:#e0606f;color:#fff}}
#bar{{position:fixed;left:0;right:0;bottom:0;background:#181620;border-top:1px solid #302c3a;padding:12px 16px;display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap}}
#bar b{{color:#ffd166}}textarea{{position:absolute;left:-9999px}}</style></head><body>
<h1>Music library review</h1>
<p>Play the first 30 seconds (that is the part a video would hear), then click what the track really sounds like. Nothing is saved until you press <b>Copy decisions</b> or <b>Download</b> below.</p>
<h2>1. Check these ({len(cards)})</h2>
<p>Flagged because two independent measurements both say the track sounds like a different mood than its folder, or because the same file sits in two folders.</p>{body}
<h2>2. Optional: spot-check a few that passed ({len(spot)})</h2>
<p>Three random tracks per mood that raised no flag. If most of these sound right, the rest are probably fine; the measurements can only catch the obvious mismatches.</p>{spot_html}
<div id="bar"><span><b id="n">0</b> decided</span><button id="copy">Copy decisions</button><button id="dl">Download decisions.json</button><span id="msg"></span></div>
<textarea id="ta"></textarea>
<script>
const existing={existing};const state=JSON.parse(localStorage.getItem('music-review')||'{{}}');
function decisions(){{const out={{...existing}};document.querySelectorAll('.card').forEach(c=>{{
  const pick=state[c.dataset.group];if(!pick)return;const group=JSON.parse(c.dataset.group);
  if(pick==='__remove'){{group.forEach(p=>out[p]={{exclude:true,note:'removed in review'}});return;}}
  const home=group.find(p=>p.split('/')[0]===pick);
  if(home){{group.forEach(p=>out[p]=p===home?{{approve:true}}:{{exclude:true,note:'duplicate of the copy you kept'}});}}
  else{{group.forEach((p,i)=>out[p]=i===0?{{mood:pick}}:{{exclude:true,note:'duplicate of the copy you relabelled'}});}}
}});return {{version:1,tracks:out}};}}
function refresh(){{let n=0;document.querySelectorAll('.card').forEach(c=>{{const pick=state[c.dataset.group];if(pick)n++;
  c.querySelectorAll('.choices button').forEach(b=>b.classList.toggle('on',b.dataset.mood===pick));}});document.getElementById('n').textContent=n;}}
document.querySelectorAll('.card').forEach(c=>c.querySelectorAll('.choices button').forEach(b=>b.onclick=()=>{{
  state[c.dataset.group]=b.dataset.mood;localStorage.setItem('music-review',JSON.stringify(state));refresh();}}));
const text=()=>JSON.stringify(decisions(),null,2);
document.getElementById('copy').onclick=async()=>{{const t=text();try{{await navigator.clipboard.writeText(t);}}catch(e){{const a=document.getElementById('ta');a.value=t;a.select();document.execCommand('copy');}}
  document.getElementById('msg').textContent='Copied. Paste it into the chat, or into music-library/decisions.json.';}};
document.getElementById('dl').onclick=()=>{{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text()],{{type:'application/json'}}));a.download='decisions.json';a.click();
  document.getElementById('msg').textContent='Saved. Put it in the music-library folder.';}};
refresh();</script></body></html>'''
    (library / 'review.html').write_text(page, encoding='utf-8')
    return len(cards), len(spot)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--library', default='music-library')
    a = p.parse_args()
    library, tracks = build(a.library)
    manifest = write_manifest(library, tracks)
    write_credits(library, tracks)
    flagged, spot = write_review(library, tracks)
    print(f"Tracks: {len(tracks)}   status: {manifest['status_counts']}")
    print('Eligible per mood:', manifest['eligible_per_mood'])
    print(f'Review page: {library / "review.html"} ({flagged} to check, {spot} optional spot-checks)')
    for t in tracks:
        if t['status'] in ('excluded', 'conflict'):
            print(f"  {t['status']:9} {t['id']}: {t['reasons'][0][:110]}")


if __name__ == '__main__':
    main()
